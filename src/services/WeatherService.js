// src/services/WeatherService.js
// GPS-based weather via Open-Meteo (no API key).
// When online: fetches full data, broadcasts compact summary over BLE mesh.
// When offline: shows last cached data or data received from a nearby mesh gateway.

import AsyncStorage from '@react-native-async-storage/async-storage';
import Geolocation from 'react-native-geolocation-service';

const CACHE_KEY        = '@peerreach_weather_v2';
const REFRESH_INTERVAL = 20 * 60 * 1000;  // fetch every 20 min
const MAX_AGE_MS       = 3  * 60 * 60 * 1000; // treat cache stale after 3h

// WMO weather interpretation codes → MaterialCommunityIcons icon + color + description
const WMO_MAP = {
  0:  { icon: 'weather-sunny',            color: '#FFB300', desc: 'Clear sky' },
  1:  { icon: 'weather-partly-cloudy',    color: '#78909C', desc: 'Mostly clear' },
  2:  { icon: 'weather-partly-cloudy',    color: '#78909C', desc: 'Partly cloudy' },
  3:  { icon: 'weather-cloudy',           color: '#546E7A', desc: 'Overcast' },
  45: { icon: 'weather-fog',              color: '#90A4AE', desc: 'Foggy' },
  48: { icon: 'weather-fog',              color: '#90A4AE', desc: 'Icy fog' },
  51: { icon: 'weather-rainy',            color: '#42A5F5', desc: 'Light drizzle' },
  53: { icon: 'weather-rainy',            color: '#1E88E5', desc: 'Drizzle' },
  55: { icon: 'weather-pouring',          color: '#1565C0', desc: 'Heavy drizzle' },
  61: { icon: 'weather-rainy',            color: '#42A5F5', desc: 'Light rain' },
  63: { icon: 'weather-rainy',            color: '#1E88E5', desc: 'Rain' },
  65: { icon: 'weather-pouring',          color: '#1565C0', desc: 'Heavy rain' },
  71: { icon: 'weather-snowy',            color: '#81D4FA', desc: 'Light snow' },
  73: { icon: 'weather-snowy',            color: '#4FC3F7', desc: 'Snow' },
  75: { icon: 'weather-snowy-heavy',      color: '#0288D1', desc: 'Heavy snow' },
  77: { icon: 'weather-snowy',            color: '#81D4FA', desc: 'Snow grains' },
  80: { icon: 'weather-rainy',            color: '#42A5F5', desc: 'Rain showers' },
  81: { icon: 'weather-pouring',          color: '#1E88E5', desc: 'Rain showers' },
  82: { icon: 'weather-pouring',          color: '#1565C0', desc: 'Violent showers' },
  85: { icon: 'weather-snowy',            color: '#4FC3F7', desc: 'Snow showers' },
  86: { icon: 'weather-snowy-heavy',      color: '#0288D1', desc: 'Heavy snow showers' },
  95: { icon: 'weather-lightning',        color: '#F57F17', desc: 'Thunderstorm' },
  96: { icon: 'weather-hail',             color: '#EF6C00', desc: 'Thunderstorm + hail' },
  99: { icon: 'weather-hail',             color: '#E65100', desc: 'Thunderstorm + hail' },
};

export function wmoInfo(code) {
  if (code == null) return { icon: 'thermometer', color: '#9E9E9E', desc: 'Unknown' };
  return WMO_MAP[code] ?? WMO_MAP[Math.floor(code / 10) * 10] ?? { icon: 'thermometer', color: '#9E9E9E', desc: 'Unknown' };
}

class WeatherService {
  constructor() {
    this.bridgefyService  = null;
    this.myDeviceId       = null;
    this.data             = null;   // full structured weather data
    this.source           = null;   // 'gps' | 'mesh' | 'cache'
    this.onWeatherUpdated = null;   // callback → (data, source)
    this._timer           = null;
    this._loadCache();
  }

  init(bridgefyService) {
    this.bridgefyService = bridgefyService;
  }

  setMyDeviceId(id) { this.myDeviceId = id; }
  setOnWeatherUpdated(cb) { this.onWeatherUpdated = cb; }

