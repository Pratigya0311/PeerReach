import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import BridgefyService from '../services/BridgefyService';
import { useTheme } from '../theme';

const DevicesScreen = ({ navigation }) => {
  const colors = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [nearby, setNearby]         = useState([]);
  const [reachable, setReachable]   = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [scanHealth, setScanHealth] = useState(BridgefyService.getScanHealth?.() || {});

  const loadTimerRef = useRef(null);
  const loadingRef = useRef(false);
  const pendingRef = useRef(false);
  const scanIntervalRef = useRef(null);

  const loadDevices = useCallback(async () => {
    try {
      const [deviceList, reachableList, myId] = await Promise.all([
        BridgefyService.getConnectedDevices(),
        BridgefyService.getReachableUsers(),
        BridgefyService.getMyDeviceId(),
      ]);
      const direct = deviceList.filter(d => d.id !== myId);
      const directIds = new Set(direct.map(d => d.id));
      const meshOnly = (reachableList || []).filter(d => d.id !== myId && !directIds.has(d.id));
      setNearby(direct);
      setReachable(meshOnly);
      if (BridgefyService.getScanHealth) {
        setScanHealth(BridgefyService.getScanHealth());
      }
    } catch (error) {
      console.error('Error loading devices:', error);
    }
  }, []);

  const scheduleLoad = useCallback((immediate = false) => {
    if (loadingRef.current) {
      pendingRef.current = true;
      return;
    }
    if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
    loadTimerRef.current = setTimeout(async () => {
      loadingRef.current = true;
      try {
        await loadDevices();
      } finally {
        loadingRef.current = false;
        if (pendingRef.current) {
          pendingRef.current = false;
          scheduleLoad(true);
        }
      }
    }, immediate ? 0 : 300);
  }, [loadDevices]);

  useFocusEffect(
    useCallback(() => {
      scheduleLoad(true);
      BridgefyService.setOnDeviceListUpdatedHandler(() => scheduleLoad(false));
      // Keep direct scan warm while this screen is visible to avoid 1s flicker.
      scanIntervalRef.current = setInterval(async () => {
        try {
          await BridgefyService.getConnectedDevices();
        } catch (_e) {}
        scheduleLoad(false);
      }, 6000);
      return () => {
        BridgefyService.setOnDeviceListUpdatedHandler(null);
        if (scanIntervalRef.current) {
          clearInterval(scanIntervalRef.current);
          scanIntervalRef.current = null;
        }
      };
    }, [scheduleLoad])
  );

  useEffect(() => {
    const t = setInterval(() => {
      if (BridgefyService.getScanHealth) {
        setScanHealth(BridgefyService.getScanHealth());
      }
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await BridgefyService.getConnectedDevices();
      await loadDevices();
    } finally {
      setRefreshing(false);
    }
  };

  const startChat = (device) => {
    navigation.navigate('Chat', {
      deviceId:   device.id,
      deviceName: device.name,
      isBroadcast: false,
    });
  };

  const renderDevice = ({ item }) => {
    return (
      <TouchableOpacity style={styles.deviceCard} onPress={() => startChat(item)}>
        <View style={styles.deviceIcon}>
          <Icon name="smartphone" size={26} color={colors.primary} />
        </View>

        <View style={styles.deviceInfo}>
          <Text style={styles.deviceName}>{item.name}</Text>
          <Text style={styles.deviceId}>
            ID: {item.id ? `${item.id.substring(0, 12)}...` : 'Unknown'}
          </Text>
          {item.battery != null && (
            <Text style={styles.batteryText}>{item.battery}% battery</Text>
          )}
          <View style={styles.tagRow}>
            {item.isNearby ? (
              <View style={[styles.tag, styles.tagNearby]}>
                <Text style={styles.tagText}>Nearby</Text>
              </View>
            ) : (
              <View style={[styles.tag, styles.tagMesh]}>
                <Text style={styles.tagText}>
                  Mesh{item.hops != null ? ` • ${item.hops} hops` : ''}
                </Text>
              </View>
            )}
          </View>
        </View>

        <View style={styles.connectionDot} />
        <Text style={styles.connectText}>Chat →</Text>
      </TouchableOpacity>
    );
  };

  const sectionHeader = (title, count) => (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Text style={styles.sectionCount}>{count}</Text>
    </View>
  );

  const formatAge = (ts) => {
    if (!ts) return 'never';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    return `${s}s`;
  };

  const hasDevices = nearby.length + reachable.length > 0;
  const mergedData = hasDevices
    ? [
        { type: 'section', id: 'nearby_header', title: 'Nearby', count: nearby.length },
        ...nearby.map(d => ({ ...d, isNearby: true, type: 'item' })),
        { type: 'section', id: 'mesh_header', title: 'Reachable (Mesh)', count: reachable.length },
        ...reachable.map(d => ({ ...d, isNearby: false, type: 'item' })),
      ]
    : [];

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <View style={styles.headerText}>
            <Text style={styles.title}>Select Device</Text>
            <Text style={styles.subtitle}>Tap a device to start chatting</Text>
            <Text style={styles.scanHealth}>
              Scan: {formatAge(scanHealth.lastDirectScanAt)} · Announce: {formatAge(scanHealth.lastAnnounceAt)} · Nearby: {scanHealth.directFreshCount ?? 0}
            </Text>
          </View>
          <TouchableOpacity
            style={styles.refreshNearbyBtn}
            onPress={async () => {
              setRefreshing(true);
              try {
                await BridgefyService.getConnectedDevices();
                await loadDevices();
              } finally {
                setRefreshing(false);
              }
            }}
          >
            <Icon name="refresh" size={18} color={colors.onColor} />
            <Text style={styles.refreshNearbyText}>Nearby</Text>
          </TouchableOpacity>
        </View>
      </View>

      <FlatList
        data={mergedData}
        renderItem={({ item }) => (
          item.type === 'section'
            ? sectionHeader(item.title, item.count)
            : renderDevice({ item })
        )}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[colors.primary]}
            tintColor={colors.primary}
          />
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Icon name="search" size={64} color={colors.textMuted} style={styles.emptyIcon} />
            <Text style={styles.emptyText}>No devices found</Text>
            <Text style={styles.emptySubtext}>
              Make sure other devices have PeerReach running nearby
            </Text>
            <TouchableOpacity style={styles.refreshButton} onPress={onRefresh}>
              <Text style={styles.refreshButtonText}>Refresh</Text>
            </TouchableOpacity>
          </View>
        }
      />
    </SafeAreaView>
  );
};

