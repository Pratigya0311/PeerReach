// src/services/GatewayService.js
// Crowdsourced Opportunistic Internet Gateway over BLE Mesh
import databaseService from './DatabaseService';

// Android's own connectivity check endpoint — always returns exactly 204, never redirects to captive portal pages
const CONNECTIVITY_URLS = [
  'https://connectivitycheck.gstatic.com/generate_204',
  'https://www.google.com/generate_204',
  'https://clients3.google.com/generate_204',
];
const DEFAULT_TTL = 5;
const STOP_WORDS = new Set([
  'a','an','the','is','are','was','were','be','been','being',
  'have','has','had','do','does','did','will','would','could','should','may','might',
  'what','whats','who','where','when','why','how','which',
  'in','on','at','to','for','of','and','or','but','with','from',
  'me','my','i','you','your','it','its','this','that',
]);
const MAX_CACHE_AGE_MS = 30 * 60 * 1000; // 30 minutes
const SEEN_MESSAGES_MAX = 200;
const REQUEST_TIMEOUT_MS = 30 * 1000;  // 30s before store-and-forward
const RETRY_INTERVAL_MS = 30 * 1000;   // retry queued requests every 30s

class GatewayService {
  constructor() {
    this.seenMessages = new Map();     // id → timestamp (dedup)
    this.pendingRequests = new Map();  // requestId → { resolve, reject, query, timer }
    this.pendingQueue = [];            // store-and-forward: requests waiting for internet
    this.myDeviceId = null;
    this.bridgefyService = null;       // injected via init()
    this.onQueryResultCallback = null; // called when a response arrives
    this.retryTimer = null;

    this._startRetryTimer();
  }

  // Called once BridgefyService is ready
  init(bridgefyService) {
    this.bridgefyService = bridgefyService;
  }

  setMyDeviceId(id) {
    this.myDeviceId = id;
  }

  // UI screens register here to receive async responses
  setOnQueryResultCallback(cb) {
    this.onQueryResultCallback = cb;
  }

  // ── Internet connectivity check ─────────────────────────────────────────────

