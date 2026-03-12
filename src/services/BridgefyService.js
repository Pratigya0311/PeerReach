// src/services/BridgefyService.js - UPDATED FOR SQLITE
import { NativeModules, NativeEventEmitter, Platform, AppState } from 'react-native';
import databaseService from './DatabaseService';

const { Bridgefy } = NativeModules;
const bridgefyEmitter = new NativeEventEmitter(Bridgefy);

class BridgefyService {
  constructor() {
    this.deviceListListener = null;
    this.messageListener = null;
    this.backgroundMessageHandler = null;
    this.connectedDevices = new Map();
    this.myDeviceId = null;
    this.myDeviceName = Platform.OS === 'android' ? Bridgefy.deviceName || 'Android Device' : 'iOS Device';
    this.isInitialized = false;
    this.currentChatId = null;
    this.useAsyncStorage = false;
    // Initialize database
    this.initializeDatabase();
    
    // Set up event listeners
    this.setupEventListeners();
    
    // Listen for app state changes
    AppState.addEventListener('change', this.handleAppStateChange.bind(this));
  }

  async initializeDatabase() {
    try {
      await databaseService.initialize();
      this.useAsyncStorage = false;
      console.log('✅ Database ready');
    } catch (error) {
      console.error('❌ Database initialization failed, using AsyncStorage fallback:', error);
      this.useAsyncStorage = true;
    }
  }

  setupEventListeners() {
    // Registration events
    bridgefyEmitter.addListener('onRegistrationSuccessful', async (data) => {
      console.log('✅ Bridgefy registered:', data);
      this.myDeviceId = data.userUuid;
      this.myDeviceName = data.deviceName || this.myDeviceName;
      this.isInitialized = true;
      
      // Save my own device to database
      await databaseService.saveDevice({
        id: this.myDeviceId,
        name: this.myDeviceName,
        connection_status: 'online'
      });
      
      this.emitEvent('onReady', { deviceId: this.myDeviceId, deviceName: this.myDeviceName });
    });

    // Device connection events
    bridgefyEmitter.addListener('onDeviceConnected', async (device) => {
      console.log('📱 Device connected:', device);
      if (device.userId) {
        this.connectedDevices.set(device.userId, device.deviceName || `Device_${device.userId.substring(0, 8)}`);
        
        // Save to database
        await databaseService.saveDevice({
          id: device.userId,
          name: device.deviceName || `Device_${device.userId.substring(0, 8)}`,
          connection_status: 'online'
        });
        
        this.emitEvent('onDeviceConnected', device);
      }
    });

    bridgefyEmitter.addListener('onDeviceLost', async (device) => {
      console.log('📱 Device lost:', device);
      if (device.userId) {
        this.connectedDevices.delete(device.userId);
        
        // Update status in database
        await databaseService.updateDeviceStatus(device.userId, 'offline');
        
        this.emitEvent('onDeviceLost', device);
      }
    });

    // Message events
    bridgefyEmitter.addListener('onMessageReceived', async (rawMessage) => {
      console.log('📨 Direct message received:', rawMessage);
      await this.handleIncomingMessage(rawMessage, false);
    });

    bridgefyEmitter.addListener('onBroadcastMessageReceived', async (rawMessage) => {
      console.log('📢 Broadcast message received:', rawMessage);
      await this.handleIncomingMessage(rawMessage, true);
    });

    // ... rest of event listeners remain similar
  }