// ─── Styles (theme-aware) ────────────────────────────────────────────────────
const makeStyles = (colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },

  header: {
    backgroundColor: colors.headerBg,
    padding: 20,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerText: { flex: 1, paddingRight: 12 },
  title:    { fontSize: 28, fontWeight: 'bold', color: colors.headerText },
  subtitle: { fontSize: 14, color: colors.headerSubtitle, marginTop: 4 },
  scanHealth: { fontSize: 12, color: colors.headerSubtitle, marginTop: 6 },
  refreshNearbyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  refreshNearbyText: { color: colors.onColor, marginLeft: 6, fontSize: 12, fontWeight: '600' },

  list: { padding: 16 },

  deviceCard: {
    backgroundColor: colors.surface,
    borderRadius: 12, padding: 16, marginBottom: 12,
    flexDirection: 'row', alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1, shadowRadius: 4, elevation: 3,
  },
  deviceIcon: {
    width: 50, height: 50, borderRadius: 25,
    backgroundColor: colors.primary + '18',
    justifyContent: 'center', alignItems: 'center',
    marginRight: 12,
  },
  deviceInfo:     { flex: 1 },
  deviceName:     { fontSize: 16, fontWeight: '600', color: colors.text, marginBottom: 4 },
  deviceId:       { fontSize: 12, color: colors.textMuted },
  batteryText:    { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  tagRow:         { flexDirection: 'row', marginTop: 6 },
  tag:            { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  tagNearby:      { backgroundColor: colors.success + '22' },
  tagMesh:        { backgroundColor: colors.accent + '22' },
  tagText:        { fontSize: 11, color: colors.text },
  connectionDot:  { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.success, marginRight: 8 },
  connectText:    { color: colors.connectText, fontSize: 14, fontWeight: '600' },

  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
    paddingHorizontal: 4,
  },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: colors.textMuted },
  sectionCount: { fontSize: 12, color: colors.textMuted },

  emptyState: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
    padding: 40, marginTop: 60,
  },
  emptyIcon:        { marginBottom: 16 },
  emptyText:        { fontSize: 18, fontWeight: '600', color: colors.text, marginBottom: 8 },
  emptySubtext:     { fontSize: 14, color: colors.textMuted, textAlign: 'center', marginBottom: 24, lineHeight: 20 },
  refreshButton:    { backgroundColor: colors.primary, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 8 },
  refreshButtonText:{ color: colors.onColor, fontSize: 16, fontWeight: '600' },
});

export default DevicesScreen;