  startAutoRefresh() {
    this._fetchAndBroadcast();
    this._timer = setInterval(() => this._fetchAndBroadcast(), REFRESH_INTERVAL);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  // ── Returns cached data with staleness flag — never hides data once loaded ──
  getData() {
    if (!this.data) return null;
    return {
      ...this.data,
      isStale: Date.now() - this.data.timestamp > MAX_AGE_MS,
    };
  }

  // ── Returns { temp, code, city, isStale } for header widget ─────────────────
  getHeaderInfo() {
    const d = this.getData();
    if (!d) return null;
    return { temp: d.current.temp, code: d.current.code, city: d.city, isStale: d.isStale };
  }

  // ── Called by BridgefyService when a weather_update packet arrives ──────────
  handleWeatherUpdate(parsed, senderId) {
    if (senderId === this.myDeviceId) return;
    const w = parsed.w;
    if (!w || !w.ts) return;
    // Only update if newer than what we have
    if (this.data && w.ts <= this.data.timestamp) return;
    this._setData(w, 'mesh');
  }

  // ── Internal: fetch full data, store, broadcast compact summary ─────────────
  async _fetchAndBroadcast() {
    try {
      const coords = await this._getCoords();
      if (!coords) return; // no GPS — can't fetch accurate local weather

      const result = await this._fetchOpenMeteo(coords.lat, coords.lng);
      if (!result) return;

      this._setData(result, 'gps');
      this._broadcast(result);
    } catch (_e) { /* silent — weather is non-critical */ }
  }

  async _fetchOpenMeteo(lat, lng) {
    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
      `&current_weather=true` +
      `&hourly=temperature_2m,apparent_temperature,relativehumidity_2m,precipitation_probability,weathercode` +
      `&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
      `&timezone=auto&forecast_days=3&wind_speed_unit=kmh`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'PeerReach/1.0' },
      });
      if (!res.ok) return null;
      const json = await res.json();

      // Get city name in parallel (non-blocking)
      const city = await this._reverseGeocode(lat, lng);

      // Find the current hour index in the hourly arrays
      const nowISO  = new Date().toISOString().substring(0, 13); // "2026-03-17T14"
      const times   = json.hourly?.time || [];
      const startIdx = Math.max(0, times.findIndex(t => t >= nowISO));

      // 6 hourly entries from now
      const hourly = [];
      for (let i = startIdx; i < Math.min(startIdx + 6, times.length); i++) {
        hourly.push({
          time:         times[i].substring(11, 16),  // "14:00"
          temp:         Math.round(json.hourly.temperature_2m[i]),
          code:         json.hourly.weathercode[i],
          precipChance: json.hourly.precipitation_probability?.[i] ?? 0,
        });
      }

      // 3-day daily forecast
      const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const daily = (json.daily?.time || []).slice(0, 3).map((dateStr, i) => ({
        label:       i === 0 ? 'Today' : DAY_NAMES[new Date(dateStr).getDay()],
        high:        Math.round(json.daily.temperature_2m_max[i]),
        low:         Math.round(json.daily.temperature_2m_min[i]),
        code:        json.daily.weathercode[i],
        precipChance: json.daily.precipitation_probability_max?.[i] ?? 0,
      }));

      const cw = json.current_weather;
      return {
        city:      city || `${lat.toFixed(2)}, ${lng.toFixed(2)}`,
        lat, lng,
        current: {
          temp:      Math.round(cw.temperature),
          feelsLike: json.hourly?.apparent_temperature?.[startIdx] != null
            ? Math.round(json.hourly.apparent_temperature[startIdx])
            : null,
          humidity:  json.hourly?.relativehumidity_2m?.[startIdx] ?? null,
          windSpeed: Math.round(cw.windspeed),
          code:      cw.weathercode,
        },
        hourly,
        daily,
        timestamp: Date.now(),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async _reverseGeocode(lat, lng) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`,
          {
            signal: controller.signal,
            headers: { 'User-Agent': 'PeerReach/1.0' },
          }
        );
        const json = await res.json();
        return (
          json.address?.city     ||
          json.address?.town     ||
          json.address?.village  ||
          json.address?.county   ||
          null
        );
      } finally {
        clearTimeout(timeout);
      }
    } catch (_e) {
      return null;
    }
  }

  _broadcast(data) {
    if (!this.bridgefyService) return;
    // Send compact version — full data is stored locally, only essentials go over mesh
    const compact = {
      type: 'weather_update',
      w: {
        city:      data.city,
        lat:       data.lat,
        lng:       data.lng,
        current:   data.current,
        hourly:    data.hourly,
        daily:     data.daily,
        ts:        data.timestamp,
      },
      source: this.myDeviceId,
    };
    this.bridgefyService
      .sendBroadcast(JSON.stringify(compact))
      .catch(() => {});
  }

  _setData(data, source) {
    // Normalise mesh packet (uses ts field) to local format (uses timestamp)
    const normalised = data.ts ? { ...data, timestamp: data.ts } : data;
    this.data   = normalised;
    this.source = source;
    this._saveCache();
    if (this.onWeatherUpdated) this.onWeatherUpdated(normalised, source);
  }

  _getCoords() {
    return new Promise((resolve) => {
      try {
        Geolocation.getCurrentPosition(
          (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
          ()    => resolve(null),
          { enableHighAccuracy: false, timeout: 6000, maximumAge: 5 * 60 * 1000 }
        );
      } catch (_e) {
        resolve(null);
      }
    });
  }

  async _loadCache() {
    try {
      const raw = await AsyncStorage.getItem(CACHE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Date.now() - parsed.timestamp < MAX_AGE_MS) {
        this.data   = parsed;
        this.source = 'cache';
      }
    } catch (_e) {}
  }

  async _saveCache() {
    try {
      if (this.data) await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(this.data));
    } catch (_e) {}
  }
}

export default new WeatherService();