  async handleIncomingMessage(rawMessage, isBroadcast) {
    try {
      const messageType = isBroadcast ? 'broadcast' : 'direct';
      const senderId = rawMessage.senderId || 'unknown';
      const senderName = rawMessage.senderName || this.connectedDevices.get(senderId) || 'Unknown Device';
      
      // Create database message object
      const dbMessage = {
        id: rawMessage.messageId || `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        content: rawMessage.content || '',
        sender_id: senderId,
        sender_name: senderName,
        receiver_id: isBroadcast ? null : this.myDeviceId,
        message_type: messageType,
        is_mine: false,
        is_broadcast: isBroadcast,
        timestamp: parseInt(rawMessage.timestamp) || Date.now(),
        read_status: 0, // unread
        delivery_status: 'delivered'
      };

      // Save to database
      const savedMessage = await databaseService.saveMessage(dbMessage);
      
      // Convert to app message format
      const message = {
        id: savedMessage.id,
        text: savedMessage.content,
        senderId: savedMessage.sender_id,
        senderName: savedMessage.sender_name,
        receiverId: savedMessage.receiver_id,
        timestamp: savedMessage.timestamp,
        isMine: false,
        isBroadcast: isBroadcast,
        type: 'text',
        read: false
      };

      // Check app state
      const appState = AppState.currentState;
      const isAppActive = appState === 'active';
      
      // Notify if ChatScreen is open
      if (this.messageListener) {
        const shouldNotify = isBroadcast ? 
          this.currentChatId === 'broadcast' : 
          this.currentChatId === message.senderId;
        
        if (shouldNotify) {
          this.messageListener(message);
        }
      }
      
      // Show notification if needed
      if (!isAppActive || !this.messageListener) {
        this.showNotification(message);
      }
      
      // Emit new message event
      this.emitEvent('onNewMessage', {
        message,
        isBroadcast
      });
      
    } catch (error) {
      console.error('❌ Error handling incoming message:', error);
    }
  }

  // ============ PUBLIC API ============

  async initialize(apiKey) {
    console.log('🚀 Initializing Bridgefy with SQLite...');
    try {
      await Bridgefy.initialize(apiKey);
      return true;
    } catch (error) {
      console.error('❌ Bridgefy initialization failed:', error);
      throw error;
    }
  }

  async sendMessage(receiverId, text) {
    try {
      console.log(`📤 Sending to ${receiverId}: ${text}`);
      const response = await Bridgefy.sendMessage(receiverId, text);
      
      // Create database message
      const dbMessage = {
        id: response.id || `sent_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        content: text,
        sender_id: this.myDeviceId,
        sender_name: this.myDeviceName,
        receiver_id: receiverId,
        message_type: 'direct',
        is_mine: true,
        is_broadcast: false,
        timestamp: Date.now(),
        read_status: 1, // sent messages are read
        delivery_status: 'sent'
      };

      // Save to database
      await databaseService.saveMessage(dbMessage);
      
      // Return app format message
      return {
        id: dbMessage.id,
        text: text,
        senderId: this.myDeviceId,
        senderName: this.myDeviceName,
        receiverId: receiverId,
        timestamp: Date.now(),
        isMine: true,
        isBroadcast: false,
        type: 'text',
        read: true
      };
    } catch (error) {
      console.error('❌ Send message failed:', error);
      throw error;
    }
  }

