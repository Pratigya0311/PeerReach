import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  SafeAreaView,
  RefreshControl,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import BridgefyService from '../services/BridgefyService';

const DevicesScreen = ({ navigation }) => {
  const [devices, setDevices] = useState([]);
  const [reachable, setReachable] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [myDeviceId, setMyDeviceId] = useState('');

  useFocusEffect(
    useCallback(() => {
      loadDevices();
    }, [])
  );

  useEffect(() => {
    BridgefyService.getMyDeviceId().then(id => setMyDeviceId(id));
  }, []);

  const loadDevices = async () => {
    try {
      setIsLoading(true);
      const deviceList = await BridgefyService.getConnectedDevices();
      const filteredDevices = deviceList.filter(device => device.id !== myDeviceId);
      setDevices(filteredDevices);
      const reachableUsers = await BridgefyService.getReachableUsers();
      setReachable(reachableUsers);
      setIsLoading(false);
    } catch (error) {
      console.error('Error loading devices:', error);
      setIsLoading(false);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await loadDevices();
    setRefreshing(false);
  };

  const startChat = (device, isMesh = false) => {
    navigation.navigate('Chat', {
      deviceId: device.id,
      deviceName: device.name,
      isBroadcast: false,
      isMesh
    });
  };

  const combined = [
    { type: 'section', title: 'Nearby' },
    ...devices.map(device => ({ type: 'device', data: device, isMesh: false })),
    { type: 'section', title: 'Reachable (Mesh)' },
    ...reachable.map(device => ({ type: 'device', data: device, isMesh: true })),
  ];

  const renderItem = ({ item }) => {
    if (item.type === 'section') {
      return <Text style={styles.sectionTitle}>{item.title}</Text>;
    }

    const device = item.data;
    const isMesh = item.isMesh;

    return (
      <TouchableOpacity
        style={styles.deviceCard}
        onPress={() => startChat(device, isMesh)}
      >
        <View style={styles.deviceIcon}>
          <Text style={styles.deviceIconText}>{isMesh ? 'M' : 'P'}</Text>
        </View>
        <View style={styles.deviceInfo}>
          <Text style={styles.deviceName}>{device.name}</Text>
          <Text style={styles.deviceId}>
            ID: {device.id ? `${device.id.substring(0, 12)}...` : 'Unknown'}
          </Text>
          {isMesh && <Text style={styles.deviceId}>Hops: {device.hops}</Text>}
        </View>
        <View style={styles.connectionDot} />
        <Text style={styles.connectText}>{isMesh ? 'Mesh Chat ->' : 'Chat ->'}</Text>
      </TouchableOpacity>
    );
  };

  if (isLoading) {
    return (
      <SafeAreaView style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingText}>Searching for devices...</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Select Device</Text>
        <Text style={styles.subtitle}>
          Tap a device to start chatting
        </Text>
        <TouchableOpacity style={styles.refreshNearbyButton} onPress={loadDevices}>
          <Text style={styles.refreshNearbyText}>Refresh Nearby</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={combined}
        renderItem={renderItem}
        keyExtractor={(item, index) => item.type === 'section' ? `section-${index}` : item.data.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={['#007AFF']}
          />
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>🔍</Text>
            <Text style={styles.emptyText}>No devices found</Text>
            <Text style={styles.emptySubtext}>
              Make sure other devices have PeerReach running nearby
            </Text>
            <TouchableOpacity
              style={styles.refreshButton}
              onPress={loadDevices}
            >
              <Text style={styles.refreshButtonText}>Refresh</Text>
            </TouchableOpacity>
          </View>
        }
      />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F5F5',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    fontSize: 16,
    color: '#666',
    marginTop: 12,
  },
  header: {
    backgroundColor: '#007AFF',
    padding: 20,
    paddingTop: 60,
    paddingBottom: 20,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: 'white',
  },
  subtitle: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.9)',
    marginTop: 4,
  },
  list: {
    padding: 16,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#444',
    marginBottom: 8,
    marginTop: 12,
  },
  deviceCard: {
    backgroundColor: 'white',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  deviceIcon: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: '#E3F2FD',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  deviceIconText: {
    fontSize: 24,
  },
  deviceInfo: {
    flex: 1,
  },
  deviceName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
    marginBottom: 4,
  },
  deviceId: {
    fontSize: 12,
    color: '#999',
  },
  connectionDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#34C759',
    marginRight: 8,
  },
  connectText: {
    color: '#007AFF',
    fontSize: 14,
    fontWeight: '600',
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
    marginTop: 60,
  },
  emptyIcon: {
    fontSize: 64,
    marginBottom: 16,
  },
  emptyText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#333',
    marginBottom: 8,
  },
  emptySubtext: {
    fontSize: 14,
    color: '#999',
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 20,
  },
  refreshButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  refreshButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  refreshNearbyButton: {
    marginTop: 12,
    alignSelf: 'flex-start',
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  refreshNearbyText: {
    color: '#007AFF',
    fontSize: 14,
    fontWeight: '600',
  },
});

export default DevicesScreen;