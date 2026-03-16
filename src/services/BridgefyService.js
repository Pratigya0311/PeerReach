// src/services/BridgefyService.js - UPDATED FOR SQLITE
import { NativeModules, NativeEventEmitter, Platform, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import databaseService from './DatabaseService';

const { Bridgefy } = NativeModules;
const bridgefyEmitter = new NativeEventEmitter(Bridgefy);

const ANNOUNCE_INTERVAL_MS = 90000;
const ANNOUNCE_TTL_MS = 180000;
const MAX_HOPS = 5;

class BridgefyService {
  constructor() {
    this.deviceListListener = null;
    this.messageListener = null;
    this.backgroundMessageHandler = null;
    this.connectedDevices = new Map();
    this.myDeviceId = null;
    this.myDeviceName = Platform.OS === 'android' ? Bridgefy.deviceName || 'Android Device' : 'iOS Device';
    this.isInitialized = false;
    this.isInitializing = false;
    this.currentChatId = null;
    this.useAsyncStorage = false;
    this.seenAnnounces = new Map();
    this.announceTimer = null;
    this.sendCooldowns = new Map();
    this.pendingSendMap = new Map();
    this.lastApiKey = null;
    this.healthTimer = null;
    this.isRestarting = false;
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

      this.startAnnounceLoop();
      this.sendAnnounce('online', 0);
      this.flushQueuedMessages();
      
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

      this.sendAnnounce('online', 0);
      this.flushQueuedMessages();
        
        this.emitEvent('onDeviceConnected', device);
      }
    });

    bridgefyEmitter.addListener('onDeviceLost', async (device) => {
      console.log('📱 Device lost:', device);
      if (device.userId) {
        this.connectedDevices.delete(device.userId);
        
        // Update status in database
        await databaseService.updateDeviceStatus(device.userId, 'offline');
        await databaseService.markKnownUsersStaleByViaPeer(device.userId);
        
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

    bridgefyEmitter.addListener('onRegistrationFailed', (error) => {
      console.error('âŒ Bridgefy registration failed:', error);
      this.emitEvent('onError', error);
    });

    bridgefyEmitter.addListener('onDeviceListUpdated', async (data) => {
      console.log('ðŸ“± Device list updated:', data?.devices?.length);
      if (data?.devices && Array.isArray(data.devices)) {
        for (const device of data.devices) {
          if (device.id && device.name) {
            this.connectedDevices.set(device.id, device.name);
            await databaseService.saveDevice({
              id: device.id,
              name: device.name,
              connection_status: 'online'
            });
          }
        }
        this.emitEvent('onDeviceListUpdated', {
          devices: Array.from(this.connectedDevices.entries()).map(([id, name]) => ({ id, name }))
        });
      }
    });

    bridgefyEmitter.addListener('onMessageSent', (data) => {
      console.log('Message sent:', data);
      if (data?.messageId) {
        this.pendingSendMap.delete(data.messageId);
      }
      this.emitEvent('onMessageSent', data);
    });

    bridgefyEmitter.addListener('onMessageSendFailed', (error) => {
      console.error('Message send failed:', error);
      const receiverId = error?.receiverId || (error?.messageId ? this.pendingSendMap.get(error.messageId) : null);
      if (receiverId) {
        this.applySendFailure(receiverId);
      }
      this.sendAnnounce('online', 0);
      this.ensureHealth();
      this.emitEvent('onMessageSendFailed', error);
    });

    bridgefyEmitter.addListener('onStarted', () => {
      console.log('ðŸš€ Bridgefy service started');
      this.emitEvent('onStarted', {});
    });

    bridgefyEmitter.addListener('onStartError', (error) => {
      console.error('âŒ Bridgefy start error:', error);
      this.emitEvent('onStartError', error);
    });

    bridgefyEmitter.addListener('onStopped', () => {
      console.log('Bridgefy service stopped');
      this.stopAnnounceLoop();
      this.emitEvent('onStopped', {});
    });
  }

  async handleIncomingMessage(rawMessage, isBroadcast) {
    try {
      if (rawMessage && rawMessage.type === 'announce') {
        await this.handleAnnounce(rawMessage);
        return;
      }
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
  startAnnounceLoop() {
    if (this.announceTimer) return;
    this.announceTimer = setInterval(async () => {
      this.pruneAnnounces();
      this.sendAnnounce('online', 0);
      this.flushQueuedMessages();
      await this.pruneKnownUsers();
    }, ANNOUNCE_INTERVAL_MS);
  }

  stopAnnounceLoop() {
    if (this.announceTimer) {
      clearInterval(this.announceTimer);
      this.announceTimer = null;
    }
  }

  pruneAnnounces() {
    const now = Date.now();
    const maxAge = ANNOUNCE_TTL_MS * 2;
    for (const [id, ts] of this.seenAnnounces.entries()) {
      if (now - ts > maxAge) {
        this.seenAnnounces.delete(id);
      }
    }
  }

  async pruneKnownUsers() {
    try {
      const expireBefore = Date.now() - ANNOUNCE_TTL_MS;
      await databaseService.pruneKnownUsers(expireBefore);
    } catch (error) {
      console.error('Error pruning known users:', error);
    }
  }

  async sendAnnounce(status, hop) {
    try {
      if (!this.isInitialized || !this.myDeviceId) return;
      const announceId = `${this.myDeviceId}:${Date.now()}`;
      const payload = {
        type: 'announce',
        text: '',
        userId: this.myDeviceId,
        userName: this.myDeviceName,
        status: status,
        hop: hop,
        announceId: announceId,
        ts: Date.now()
      };
      if (Bridgefy.sendBroadcastPayload) {
        await Bridgefy.sendBroadcastPayload(JSON.stringify(payload));
      }
    } catch (error) {
      console.error('Error sending announce:', error);
      if (String(error?.message || '').includes('USER_NOT_INITIALIZED')) {
        this.stopAnnounceLoop();
      }
    }
  }

  async handleAnnounce(rawMessage) {
    try {
      const announceId = rawMessage.announceId;
      if (!announceId) return;
      if (this.seenAnnounces.has(announceId)) return;
      this.seenAnnounces.set(announceId, Date.now());

      const userId = rawMessage.userId;
      const userName = rawMessage.userName || 'Unknown Device';
      const hop = parseInt(rawMessage.hop, 10) || 0;
      const distance = hop + 1;
      const senderId = rawMessage.senderId || null;
      const status = rawMessage.status || 'online';

      if (!userId || userId === this.myDeviceId) return;

      await databaseService.upsertKnownUser({
        id: userId,
        name: userName,
        last_seen: Date.now(),
        hops: distance,
        via_peer: senderId,
        is_online: status === 'online' ? 1 : 0
      });

      if (distance < MAX_HOPS) {
        const forwardPayload = {
          type: 'announce',
          text: '',
          userId: userId,
          userName: userName,
          status: status,
          hop: hop + 1,
          announceId: announceId,
          ts: rawMessage.ts || Date.now()
        };
        if (Bridgefy.sendBroadcastPayload) {
          await Bridgefy.sendBroadcastPayload(JSON.stringify(forwardPayload));
        }
      }
    } catch (error) {
      console.error('Error handling announce:', error);
    }
  }
  isInCooldown(receiverId) {
    const until = this.sendCooldowns.get(receiverId);
    return until && Date.now() < until;
  }

  applySendFailure(receiverId) {
    const cooldownMs = 60000;
    this.sendCooldowns.set(receiverId, Date.now() + cooldownMs);
    databaseService.upsertKnownUser({
      id: receiverId,
      name: this.connectedDevices.get(receiverId) || 'Unknown Device',
      last_seen: Date.now(),
      hops: 0,
      via_peer: null,
      is_online: 0
    }).catch(() => {});
  }

  async queueOutgoingMessage(receiverId, text) {
    const dbMessage = {
      id: `queued_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      content: text,
      sender_id: this.myDeviceId,
      sender_name: this.myDeviceName,
      receiver_id: receiverId,
      message_type: 'direct',
      is_mine: true,
      is_broadcast: false,
      timestamp: Date.now(),
      read_status: 1,
      delivery_status: 'queued'
    };
    await databaseService.saveMessage(dbMessage);
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
      read: true,
      deliveryStatus: 'queued'
    };
  }

  startHealthCheck() {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => {
      this.ensureHealth();
    }, 30000);
  }

  stopHealthCheck() {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  async ensureHealth() {
    try {
      if (this.isRestarting) return;
      if (!this.isInitialized || !this.lastApiKey) return;
      const id = await this.getMyDeviceId();
      if (!id || id === 'initializing...') {
        this.isRestarting = true;
        this.emitEvent('onReconnecting', { reason: 'health-check' });
        await Bridgefy.stop();
        this.isInitialized = false;
        await this.initialize(this.lastApiKey);
        this.startAnnounceLoop();
        this.sendAnnounce('online', 0);
        this.flushQueuedMessages();
        this.isRestarting = false;
        this.emitEvent('onReconnected', {});
      }
    } catch (error) {
      this.isRestarting = false;
    }
  }

  async sendDirectRaw(receiverId, text) {
    const response = await Bridgefy.sendMessage(receiverId, text);
      if (response?.id) {
        this.pendingSendMap.set(response.id, receiverId);
      }
    return response;
  }

  async sendMeshRaw(receiverId, text) {
    if (!Bridgefy.sendMeshMessage) {
      throw new Error('Mesh send not available');
    }
    const response = await Bridgefy.sendMeshMessage(receiverId, text);
        if (response?.id) {
          this.pendingSendMap.set(response.id, receiverId);
        }
    return response;
  }

  async flushQueuedMessages(receiverId = null) {
    const queued = await databaseService.getQueuedMessages(receiverId);
    for (const msg of queued) {
      try {
        if (this.isInCooldown(msg.receiverId)) {
          continue;
        }
        if (!this.isDirectDevice(msg.receiverId)) {
          await this.sendMeshRaw(msg.receiverId, msg.text);
        } else {
          await this.sendDirectRaw(msg.receiverId, msg.text);
        }
        await databaseService.updateMessageStatus(msg.id, 'sent');
      } catch (error) {
        this.applySendFailure(msg.receiverId);
      }
    }
  }
  showNotification(message) {
    console.log(
      `ðŸ”” NEW ${message.isBroadcast ? 'BROADCAST' : 'MESSAGE'} from ${message.senderName}: ${message.text.substring(0, 50)}...`
    );
  }

  handleAppStateChange(nextState) {
    // Pause background work when not active; refresh unread counts on resume.
    if (nextState === 'active') {
      this.emitEvent('onUnreadUpdated', this.getUnreadCounts());
      if (this.isInitialized) {
        this.startAnnounceLoop();
        this.sendAnnounce('online', 0);
        this.flushQueuedMessages();
        this.startHealthCheck();
      }
      return;
    }

    if (nextState === 'background' || nextState === 'inactive') {
      if (this.isInitialized) {
        this.sendAnnounce('offline', 0);
        this.stopAnnounceLoop();
        this.stopHealthCheck();
      }
      if (this.currentChatId !== null) {
        this.currentChatId = null;
      }
    }
  }

  // ============ PUBLIC API ============

  async initialize(apiKey) {
    console.log('Initializing Bridgefy with SQLite...');
    try {
      if (this.isInitialized || this.isInitializing) {
        return true;
      }
      this.lastApiKey = apiKey;
      this.isInitializing = true;
      await Bridgefy.initialize(apiKey);
      return true;
    } catch (error) {
      console.error('Bridgefy initialization failed:', error);
      throw error;
    } finally {
      this.isInitializing = false;
    }
  }

  async sendMessage(receiverId, text) {
    try {
      console.log(`📤 Sending to ${receiverId}: ${text}`);
      if (this.isInCooldown(receiverId)) {
        return this.queueOutgoingMessage(receiverId, text);
      }
      const response = await Bridgefy.sendMessage(receiverId, text);
      if (response?.id) {
        this.pendingSendMap.set(response.id, receiverId);
      }
      
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
      console.error('Send message failed:', error);
      return this.queueOutgoingMessage(receiverId, text);
    }
  }
  async sendMeshMessage(receiverId, text) {
    try {
      console.log(`Sending mesh to ${receiverId}: ${text}`);
      if (this.isInCooldown(receiverId)) {
        return this.queueOutgoingMessage(receiverId, text);
      }
      if (Bridgefy.sendMeshMessage) {
        const response = await Bridgefy.sendMeshMessage(receiverId, text);
        if (response?.id) {
          this.pendingSendMap.set(response.id, receiverId);
        }
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
          read_status: 1,
          delivery_status: 'sent'
        };

        await databaseService.saveMessage(dbMessage);
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
      }
      return this.queueOutgoingMessage(receiverId, text);
    } catch (error) {
      console.error('Mesh send failed:', error);
      return this.queueOutgoingMessage(receiverId, text);
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
      const devices = await Bridgefy.getConnectedDevices();
      if (devices && Array.isArray(devices)) {
        for (const device of devices) {
          if (device.id && device.name) {
            this.connectedDevices.set(device.id, device.name);
            await databaseService.saveDevice({
              id: device.id,
              name: device.name,
              connection_status: 'online'
            });
          }
        }
      }
      return Array.from(this.connectedDevices.entries()).map(([id, name]) => ({ id, name }));
    } catch (error) {
      console.error('❌ Error getting devices from Bridgefy, using database cache:', error);
      try {
        const devices = await databaseService.getAllDevices();
        const onlineDevices = devices.filter(device =>
          device.id !== this.myDeviceId && device.connection_status === 'online'
        );
        onlineDevices.forEach(device => {
          this.connectedDevices.set(device.id, device.name);
        });
        return onlineDevices.map(device => ({ id: device.id, name: device.name }));
      } catch (dbError) {
        console.error('❌ Error getting devices from database:', dbError);
        return Array.from(this.connectedDevices.entries()).map(([id, name]) => ({ id, name }));
      }
    }
  }
  async getReachableUsers() {
    try {
      const minLastSeen = Date.now() - ANNOUNCE_TTL_MS;
      const users = await databaseService.getKnownUsers(minLastSeen);
      const directIds = new Set(this.connectedDevices.keys());
      return users
        .filter(u => u.id !== this.myDeviceId && !directIds.has(u.id))
        .map(u => ({
          id: u.id,
          name: u.name,
          hops: u.hops,
          lastSeen: u.last_seen,
          viaPeer: u.via_peer
        }));
    } catch (error) {
      console.error('Error getting reachable users:', error);
      return [];
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

  isDirectDevice(deviceId) {
    return this.connectedDevices.has(deviceId);
  }

  async getMyDeviceId() {
    try {
      const id = await Bridgefy.getMyDeviceId();
      if (id && id !== 'initializing...') {
        this.myDeviceId = id;
      }
      return id || this.myDeviceId || 'unknown';
    } catch (error) {
      return this.myDeviceId || 'unknown';
    }
  }

  async getMyDeviceName() {
    try {
      const name = await Bridgefy.getMyDeviceName();
      if (name) {
        this.myDeviceName = name;
      }
      return name || this.myDeviceName;
    } catch (error) {
      return this.myDeviceName;
    }
  }

  setDeviceListListener(callback) {
    this.deviceListListener = callback;
    this.onDeviceListUpdatedHandler = callback;
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

  setOnReconnectingHandler(callback) {
    this.onReconnectingHandler = callback;
  }

  setOnReconnectedHandler(callback) {
    this.onReconnectedHandler = callback;
  }

  emitEvent(eventName, data) {
    if (this[`${eventName}Handler`]) {
      this[`${eventName}Handler`](data);
    }
  }

  async stop() {
    try {
      this.stopHealthCheck();
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
