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
  Animated,
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

function formatAge(ts) {
  if (!ts) return '';
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins === 0) return 'Just now';
  if (mins === 1) return '1 min ago';
  return `${mins} min ago`;
}

const RESPONSE_TIMEOUT_MS = 30000; // 30s before showing re-request button
const RESHARE_COOLDOWN_MS = 15000; // 15s cooldown between re-shares

const FindDeviceScreen = ({ route, navigation }) => {
  const {
    targetDeviceId,
    targetDeviceName: rawTargetName,  // fix 11: guard undefined below
    targetLat: initTargetLat,
    targetLng: initTargetLng,
    requestId: initRequestId,
  } = route.params || {};

  // fix 11: fallback so `undefined` never reaches Text/string ops
  const targetDeviceName = rawTargetName || 'Unknown Device';

  const colors = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [myPos, setMyPos]             = useState(null);
  const [myHeading, setMyHeading]     = useState(-1);  // GPS travel heading; -1 = invalid/stationary
  const [targetPos, setTargetPos]     = useState(
    initTargetLat != null
      ? { lat: initTargetLat, lng: initTargetLng, ts: null }  // ts null until live update arrives
      : null
  );
  const [permDenied, setPermDenied]   = useState(false);   // fix 6
  const [timedOut, setTimedOut]       = useState(false);    // fix 5
  const [requestId, setRequestId]     = useState(initRequestId);
  const [shareOnCooldown, setShareOnCooldown] = useState(false);  // fix 7
  const [isSending, setIsSending]     = useState(false);
  const [shareCount, setShareCount]   = useState(0);       // fix 7 & 13

  // fix 10: smooth arrow rotation via Animated
  const arrowAnim       = useRef(new Animated.Value(0)).current;
  const lastBearingRef  = useRef(0);

  const watchIdRef  = useRef(null);
  const timeoutRef  = useRef(null);
  const cooldownRef = useRef(null);

  // ── Computed bearing / distance ───────────────────────────────────────────
  const computed = useMemo(() => {
    if (!myPos || !targetPos) return null;
    const dist     = getDistance(myPos.lat, myPos.lng, targetPos.lat, targetPos.lng);
    const bearing  = getBearing(myPos.lat, myPos.lng, targetPos.lat, targetPos.lng);
    // fix 1: if GPS heading is valid (phone moving), show bearing relative to travel direction
    const relative = myHeading >= 0 ? ((bearing - myHeading + 360) % 360) : bearing;
    return { dist, bearing, relative, cardinal: getCardinal(bearing), hasHeading: myHeading >= 0 };
  }, [myPos, targetPos, myHeading]);

  // fix 10: animate arrow on bearing change (shortest-path rotation, no jump through 0/360)
  useEffect(() => {
    if (!computed) return;
    const target  = computed.relative;
    const current = lastBearingRef.current;
    let delta = target - (current % 360);
    if (delta > 180)  delta -= 360;
    if (delta < -180) delta += 360;
    const next = current + delta;
    lastBearingRef.current = next;
    Animated.timing(arrowAnim, {
      toValue: next,
      duration: 300,
      useNativeDriver: true,
    }).start();
  }, [computed?.relative]);

  // ── Listen for find_me_response packets from target ───────────────────────
  useEffect(() => {
    BridgefyService.setOnFindMeUpdateHandler((update) => {
      if (
        update.type === 'find_me_response' &&
        update.senderId === targetDeviceId &&
        requestId != null &&  // guard: undefined===undefined would be a false match
        update.mediaData?.requestId === requestId
      ) {
        setTargetPos({ lat: update.mediaData.lat, lng: update.mediaData.lng, ts: Date.now() }); // fix 2: stamp ts
        setTimedOut(false);
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        // fix 12: urgent double-pulse vibration
        Vibration.vibrate([0, 150, 100, 150]);
      }
    });
    return () => BridgefyService.setOnFindMeUpdateHandler(null);
  }, [targetDeviceId, requestId]);

  // fix 5: start timeout when waiting for initial response
  useEffect(() => {
    if (targetPos) return;
    timeoutRef.current = setTimeout(() => setTimedOut(true), RESPONSE_TIMEOUT_MS);
    return () => { if (timeoutRef.current) clearTimeout(timeoutRef.current); };
  }, []); // only on mount — cleared if response arrives

  // ── GPS permission + watch ────────────────────────────────────────────────
  useEffect(() => {
    // fix 8: removed redundant isMountedRef.current = true (ref initialised to true at declaration)

    const startWatch = () => {
      watchIdRef.current = Geolocation.watchPosition(
        (pos) => {
          setMyPos({ lat: pos.coords.latitude, lng: pos.coords.longitude });
          setMyHeading(pos.coords.heading ?? -1); // fix 1: track GPS travel heading
        },
        (err) => console.warn('FindDevice GPS error:', err.message),
        { enableHighAccuracy: true, distanceFilter: 2, interval: 2000, fastestInterval: 1000 } // fix 9: 2m filter
      );
    };

    const requestAndStart = async () => {
      if (Platform.OS === 'android') {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
        );
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
          // fix 6: set permDenied state; don't leave infinite spinner
          setPermDenied(true);
          Alert.alert(
            'Location Permission Required',
            'Please open Settings and grant location access to use Find Device.',
            [{ text: 'Go Back', onPress: () => navigation.goBack() }]
          );
          return;
        }
      }
      startWatch();
    };

    requestAndStart();
    return () => {
      if (watchIdRef.current != null) Geolocation.clearWatch(watchIdRef.current);
      arrowAnim.stopAnimation(); // stop any in-flight rotation animation on unmount
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (cooldownRef.current) clearTimeout(cooldownRef.current);
    };
  }, []);

  // fix 5: re-request location from target
  const rerequestLocation = useCallback(async () => {
    if (!myPos || !targetDeviceId) return;
    try {
      // Always direct for re-requests — we know the specific device; broadcasting leaks our location to everyone
      const result = await BridgefyService.sendFindMeRequest(
        targetDeviceId, myPos.lat, myPos.lng, false
      );
      setRequestId(result?.mediaData?.requestId ?? null);
      setTimedOut(false);
      timeoutRef.current = setTimeout(() => setTimedOut(true), RESPONSE_TIMEOUT_MS);
    } catch (err) {
      Alert.alert('Error', 'Could not send location request. Check mesh connection.');
    }
  }, [targetDeviceId, myPos]);

  // ── Share my location back (fix 4: always direct; fix 7: re-share with cooldown) ──
  const shareLocationBack = useCallback(async () => {
    if (!myPos || !targetDeviceId || isSending || shareOnCooldown) return;
    setIsSending(true);
    try {
      // fix 4: always pass false — never broadcast a location response
      await BridgefyService.sendFindMeResponse(targetDeviceId, requestId, myPos.lat, myPos.lng, false);
      setShareCount(c => c + 1);
      setShareOnCooldown(true);
      cooldownRef.current = setTimeout(() => setShareOnCooldown(false), RESHARE_COOLDOWN_MS);
    } catch (err) {
      Alert.alert('Error', err.message || 'Could not share location.');
    } finally {
      setIsSending(false);
    }
  }, [myPos, isSending, shareOnCooldown, targetDeviceId, requestId]);

  // ── Arrow rotation interpolation (fix 10) ────────────────────────────────
  const arrowRotation = arrowAnim.interpolate({
    inputRange: [0, 360],
    outputRange: ['0deg', '360deg'],
    // extrapolate defaults to 'extend' — handles accumulated values beyond [0,360]
  });

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
            {permDenied
              ? 'Location permission denied'
              : myPos
                ? 'GPS active'
                : 'Acquiring GPS...'}
          </Text>
        </View>
      </View>

      {/* Compass / Direction display */}
      <View style={styles.compassArea}>
        {/* fix 6: permission denied — clear error state, not infinite spinner */}
        {permDenied ? (
          <View style={styles.centerCol}>
            <Icon name="location-off" size={72} color={colors.error || '#FF3B30'} />
            <Text style={styles.waitText}>Location permission denied</Text>
            <Text style={styles.subText}>Grant location access in Settings to use this feature.</Text>
          </View>

        ) : !myPos ? (
          <View style={styles.centerCol}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={styles.waitText}>Waiting for your GPS...</Text>
          </View>

        ) : !targetPos ? (
          <View style={styles.centerCol}>
            <Icon name="location-searching" size={72} color={colors.primary} />
            {/* fix 5: show timeout message + re-request button */}
            <Text style={styles.waitText}>
              {timedOut
                ? `${targetDeviceName} hasn't responded`
                : `Waiting for ${targetDeviceName}'s location...`}
            </Text>
            <Text style={styles.subText}>
              {timedOut
                ? 'They may be out of range or have the app closed.'
                : 'They\'ll appear here once they share.'}
            </Text>
            {timedOut && (
              <TouchableOpacity
                style={[styles.rerequestBtn, !myPos && styles.rerequestBtnDisabled]}
                onPress={rerequestLocation}
                disabled={!myPos}
              >
                <Icon name="refresh" size={18} color="#fff" style={{ marginRight: 6 }} />
                <Text style={styles.rerequestBtnText}>Request Again</Text>
              </TouchableOpacity>
            )}
          </View>

        ) : computed ? (
          <View style={styles.centerCol}>
            {/* Rotating arrow — fix 10: Animated, fix 1: GPS heading */}
            <View style={styles.arrowRing}>
              <Animated.View style={{ transform: [{ rotate: arrowRotation }] }}>
                <Icon name="navigation" size={64} color={colors.primary} />
              </Animated.View>
            </View>

            {/* fix 1: heading context for user */}
            <Text style={styles.headingHint}>
              {computed.hasHeading
                ? 'Arrow adjusted to your direction of travel'
                : 'Walk toward target — arrow calibrates as you move'}
            </Text>

            {/* Distance & bearing */}
            <Text style={styles.distanceText}>{formatDistance(computed.dist)}</Text>
            <Text style={styles.directionText}>
              {computed.cardinal}  ·  {Math.round(computed.bearing)}° from North
            </Text>

            {/* fix 3: threshold 15m (within GPS accuracy, not 30m) */}
            {computed.dist < 15 && (
              <View style={styles.closeBadge}>
                <Icon name="near-me" size={16} color="#fff" />
                <Text style={styles.closeText}>You're very close!</Text>
              </View>
            )}

            {/* fix 2: target location age */}
            {targetPos.ts != null && (
              <Text style={styles.targetAge}>
                Location updated {formatAge(targetPos.ts)}
              </Text>
            )}
          </View>
        ) : null}
      </View>

      {/* Footer: share location + fix 13: delivery confirmation */}
      <View style={styles.footer}>
        <TouchableOpacity
          style={[
            styles.shareBtn,
            (!myPos || isSending || shareOnCooldown || permDenied) && styles.shareBtnDisabled,
          ]}
          onPress={shareLocationBack}
          disabled={!myPos || isSending || shareOnCooldown || permDenied}
        >
          {isSending
            ? <ActivityIndicator size="small" color="#fff" />
            : <Icon name="share-location" size={20} color="#fff" style={{ marginRight: 8 }} />
          }
          <Text style={styles.shareBtnText}>
            {isSending
              ? 'Sharing...'
              : shareCount > 0
                ? 'Update my location'  // fix 7: allow re-share
                : `Share my location with ${targetDeviceName}`}
          </Text>
        </TouchableOpacity>

        {/* fix 13: delivery confirmation banner */}
        {shareCount > 0 && (
          <View style={styles.sharedConfirm}>
            <Icon name="check-circle" size={16} color={colors.success} />
            <Text style={styles.sharedConfirmText}>
              {shareCount > 1
                ? `Shared ${shareCount}× — ${targetDeviceName} can find you`
                : `Shared — ${targetDeviceName} can now find you`}
            </Text>
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
    marginBottom: 16,
    backgroundColor: colors.surface,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15, shadowRadius: 8, elevation: 6,
  },

  headingHint: {
    fontSize: 11, color: colors.textMuted, marginBottom: 16,
    textAlign: 'center', fontStyle: 'italic',
  },

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
    marginBottom: 12,
  },
  closeText: { color: '#fff', fontWeight: '700', marginLeft: 6, fontSize: 14 },

  targetAge: {
    fontSize: 11, color: colors.textMuted, marginTop: 8, textAlign: 'center',
  },

  waitText: { fontSize: 16, color: colors.textSecondary, marginTop: 16, textAlign: 'center' },
  subText:  { fontSize: 13, color: colors.textMuted, marginTop: 8, textAlign: 'center' },

  rerequestBtn: {
    flexDirection: 'row', alignItems: 'center',
    marginTop: 20, backgroundColor: colors.primary,
    borderRadius: 10, paddingVertical: 12, paddingHorizontal: 20,
  },
  rerequestBtnDisabled: { backgroundColor: colors.border },
  rerequestBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },

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
    paddingTop: 10,
  },
  sharedConfirmText: { color: colors.success, fontWeight: '600', marginLeft: 6, fontSize: 13 },
});

export default FindDeviceScreen;
