import React, { useState, useCallback, useMemo } from 'react';
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

  const [devices, setDevices]       = useState([]);
  const [refreshing, setRefreshing] = useState(false);

  useFocusEffect(
    useCallback(() => {
      loadDevices();
      BridgefyService.setOnDeviceListUpdatedHandler(() => loadDevices());
      return () => BridgefyService.setOnDeviceListUpdatedHandler(null);
    }, [])
  );

  const loadDevices = async () => {
    try {
      const [deviceList, myId] = await Promise.all([
        BridgefyService.getConnectedDevices(),
        BridgefyService.getMyDeviceId(),
      ]);
      setDevices(deviceList.filter(d => d.id !== myId));
    } catch (error) {
      console.error('Error loading devices:', error);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    try {
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
        </View>

        <View style={styles.connectionDot} />
        <Text style={styles.connectText}>Chat →</Text>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Select Device</Text>
        <Text style={styles.subtitle}>Tap a device to start chatting</Text>
      </View>

      <FlatList
        data={devices}
        renderItem={renderDevice}
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
  title:    { fontSize: 28, fontWeight: 'bold', color: colors.headerText },
  subtitle: { fontSize: 14, color: colors.headerSubtitle, marginTop: 4 },

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
  connectionDot:  { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.success, marginRight: 8 },
  connectText:    { color: colors.connectText, fontSize: 14, fontWeight: '600' },

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