  async sendBroadcast(text) {
    try {
      console.log(`📢 Broadcasting: ${text}`);
      const response = await Bridgefy.sendBroadcast(text);
      
      // Create database message
      const dbMessage = {
        id: response.id || `broadcast_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        content: text,
        sender_id: this.myDeviceId,
        sender_name: this.myDeviceName,
        receiver_id: null,
        message_type: 'broadcast',
        is_mine: true,
        is_broadcast: true,
        timestamp: Date.now(),
        read_status: 1,
        delivery_status: 'sent'
      };

      // Save to database
      await databaseService.saveMessage(dbMessage);
      
      return {
        id: dbMessage.id,
        text: text,
        senderId: this.myDeviceId,
        senderName: this.myDeviceName,
        timestamp: Date.now(),
        isMine: true,
        isBroadcast: true,
        type: 'text',
        read: true
      };
    } catch (error) {
      console.error('❌ Broadcast failed:', error);
      throw error;
    }
  }

  async getConnectedDevices() {
    try {
      const devices = await databaseService.getAllDevices();
      // Filter out my own device and offline devices
      const onlineDevices = devices.filter(device => 
        device.id !== this.myDeviceId && device.connection_status === 'online'
      );
      
      // Update local map
      onlineDevices.forEach(device => {
        this.connectedDevices.set(device.id, device.name);
      });
      
      return onlineDevices.map(device => ({ id: device.id, name: device.name }));
    } catch (error) {
      console.error('❌ Error getting devices:', error);
      return Array.from(this.connectedDevices.entries()).map(([id, name]) => ({ id, name }));
    }
  }

  async getConversations() {
    try {
      const dbConversations = await databaseService.getConversations();
      
      return dbConversations.map(conv => ({
        id: conv.id,
        name: conv.name,
        lastMessage: conv.lastMessage,
        timestamp: conv.timestamp,
        unreadCount: conv.unreadCount,
        type: conv.type,
        isBroadcast: conv.isBroadcast,
        senderName: conv.name
      }));
    } catch (error) {
      console.error('❌ Error getting conversations:', error);
      return [];
    }
  }

  async getMessages(deviceId = null, isBroadcast = false, limit = 100) {
    try {
      const messageType = isBroadcast ? 'broadcast' : 'direct';
      const messages = await databaseService.getMessages(deviceId, messageType, limit);
      return messages;
    } catch (error) {
      console.error('❌ Error getting messages:', error);
      return [];
    }
  }

  async markAsRead(deviceId, isBroadcast = false) {
    try {
      await databaseService.markMessagesAsRead(deviceId, isBroadcast ? 'broadcast' : 'direct');
      this.emitEvent('onUnreadUpdated', await this.getUnreadCounts());
      return true;
    } catch (error) {
      console.error('❌ Error marking as read:', error);
      throw error;
    }
  }

  async getUnreadCounts() {
    try {
      const broadcastUnread = await databaseService.getUnreadCount(null, 'broadcast');
      const directUnread = await databaseService.getUnreadCount();
      const total = broadcastUnread + directUnread;
      
      return { broadcast: broadcastUnread, direct: directUnread, total };
    } catch (error) {
      console.error('❌ Error getting unread counts:', error);
      return { broadcast: 0, direct: 0, total: 0 };
    }
  }

  async clearAllData() {
    try {
      await databaseService.clearAllMessages();
      this.connectedDevices.clear();
      this.emitEvent('onDataCleared', {});
      console.log('🗑️ All data cleared from SQLite');
      return true;
    } catch (error) {
      console.error('❌ Error clearing data:', error);
      throw error;
    }
  }

  async getDatabaseStats() {
    try {
      const messageCount = await databaseService.getMessageCount();
      const dbSize = await databaseService.getDatabaseSize();
      const conversations = await databaseService.getConversations();
      
      return {
        messageCount,
        dbSizeBytes: dbSize,
        dbSizeMB: (dbSize / (1024 * 1024)).toFixed(2),
        conversationCount: conversations.length,
        deviceCount: this.connectedDevices.size
      };
    } catch (error) {
      console.error('❌ Error getting database stats:', error);
      return null;
    }
  }

  async saveMessageToStorage(message) {
    if (!this.useAsyncStorage) {
      try {
        return await databaseService.saveMessage(message);
      } catch (error) {
        console.error('Database save failed, falling back to AsyncStorage:', error);
        this.useAsyncStorage = true;
      }
    }
    
    // AsyncStorage fallback
    return this.saveMessageToAsyncStorage(message);
  }

  async saveMessageToAsyncStorage(message) {
    // Your existing AsyncStorage logic
    try {
      const key = message.isBroadcast ? '@broadcast_messages' : `@messages_${message.senderId}`;
      const existing = await AsyncStorage.getItem(key);
      const messages = existing ? JSON.parse(existing) : [];
      messages.unshift(message);
      await AsyncStorage.setItem(key, JSON.stringify(messages.slice(0, 1000)));
      return message;
    } catch (error) {
      console.error('AsyncStorage save failed:', error);
      throw error;
    }
  }


  // ... rest of the methods remain the same (getMyDeviceId, getMyDeviceName, etc.)

  setCurrentChat(deviceId) {
    this.currentChatId = deviceId;
  }

  setMessageListener(callback) {
    this.messageListener = callback;
  }

  setOnNewMessageHandler(callback) {
    this.onNewMessageHandler = callback;
  }

  setOnReadyHandler(callback) {
    this.onReadyHandler = callback;
  }

  setOnErrorHandler(callback) {
    this.onErrorHandler = callback;
  }

  setOnUnreadUpdatedHandler(callback) {
    this.onUnreadUpdatedHandler = callback;
  }

  emitEvent(eventName, data) {
    if (this[`${eventName}Handler`]) {
      this[`${eventName}Handler`](data);
    }
  }

  async stop() {
    try {
      await Bridgefy.stop();
      await databaseService.close();
      this.isInitialized = false;
      return true;
    } catch (error) {
      console.error('❌ Stop failed:', error);
      throw error;
    }
  }
}

// Export singleton instance
export default new BridgefyService();