  async checkInternet() {
    // Try each URL in order — first 204 response wins.
    // Strictly checking status === 204 prevents captive portal login pages (which return 200) from
    // being mistaken for real internet connectivity.
    for (const url of CONNECTIVITY_URLS) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);
        const res = await fetch(url, { method: 'HEAD', signal: controller.signal });
        clearTimeout(timeout);
        if (res.status === 204) return true;
      } catch (_e) {
        // This URL failed — try the next one
      }
    }
    return false;
  }

  // ── Query type detection ────────────────────────────────────────────────────

  _isWeatherQuery(query) {
    return /\b(weather|forecast|temperature|temp|rain|sunny|cloudy|humid|wind|climate|hot|cold)\b/i.test(query);
  }

  _extractLocation(query) {
    // Strip weather keywords to get the city/location
    return query
      .replace(/\b(weather|forecast|temperature|temp|rain|sunny|cloudy|humid|wind|climate|hot|cold|in|at|for|the|of|current|today|tomorrow)\b/gi, '')
      .replace(/[^\w\s]/g, '')
      .trim()
      .replace(/\s+/g, ' ') || 'auto';
  }

  // ── Query normalization for cache key ───────────────────────────────────────
  // Strips stop words and punctuation so "what is the capital of France" and
  // "capital france" both hit the same cache entry.

  _normalizeQuery(query) {
    return query
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 0 && !STOP_WORDS.has(w))
      .join(' ')
      .trim();
  }

  // ── Individual API fetchers ─────────────────────────────────────────────────

  async _fetchDuckDuckGo(query) {
    const url =
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      const json = await res.json();

      let result = null;
      if (json.Type !== 'D') {
        result = json.Answer || json.AbstractText || json.Definition || null;
      }
      if (!result && Array.isArray(json.RelatedTopics)) {
        const firstTopic = json.RelatedTopics.find(
          t => t && typeof t.Text === 'string' && t.Text.length > 10
        );
        if (firstTopic) result = firstTopic.Text;
      }
      if (!result) throw new Error('No DDG result');
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }

  async _fetchWikipedia(query) {
    // Wikipedia OpenSearch API — returns a short extract for the best matching article.
    // Using w/api.php with exsentences=3 keeps the response short and BLE-friendly.
    const searchUrl =
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&utf8=1&srlimit=1&origin=*`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const searchRes = await fetch(searchUrl, { signal: controller.signal });
      const searchJson = await searchRes.json();
      const hits = searchJson?.query?.search;
      if (!hits || hits.length === 0) throw new Error('No Wikipedia result');

      const title = hits[0].title;
      const extractUrl =
        `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exsentences=3&exintro=1&explaintext=1&titles=${encodeURIComponent(title)}&format=json&utf8=1&origin=*`;
      const extractRes = await fetch(extractUrl, { signal: controller.signal });
      clearTimeout(timeout);
      const extractJson = await extractRes.json();
      const pages = extractJson?.query?.pages;
      if (!pages) throw new Error('No Wikipedia extract');

      const page = Object.values(pages)[0];
      const extract = page?.extract?.trim();
      if (!extract || extract.length < 20) throw new Error('Wikipedia extract too short');
      return extract;
    } finally {
      clearTimeout(timeout);
    }
  }

  async _fetchWeather(location) {
    // wttr.in returns a single compact line e.g. "Bangalore: ⛅ +28°C"
    // format=3 is the shortest format — well within BLE payload limits.
    // No location (or 'auto') → omit the path segment so wttr.in uses IP-based detection.
    const weatherUrl =
      location && location !== 'auto'
        ? `https://wttr.in/${encodeURIComponent(location)}?format=3`
        : 'https://wttr.in/?format=3';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch(weatherUrl, { signal: controller.signal });
      if (!res.ok) throw new Error('wttr.in failed');
      const text = (await res.text()).trim();
      if (!text || text.includes('Unknown location')) throw new Error('Unknown location');
      return text;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ── Query execution ─────────────────────────────────────────────────────────

  async executeQuery(query) {
    const normalizedKey = this._normalizeQuery(query);

    // Cache-first (use normalized key)
    const cached = await this._getCached(normalizedKey);
    if (cached) {
      console.log('💾 Gateway cache hit:', query);
      return { result: cached, source: 'cache' };
    }

    let result = null;

    // Weather queries → wttr.in directly (faster and more accurate than DDG)
    if (this._isWeatherQuery(query)) {
      const location = this._extractLocation(query);
      try {
        result = await this._fetchWeather(location);
        console.log('🌤️ Weather answer:', result);
      } catch (_e) {
        // Fall through to general search below
      }
    }

    // General queries → race DuckDuckGo vs Wikipedia; first good answer wins
    if (!result) {
      try {
        result = await Promise.any([
          this._fetchDuckDuckGo(query),
          this._fetchWikipedia(query),
        ]);
        console.log('🔍 API answer obtained');
      } catch (_e) {
        // Promise.any throws AggregateError only when ALL promises reject
        result = `No instant answer found for "${query}". Try a different query.`;
      }
    }

    // Keep under ~800 chars to stay well within BLE payload limits
    if (result.length > 800) {
      result = result.substring(0, 797) + '...';
    }

    // Only cache and share real answers — don't persist the "no result" fallback string
    // so future requests still try the network instead of returning a cached error.
    const isFallback = result.startsWith('No instant answer found');
    if (!isFallback) {
      await this._saveCache(normalizedKey, result);
      // Share this answer with nearby mesh nodes so they can answer later without internet
      this._broadcastCacheShare(normalizedKey, result);
    }

    return { result, source: 'internet' };
  }

  // ── Public: send a query (called from MeshQueryScreen) ─────────────────────

  // onStatus(hasInternet: bool) — called once connectivity is known, before waiting for result.
  // This lets the screen update its loading label without doing a second checkInternet() call.
  async sendQuery(query, onStatus) {
    if (!this.bridgefyService) {
      throw new Error('Mesh not ready — please wait for Bridgefy to initialize');
    }

    const hasInternet = await this.checkInternet();
    if (onStatus) onStatus(hasInternet);

    if (hasInternet) {
      // I have internet — answer locally, no mesh needed
      const { result, source } = await this.executeQuery(query);
      return { result, source, hops: 0 };
    }

    // No internet — broadcast request through the mesh
    return new Promise((resolve, reject) => {
      const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        // Store for later (store-and-forward)
        this.pendingQueue.push({ requestId, query, timestamp: Date.now(), ttl: DEFAULT_TTL });
        reject(new Error('NO_GATEWAY_NEARBY'));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(requestId, { resolve, reject, query, timer });

      const packet = {
        type: 'internet_request',
        request_id: requestId,
        source: this.myDeviceId,
        query,
        ttl: DEFAULT_TTL,
        timestamp: Date.now(),
      };

      this.bridgefyService
        .sendBroadcast(JSON.stringify(packet))
        .catch(() => {
          clearTimeout(timer);
          this.pendingRequests.delete(requestId);
          reject(new Error('Failed to broadcast request over mesh'));
        });
    });
  }

  // ── Called by BridgefyService when a gateway-type message arrives ───────────

  async handleIncomingGatewayMessage(parsed, senderId) {
    if (parsed.type === 'internet_request') {
      await this._handleRequest(parsed);
    } else if (parsed.type === 'internet_response') {
      this._handleResponse(parsed);
    } else if (parsed.type === 'cache_share') {
      await this._handleCacheShare(parsed);
    }
  }

  // ── Internal: handle an internet_request packet ─────────────────────────────

  async _handleRequest(message) {
    const { request_id, source, query, ttl, timestamp } = message;

    // Dedup
    if (this._seen(request_id)) return;
    this._markSeen(request_id);

    // Ignore stale requests (older than 5 minutes)
    if (Date.now() - timestamp > 5 * 60 * 1000) return;

    // Don't relay my own broadcasts back to myself
    if (source === this.myDeviceId) return;

    // Answer from cache — no internet needed
    const normalizedKey = this._normalizeQuery(query);
    const cached = await this._getCached(normalizedKey);
    if (cached) {
      console.log('💾 Answering from cache for peer:', query);
      this._sendResponse(request_id, source, cached, ttl);
      return;
    }

    // I have internet — act as gateway
    const hasInternet = await this.checkInternet();
    if (hasInternet) {
      try {
        console.log('🌐 Acting as gateway for peer query:', query);
        const { result } = await this.executeQuery(query);
        this._sendResponse(request_id, source, result, ttl);
      } catch (e) {
        console.error('Gateway query failed:', e.message);
      }
      return;
    }

    // No internet and no cache — relay with TTL decrement (Spray-and-Wait)
    if (ttl > 1) {
      const relay = { ...message, ttl: ttl - 1 };
      this.bridgefyService.sendBroadcast(JSON.stringify(relay)).catch(() => {});
    }
  }

  // ── Internal: handle an internet_response packet ────────────────────────────

  _handleResponse(message) {
    const { request_id, destination, result } = message;

    // Ignore responses not addressed to this device
    if (destination !== this.myDeviceId) return;

    // Dedup responses
    if (this._seen(`resp_${request_id}`)) return;
    this._markSeen(`resp_${request_id}`);

    // Resolve waiting promise
    const pending = this.pendingRequests.get(request_id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingRequests.delete(request_id);
      pending.resolve({ result, source: 'mesh', hops: DEFAULT_TTL - (message.ttl_remaining || 0) });
    }

    // Notify screen via callback (handles the case where promise already timed out)
    if (this.onQueryResultCallback) {
      this.onQueryResultCallback({ request_id, result, query: message.query || '' });
    }
  }

  _sendResponse(requestId, destination, result, ttlRemaining = DEFAULT_TTL) {
    const packet = {
      type: 'internet_response',
      request_id: requestId,
      destination,
      result,
      gateway: this.myDeviceId,
      ttl_remaining: ttlRemaining,
      timestamp: Date.now(),
    };
    this.bridgefyService.sendBroadcast(JSON.stringify(packet)).catch(() => {});
  }

  // ── Mesh cache sharing ──────────────────────────────────────────────────────
  // When this device fetches a fresh answer from the internet it broadcasts
  // the result to all nearby nodes. Any node that hears the share stores it
  // locally so future requests can be answered without reaching out again.

  _broadcastCacheShare(normalizedQuery, result) {
    if (!this.bridgefyService) return;
    const packet = {
      type: 'cache_share',
      query: normalizedQuery,
      result,
      source: this.myDeviceId,
      timestamp: Date.now(),
    };
    this.bridgefyService.sendBroadcast(JSON.stringify(packet)).catch(() => {});
  }

  async _handleCacheShare(message) {
    const { query, result, source, timestamp } = message;

    // Ignore our own shares (we already saved them in executeQuery)
    if (source === this.myDeviceId) return;

    // Dedup
    const dedupKey = `share_${query}_${timestamp}`;
    if (this._seen(dedupKey)) return;
    this._markSeen(dedupKey);

    // Ignore stale shares (older than 30 minutes — same as cache TTL)
    if (Date.now() - timestamp > MAX_CACHE_AGE_MS) return;

    // Save to our own cache so we can answer future requests
    await this._saveCache(query, result);
    console.log('📡 Cached from mesh share:', query);
  }

  // ── Store-and-Forward retry loop ────────────────────────────────────────────

  _startRetryTimer() {
    this.retryTimer = setInterval(async () => {
      if (this.pendingQueue.length === 0) return;

      const hasInternet = await this.checkInternet();
      if (!hasInternet) return;

      const toProcess = [...this.pendingQueue];
      this.pendingQueue = [];

      for (const item of toProcess) {
        try {
          const { result } = await this.executeQuery(item.query);
          if (this.onQueryResultCallback) {
            this.onQueryResultCallback({
              request_id: item.requestId,
              result,
              query: item.query,
              delayed: true,
            });
          }
        } catch (_e) {
          // Still failing — put back
          this.pendingQueue.push(item);
        }
      }
    }, RETRY_INTERVAL_MS);
  }

  // ── Deduplication helpers ───────────────────────────────────────────────────

  _seen(id) {
    return this.seenMessages.has(id);
  }

  _markSeen(id) {
    this.seenMessages.set(id, Date.now());
    if (this.seenMessages.size > SEEN_MESSAGES_MAX) {
      const cutoff = Date.now() - 5 * 60 * 1000;
      for (const [k, ts] of this.seenMessages) {
        if (ts < cutoff) this.seenMessages.delete(k);
      }
    }
  }

  // ── Cache helpers (SQLite via DatabaseService) ──────────────────────────────

  async _getCached(query) {
    try {
      const rows = await databaseService.executeQuery(
        'SELECT result FROM gateway_cache WHERE query = ? AND timestamp > ?',
        [query.toLowerCase().trim(), Date.now() - MAX_CACHE_AGE_MS]
      );
      return rows.rows.length > 0 ? rows.rows.item(0).result : null;
    } catch (_e) {
      return null;
    }
  }

  async _saveCache(query, result) {
    try {
      await databaseService.executeQuery(
        'INSERT OR REPLACE INTO gateway_cache (query, result, timestamp) VALUES (?, ?, ?)',
        [query.toLowerCase().trim(), result, Date.now()]
      );
    } catch (_e) {
      // Non-critical — ignore
    }
  }

  // Called from MeshQueryScreen to show recent cache history
  async getCacheHistory() {
    try {
      const rows = await databaseService.executeQuery(
        'SELECT query, result, timestamp FROM gateway_cache ORDER BY timestamp DESC LIMIT 30',
        []
      );
      const items = [];
      for (let i = 0; i < rows.rows.length; i++) {
        items.push(rows.rows.item(i));
      }
      return items;
    } catch (_e) {
      return [];
    }
  }

  getPendingQueueCount() {
    return this.pendingQueue.length;
  }

  destroy() {
    if (this.retryTimer) clearInterval(this.retryTimer);
  }
}

export default new GatewayService();
