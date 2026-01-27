import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  PermissionsAndroid,
  Platform,
} from 'react-native';
import BridgefyService from '../services/BridgefyService';

const HomeScreen = ({ navigation }) => {
  const [devices, setDevices] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [myDeviceId, setMyDeviceId] = useState('');

  useEffect(() => {
    console.log('HomeScreen: Component mounted');
    
    // Request permissions and initialize
    requestPermissions().then((granted) => {
      if (granted) {
        initializeBridgefy();
      } else {
        setIsLoading(false);
        Alert.alert(
          'Permission Required',
          'Location and Bluetooth permissions are required for Bridgefy to work.',
          [{ text: 'OK', onPress: () => console.log('Permission denied') }]
        );
      }
    });

    // Set up device list listener
    BridgefyService.setDeviceListListener((updatedDevices) => {
      console.log('HomeScreen: Devices updated', updatedDevices);
      setDevices(updatedDevices || []);
    });

    return () => {
      console.log('HomeScreen: Component unmounting');
    };
  }, []);

  const requestPermissions = async () => {
    if (Platform.OS === 'android') {
      try {
        if (Platform.Version >= 31) {
          const result = await PermissionsAndroid.requestMultiple([
            'android.permission.BLUETOOTH_SCAN',
            'android.permission.BLUETOOTH_CONNECT',
            'android.permission.BLUETOOTH_ADVERTISE',
            'android.permission.ACCESS_FINE_LOCATION'
          ]);
          
          return (
            result['android.permission.BLUETOOTH_CONNECT'] === 'granted' &&
            result['android.permission.BLUETOOTH_SCAN'] === 'granted' &&
            result['android.permission.ACCESS_FINE_LOCATION'] === 'granted'
          );
        } 
        else {
          const granted = await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
          );
          return granted === PermissionsAndroid.RESULTS.GRANTED;
        }
      } catch (err) {
        console.warn('Permission Error:', err);
        return false;
      }
    }
    return true; 
  };

  const initializeBridgefy = async () => {
  try {
    console.log('--- STARTING BRIDGEFY INITIALIZATION ---');
    
    const API_KEY = '8a349463-829d-4c67-a489-4a4c5cb82eba';
    
    if (!API_KEY || API_KEY.length < 36) {
      Alert.alert('Error', 'Invalid API key. Please check your API key.');
      setIsLoading(false);
      return;
    }
    
    console.log('Using API Key:', API_KEY);

    await BridgefyService.initialize(API_KEY);

    const deviceName = await BridgefyService.getMyDeviceName();
    console.log('Device Name:', deviceName);

    const initialDevices = await BridgefyService.getConnectedDevices();
    setDevices(initialDevices || []);

    let attempts = 0;
    const maxAttempts = 10;
    const checkInterval = setInterval(async () => {
      attempts++;
      console.log(`Attempt ${attempts}/${maxAttempts}: Getting device ID...`);
      
      try {
        const id = await BridgefyService.getMyDeviceId();
        console.log(`Device ID check ${attempts}:`, id);
        
        if (id && id !== 'initializing...' && id !== 'unknown') {
          setMyDeviceId(id);
          setIsLoading(false);
          clearInterval(checkInterval);
          console.log('✅ Bridgefy initialized successfully');
          Alert.alert('✅ Success', `Bridgefy started!\nDevice: ${deviceName}\nID: ${id.substring(0, 12)}...`);
        } else if (attempts >= maxAttempts) {
          clearInterval(checkInterval);
          setIsLoading(false);
          setMyDeviceId('unknown');
          console.log('⚠️ Max attempts reached, ID not available');
          Alert.alert('⚠️ Started', 'Bridgefy is running but device ID not available yet.');
        }
      } catch (err) {
        console.log(`Error getting ID attempt ${attempts}:`, err);
      }
    }, 1000);

  } catch (error) {
    setIsLoading(false);
    console.error('Init Error:', error);
    Alert.alert(
      '❌ Start Failed',
      `Error: ${error.message || JSON.stringify(error)}`
    );
  }
};

  const openChat = (device) => {
    navigation.navigate('Chat', {
      deviceId: device.id,
      deviceName: device.name,
    });
  };

  const openBroadcast = () => {
    navigation.navigate('Chat', {
      deviceId: 'broadcast',
      deviceName: '📢 Broadcast to All',
    });
  };

  const renderDevice = ({ item }) => (
    <TouchableOpacity
      style={styles.deviceCard}
      onPress={() => openChat(item)}
    >
      <View style={styles.deviceIcon}>
        <Text style={styles.deviceIconText}>📱</Text>
      </View>
      <View style={styles.deviceInfo}>
        <Text style={styles.deviceName}>{item.name}</Text>
        <Text style={styles.deviceId}>ID: {item.id ? item.id.substring(0, 12) : '???'}...</Text>
      </View>
      <View style={styles.statusDot} />
    </TouchableOpacity>
  );

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingText}>Starting Mesh Network...</Text>
        <Text style={styles.loadingSubtext}>Please wait while we set up Bluetooth connections</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>🔗 PeerReach</Text>
        <Text style={styles.subtitle}>
          My ID: {myDeviceId ? myDeviceId.substring(0, 12) + '...' : 'Unknown'}
        </Text>
      </View>

      {/* Device Count */}
      <View style={styles.statsBar}>
        <Text style={styles.statsText}>
          {devices.length === 0
            ? '🔍 Searching for nearby devices...'
            : `✅ ${devices.length} device(s) nearby`}
        </Text>
      </View>

      {/* Broadcast Button */}
      <TouchableOpacity
        style={styles.broadcastButton}
        onPress={openBroadcast}
      >
        <Text style={styles.broadcastText}>📢 Broadcast to All</Text>
      </TouchableOpacity>

      {/* Device List */}
      {devices.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyIcon}>🔍</Text>
          <Text style={styles.emptyText}>No devices found yet</Text>
          <Text style={styles.emptySubtext}>
            Make sure other devices have PeerReach running nearby{'\n'}
            They should appear here automatically
          </Text>
        </View>
      ) : (
        <FlatList
          data={devices}
          renderItem={renderDevice}
          keyExtractor={(item) => item.id || Math.random().toString()}
          contentContainerStyle={styles.list}
        />
      )}
    </View>
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
    backgroundColor: '#F5F5F5',
    padding: 20,
  },
  loadingText: {
    marginTop: 16,
    fontSize: 18,
    fontWeight: '600',
    color: '#333',
  },
  loadingSubtext: {
    marginTop: 8,
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
    paddingHorizontal: 20,
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
    fontSize: 12,
    color: 'rgba(255,255,255,0.8)',
    marginTop: 4,
  },
  statsBar: {
    backgroundColor: 'white',
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#E0E0E0',
  },
  statsText: {
    fontSize: 14,
    color: '#333',
    textAlign: 'center',
  },
  broadcastButton: {
    backgroundColor: '#FF9500',
    margin: 16,
    padding: 16,
    borderRadius: 12,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 3,
  },
  broadcastText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  list: {
    padding: 16,
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
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#34C759',
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
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
    lineHeight: 20,
  },
});

export default HomeScreen;