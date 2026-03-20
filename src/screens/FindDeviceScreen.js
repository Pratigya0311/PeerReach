import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  PermissionsAndroid,
  Platform,
  Vibration,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Geolocation from 'react-native-geolocation-service';
import Icon from 'react-native-vector-icons/MaterialIcons';
import BridgefyService from '../services/BridgefyService';
import { useTheme } from '../theme';

// ── Haversine distance (meters) ────────────────────────────────────────────
function getDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Bearing in degrees from North (0–360) ──────────────────────────────────
function getBearing(lat1, lng1, lat2, lng2) {
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function getCardinal(bearing) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(bearing / 45) % 8];
}

function formatDistance(m) {
  if (m < 10) return '< 10 m';
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(2)} km`;
}

const FindDeviceScreen = ({ route, navigation }) => {
  const {
    targetDeviceId,
    targetDeviceName,
    targetLat: initTargetLat,
    targetLng: initTargetLng,
    requestId,
    wasBroadcast = false,
  } = route.params || {};

  const colors = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [myPos, setMyPos]         = useState(null); // { lat, lng }
  const [targetPos, setTargetPos] = useState(
    initTargetLat != null ? { lat: initTargetLat, lng: initTargetLng } : null
  );
  const [hasSharedBack, setHasSharedBack] = useState(false);
  const [isSending, setIsSending]         = useState(false);

  const watchIdRef   = useRef(null);
  const isMountedRef = useRef(true);

  // ── Computed bearing / distance ───────────────────────────────────────────
  const computed = useMemo(() => {
    if (!myPos || !targetPos) return null;
    const dist    = getDistance(myPos.lat, myPos.lng, targetPos.lat, targetPos.lng);
    const bearing = getBearing(myPos.lat, myPos.lng, targetPos.lat, targetPos.lng);
    return { dist, bearing, cardinal: getCardinal(bearing) };
  }, [myPos, targetPos]);

  // ── Listen for find_me_response packets from target ───────────────────────
  useEffect(() => {
    BridgefyService.setOnFindMeUpdateHandler((update) => {
      if (!isMountedRef.current) return;
      if (
        update.type === 'find_me_response' &&
        update.senderId === targetDeviceId &&
        update.mediaData?.requestId === requestId
      ) {
        setTargetPos({ lat: update.mediaData.lat, lng: update.mediaData.lng });
        Vibration.vibrate(120);
      }
    });
    return () => BridgefyService.setOnFindMeUpdateHandler(null);
  }, [targetDeviceId, requestId]);

  // ── Request location permission and start watching ────────────────────────
  useEffect(() => {
    isMountedRef.current = true;

    const startWatch = () => {
      watchIdRef.current = Geolocation.watchPosition(
        (pos) => {
          if (isMountedRef.current)
            setMyPos({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        },
        (err) => console.warn('FindDevice GPS error:', err.message),
        { enableHighAccuracy: true, distanceFilter: 5, interval: 4000, fastestInterval: 2000 }
      );
    };

    const requestAndStart = async () => {
      if (Platform.OS === 'android') {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
        );
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
          Alert.alert('Permission denied', 'Location is needed to calculate direction.');
          return;
        }
      }
      startWatch();
    };

    requestAndStart();
    return () => {
      isMountedRef.current = false;
      if (watchIdRef.current != null) Geolocation.clearWatch(watchIdRef.current);
    };
  }, []);

  // ── Share my location back ────────────────────────────────────────────────
  const shareLocationBack = useCallback(async () => {
    if (!myPos || isSending) return;
    setIsSending(true);
    try {
      await BridgefyService.sendFindMeResponse(targetDeviceId, requestId, myPos.lat, myPos.lng, wasBroadcast);
      setHasSharedBack(true);
      Alert.alert('Shared', `Your location was sent to ${targetDeviceName}.`);
    } catch (err) {
      Alert.alert('Error', err.message || 'Could not share location.');
    } finally {
      setIsSending(false);
    }
  }, [myPos, isSending, targetDeviceId, requestId, targetDeviceName]);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Icon name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <View style={styles.headerText}>
          <Text style={styles.headerTitle}>Finding {targetDeviceName}</Text>
          <Text style={styles.headerSub}>
            {myPos ? 'GPS active' : 'Acquiring GPS...'}
          </Text>
        </View>
      </View>

      {/* Compass / Direction display */}
      <View style={styles.compassArea}>
        {!myPos ? (
          <View style={styles.centerCol}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={styles.waitText}>Waiting for your GPS...</Text>
          </View>
        ) : !targetPos ? (
          <View style={styles.centerCol}>
            <Icon name="location-searching" size={72} color={colors.primary} />
            <Text style={styles.waitText}>Waiting for {targetDeviceName}'s location...</Text>
            <Text style={styles.subText}>They'll appear here once they share.</Text>
          </View>
        ) : (
          <View style={styles.centerCol}>
            {/* Rotating arrow */}
            <View style={styles.arrowRing}>
              <View style={[styles.arrowIcon, { transform: [{ rotate: `${computed.bearing}deg` }] }]}>
                <Icon name="navigation" size={64} color={colors.primary} />
              </View>
            </View>

            {/* Distance */}
            <Text style={styles.distanceText}>{formatDistance(computed.dist)}</Text>
            <Text style={styles.directionText}>
              {computed.cardinal}  ·  {Math.round(computed.bearing)}°
            </Text>

            {/* Close-range indicator */}
            {computed.dist < 30 && (
              <View style={styles.closeBadge}>
                <Icon name="near-me" size={16} color="#fff" />
                <Text style={styles.closeText}>You're very close!</Text>
              </View>
            )}

            <Text style={styles.hintText}>
              Arrow points North when bearing = 0°.{'\n'}Rotate your phone or use a compass to align.
            </Text>

            {/* Target position info */}
            {targetPos && (
              <Text style={styles.coordsText}>
                {targetDeviceName}: {targetPos.lat.toFixed(5)}, {targetPos.lng.toFixed(5)}
              </Text>
            )}
          </View>
        )}
      </View>

      {/* Share my location back button */}
      <View style={styles.footer}>
        {!hasSharedBack ? (
          <TouchableOpacity
            style={[styles.shareBtn, (!myPos || isSending) && styles.shareBtnDisabled]}
            onPress={shareLocationBack}
            disabled={!myPos || isSending}
          >
            {isSending
              ? <ActivityIndicator size="small" color="#fff" />
              : <Icon name="share-location" size={20} color="#fff" style={{ marginRight: 8 }} />
            }
            <Text style={styles.shareBtnText}>
              {isSending ? 'Sharing...' : `Share my location with ${targetDeviceName}`}
            </Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.sharedConfirm}>
            <Icon name="check-circle" size={20} color={colors.success} />
            <Text style={styles.sharedConfirmText}>Location shared — they can now find you too</Text>
          </View>
        )}
      </View>
    </SafeAreaView>
  );
};

const makeStyles = (colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },

  header: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.primary, padding: 16, paddingTop: 12,
  },
  backBtn:    { marginRight: 12, padding: 4 },
  headerText: { flex: 1 },
  headerTitle: { fontSize: 18, fontWeight: '700', color: '#fff' },
  headerSub:   { fontSize: 12, color: 'rgba(255,255,255,0.75)', marginTop: 2 },

  compassArea: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },

  centerCol: {
    alignItems: 'center',
    width: '100%',
  },

  arrowRing: {
    width: 160, height: 160, borderRadius: 80,
    borderWidth: 2, borderColor: colors.border,
    justifyContent: 'center', alignItems: 'center',
    marginBottom: 24,
    backgroundColor: colors.surface,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15, shadowRadius: 8, elevation: 6,
  },
  arrowIcon: { /* rotation applied via transform prop */ },

  distanceText: {
    fontSize: 48, fontWeight: '800', color: colors.text, letterSpacing: -1,
    marginBottom: 8,
  },
  directionText: {
    fontSize: 22, fontWeight: '600', color: colors.primary, marginBottom: 16,
  },

  closeBadge: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.success,
    borderRadius: 20, paddingHorizontal: 16, paddingVertical: 8,
    marginBottom: 16,
  },
  closeText: { color: '#fff', fontWeight: '700', marginLeft: 6, fontSize: 14 },

  hintText: {
    fontSize: 12, color: colors.textMuted, textAlign: 'center', lineHeight: 18,
    marginTop: 8,
  },
  coordsText: {
    fontSize: 11, color: colors.textMuted, marginTop: 12, textAlign: 'center',
  },

  waitText: { fontSize: 16, color: colors.textSecondary, marginTop: 16, textAlign: 'center' },
  subText:  { fontSize: 13, color: colors.textMuted, marginTop: 8, textAlign: 'center' },

  footer: {
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },

  shareBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.primary,
    borderRadius: 12, paddingVertical: 14, paddingHorizontal: 20,
  },
  shareBtnDisabled: { backgroundColor: colors.border },
  shareBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },

  sharedConfirm: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 14,
  },
  sharedConfirmText: { color: colors.success, fontWeight: '600', marginLeft: 8, fontSize: 14 },
});

export default FindDeviceScreen;
