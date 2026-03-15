import React, { useState, useEffect, useCallback } from 'react';
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
  RefreshControl,
  SafeAreaView,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import BridgefyService from '../services/BridgefyService';

const HomeScreen = ({ navigation }) => {
  const [conversations, setConversations] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [myDeviceId, setMyDeviceId] = useState('');
  const [myDeviceName, setMyDeviceName] = useState('');
  const [unreadCounts, setUnreadCounts] = useState({ total: 0, broadcast: 0, direct: 0 });
  const [refreshing, setRefreshing] = useState(false);
  const [bridgefyStatus, setBridgefyStatus] = useState('initializing');

  useFocusEffect(
    useCallback(() => {
      loadData();
      return () => {
      };
    }, [])
  );

  useEffect(() => {
    console.log('🏠 HomeScreen mounted');

    BridgefyService.setOnNewMessageHandler(handleNewMessage);
    BridgefyService.setOnReadyHandler(handleBridgefyReady);
    BridgefyService.setOnErrorHandler(handleBridgefyError);
    BridgefyService.setOnUnreadUpdatedHandler(handleUnreadUpdated);

    requestPermissions().then((granted) => {
      if (granted) {
        initializeBridgefy();
      } else {
        setIsLoading(false);
        Alert.alert(
          'Permissions Required',
          'Location and Bluetooth permissions are required for PeerReach to work. Please enable them in settings.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Open Settings', onPress: () => {
              if (Platform.OS === 'android') {
                // Open app settings
                // You might need a package like react-native-app-settings
              }
            }}
          ]
        );
      }
    });

    return () => {
      BridgefyService.setOnNewMessageHandler(null);
      BridgefyService.setOnReadyHandler(null);
      BridgefyService.setOnErrorHandler(null);
      BridgefyService.setOnUnreadUpdatedHandler(null);
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
            result['android.permission.BLUETOOTH_ADVERTISE'] === 'granted' &&
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
      setBridgefyStatus('initializing');
      console.log('🚀 Initializing Bridgefy...');
      
      const API_KEY = 'e33f9719-66d1-4d19-acd0-3fb186c915a3';
      
      if (!API_KEY || API_KEY.length < 36) {
        Alert.alert('Invalid API Key', 'Please check your Bridgefy API key configuration.');
        setIsLoading(false);
        setBridgefyStatus('error');
        return;
      }
      
      await BridgefyService.initialize(API_KEY);

      const deviceId = await BridgefyService.getMyDeviceId();
      const deviceName = await BridgefyService.getMyDeviceName();
      
      setMyDeviceId(deviceId);
      setMyDeviceName(deviceName);

      await loadData();
      
      setBridgefyStatus('ready');
      setIsLoading(false);
      
      console.log('✅ Bridgefy initialized successfully');
      
    } catch (error) {
      console.error('❌ Bridgefy initialization failed:', error);
      setBridgefyStatus('error');
      setIsLoading(false);
      Alert.alert(
        'Initialization Failed',
        `Could not start Bridgefy: ${error.message || 'Unknown error'}\n\nPlease check:\n1. Your API key\n2. Bluetooth is enabled\n3. Location permission is granted`,
        [{ text: 'OK', style: 'default' }]
      );
    }
  };

  const loadData = async () => {
    try {
      setRefreshing(true);

      await BridgefyService.getConnectedDevices();

      const convos = await BridgefyService.getConversations();
      setConversations(convos);

      const counts = BridgefyService.getUnreadCounts();
      setUnreadCounts(counts);
      
      setRefreshing(false);
    } catch (error) {
      console.error('Error loading data:', error);
      setRefreshing(false);
    }
  };

  const handleNewMessage = (data) => {
    console.log('📨 New message received in HomeScreen');
    loadData();
  };

  const handleBridgefyReady = (data) => {
    console.log('✅ Bridgefy ready:', data);
    setMyDeviceId(data.deviceId);
    setMyDeviceName(data.deviceName);
    setBridgefyStatus('ready');
    loadData();
  };

  const handleBridgefyError = (error) => {
    console.error('❌ Bridgefy error:', error);
    setBridgefyStatus('error');
    Alert.alert('Bridgefy Error', error.message || 'Unknown error occurred');
  };

  const handleUnreadUpdated = (counts) => {
    setUnreadCounts(counts);
  };

  const openChat = async (conversation) => {
    await BridgefyService.markAsRead(conversation.id, conversation.isBroadcast);
    
    BridgefyService.setCurrentChat(conversation.id);
    
    navigation.navigate('Chat', {
      deviceId: conversation.id,
      deviceName: conversation.name,
      isBroadcast: conversation.isBroadcast
    });

    setTimeout(loadData, 500);
  };

  const openNewChat = () => {
    navigation.navigate('Devices');
  };

  const renderConversation = ({ item }) => {
    const timeAgo = formatTimeAgo(item.timestamp);
    
    return (
      <TouchableOpacity
        style={[
          styles.conversationCard,
          item.unreadCount > 0 && styles.unreadConversation
        ]}
        onPress={() => openChat(item)}
      >
        <View style={[styles.avatar, item.isBroadcast ? styles.avatarBroadcast : styles.avatarDirect]}>
          <Text style={styles.avatarText}>
            {item.isBroadcast ? 'BC' : (item.name || '?')[0].toUpperCase()}
          </Text>
          {item.unreadCount > 0 && (
            <View style={styles.avatarBadge}>
              <Text style={styles.avatarBadgeText}>
                {item.unreadCount > 9 ? '9+' : item.unreadCount}
              </Text>
            </View>
          )}
        </View>
        
        <View style={styles.conversationInfo}>
          <View style={styles.conversationHeader}>
            <Text style={styles.conversationName} numberOfLines={1}>
              {item.name}
            </Text>
            <Text style={styles.conversationTime}>{timeAgo}</Text>
          </View>
          
          <Text 
            style={[
              styles.lastMessage,
              item.unreadCount > 0 && styles.unreadLastMessage
            ]} 
            numberOfLines={2}
          >
            {item.isBroadcast ? `${item.senderName}: ` : ''}{item.lastMessage}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  const formatTimeAgo = (timestamp) => {
    if (!timestamp) return '';
    
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    
    return new Date(timestamp).toLocaleDateString();
  };

  if (isLoading) {
    return (
      <SafeAreaView style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingText}>Starting PeerReach...</Text>
        <Text style={styles.loadingSubtext}>
          {bridgefyStatus === 'initializing' && 'Initializing mesh network...'}
          {bridgefyStatus === 'error' && 'Failed to start. Please check permissions.'}
        </Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <Text style={styles.title}>PeerReach</Text>
          {unreadCounts.total > 0 && (
            <View style={styles.headerBadge}>
              <Text style={styles.headerBadgeText}>{unreadCounts.total}</Text>
            </View>
          )}
        </View>
        
        <Text style={styles.subtitle}>
          {myDeviceName} • ID: {myDeviceId ? myDeviceId.substring(0, 8) + '...' : 'Unknown'}
        </Text>
        
        <View style={styles.statusRow}>
          <View style={[styles.statusDot, bridgefyStatus === 'ready' ? styles.dotOnline : styles.dotOffline]} />
          <Text style={styles.status}>
            {bridgefyStatus === 'ready' ? 'Online' : 'Offline'}
            {conversations.length > 0 && ` • ${conversations.length} conversation${conversations.length !== 1 ? 's' : ''}`}
          </Text>
        </View>
      </View>

      {/* Action Buttons */}
      <View style={styles.actionButtons}>
        <TouchableOpacity
          style={[styles.actionButton, styles.broadcastButton]}
          onPress={() => openChat({
            id: 'broadcast',
            name: 'Broadcast to All',
            isBroadcast: true,
            timestamp: Date.now(),
            lastMessage: 'Send messages to all nearby devices'
          })}
        >
          <Text style={styles.actionButtonText}>Broadcast</Text>
        </TouchableOpacity>
        
        <TouchableOpacity
          style={[styles.actionButton, styles.newChatButton]}
          onPress={openNewChat}
        >
          <Text style={styles.actionButtonText}>+ New Chat</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.actionButton, styles.askMeshButton]}
          onPress={() => navigation.navigate('MeshQuery')}
        >
          <Text style={styles.actionButtonText}>Ask Mesh</Text>
        </TouchableOpacity>
      </View>

      {/* Conversations List */}
      <FlatList
        data={conversations}
        renderItem={renderConversation}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={loadData}
            colors={['#007AFF']}
          />
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <View style={styles.emptyIconCircle} />
            <Text style={styles.emptyText}>No conversations yet</Text>
            <Text style={styles.emptySubtext}>
              Start a broadcast or chat with nearby devices
            </Text>
            <TouchableOpacity
              style={styles.emptyButton}
              onPress={() => BridgefyService.getConnectedDevices().then(loadData)}
            >
              <Text style={styles.emptyButtonText}>Refresh Devices</Text>
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
    backgroundColor: '#F5F5F5',
    padding: 20,
  },
  loadingText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#333',
    marginTop: 20,
    marginBottom: 8,
  },
  loadingSubtext: {
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
    paddingHorizontal: 40,
  },
  header: {
    backgroundColor: '#007AFF',
    padding: 20,
    paddingTop: 50,
  },
  headerTop: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: 'white',
  },
  headerBadge: {
    backgroundColor: '#FF3B30',
    borderRadius: 12,
    minWidth: 24,
    height: 24,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 10,
    paddingHorizontal: 6,
  },
  headerBadgeText: {
    color: 'white',
    fontSize: 12,
    fontWeight: 'bold',
  },
  subtitle: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.9)',
    marginBottom: 4,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  dotOnline: { backgroundColor: '#34C759' },
  dotOffline: { backgroundColor: '#FF3B30' },
  status: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.7)',
  },
  actionButtons: {
    flexDirection: 'row',
    padding: 16,
    backgroundColor: 'white',
    borderBottomWidth: 1,
    borderBottomColor: '#E0E0E0',
  },
  actionButton: {
    flex: 1,
    padding: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginHorizontal: 6,
  },
  broadcastButton: {
    backgroundColor: '#FF9500',
  },
  newChatButton: {
    backgroundColor: '#34C759',
  },
  askMeshButton: {
    backgroundColor: '#5856D6',
  },
  actionButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  list: {
    padding: 16,
    paddingBottom: 32,
  },
  conversationCard: {
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
  unreadConversation: {
    backgroundColor: '#F0F8FF',
    borderLeftWidth: 4,
    borderLeftColor: '#007AFF',
  },
  avatar: {
    width: 50,
    height: 50,
    borderRadius: 25,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
    position: 'relative',
  },
  avatarBroadcast: { backgroundColor: '#FF9500' },
  avatarDirect:    { backgroundColor: '#007AFF' },
  avatarText: {
    fontSize: 16,
    fontWeight: '700',
    color: 'white',
  },
  avatarBadge: {
    position: 'absolute',
    top: -5,
    right: -5,
    backgroundColor: '#FF3B30',
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarBadgeText: {
    color: 'white',
    fontSize: 10,
    fontWeight: 'bold',
  },
  conversationInfo: {
    flex: 1,
  },
  conversationHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  conversationName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
    flex: 1,
  },
  conversationTime: {
    fontSize: 12,
    color: '#999',
    marginLeft: 8,
  },
  lastMessage: {
    fontSize: 14,
    color: '#666',
    lineHeight: 18,
  },
  unreadLastMessage: {
    color: '#333',
    fontWeight: '500',
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
    marginTop: 60,
  },
  emptyIconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#E0E0E0',
    marginBottom: 16,
  },
  emptyText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#333',
    marginBottom: 8,
    textAlign: 'center',
  },
  emptySubtext: {
    fontSize: 14,
    color: '#999',
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 20,
  },
  emptyButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  emptyButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
});

export default HomeScreen;
