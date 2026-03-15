// src/services/BridgefyService.js - UPDATED FOR SQLITE + GATEWAY
import { NativeModules, NativeEventEmitter, Platform, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import databaseService from './DatabaseService';
import gatewayService from './GatewayService';

const DISPLAY_NAME_KEY = '@peerreach_display_name';

const { Bridgefy } = NativeModules;

if (!Bridgefy) {
  console.error('❌ Bridgefy native module is NULL — the .aar may not have loaded correctly');
}

const bridgefyEmitter = Bridgefy ? new NativeEventEmitter(Bridgefy) : { addListener: () => ({}) };

class BridgefyService {
  constructor() {
    this.messageListener = null;
    this.connectedDevices = new Map();
    this.myDeviceId = null;
    this.myDeviceName = Platform.OS === 'android' ? (Bridgefy?.deviceName || 'Android Device') : 'iOS Device';
    this.isInitialized = false;
    this.isInitializing = false;
    this.currentChatId = null;
    // Initialize database and load saved display name
    this.initializeDatabase();
    this._loadDisplayName();

    // Wire up gateway service
    gatewayService.init(this);

    // Set up event listeners
    this.setupEventListeners();
    
    // Listen for app state changes
    this._appStateHandler = this.handleAppStateChange.bind(this);
    this._appStateSubscription = AppState.addEventListener('change', this._appStateHandler);
  }

  async initializeDatabase() {
    try {
      await databaseService.initialize();
      console.log('✅ Database ready');
    } catch (error) {
      console.error('❌ Database initialization failed:', error);
    }
  }

  setupEventListeners() {
    // Registration events
    bridgefyEmitter.addListener('onRegistrationSuccessful', async (data) => {
      try {
        console.log('✅ Bridgefy registered:', data);
        this.myDeviceId = data.userUuid;
        // Use hardware name as fallback only; custom display name takes priority
        const hwName = data.deviceName || this.myDeviceName;
        const saved = await AsyncStorage.getItem(DISPLAY_NAME_KEY).catch(() => null);
        this.myDeviceName = (saved && saved.trim()) ? saved.trim() : hwName;
        this.isInitialized = true;
        gatewayService.setMyDeviceId(this.myDeviceId);
        await databaseService.saveDevice({
          id: this.myDeviceId,
          name: this.myDeviceName,
          connection_status: 'online'
        });
        this.emitEvent('onReady', { deviceId: this.myDeviceId, deviceName: this.myDeviceName });
      } catch (err) {
        console.error('❌ onRegistrationSuccessful error:', err);
        // Still emit ready even if DB save fails — mesh can work without it
        this.emitEvent('onReady', { deviceId: this.myDeviceId, deviceName: this.myDeviceName });
      }
    });

    // Device connection events
    bridgefyEmitter.addListener('onDeviceConnected', async (device) => {
      try {
        console.log('📱 Device connected:', device);
        if (device.userId) {
          this.connectedDevices.set(device.userId, device.deviceName || `Device_${device.userId.substring(0, 8)}`);
          await databaseService.saveDevice({
            id: device.userId,
            name: device.deviceName || `Device_${device.userId.substring(0, 8)}`,
            connection_status: 'online'
          });
          this.emitEvent('onDeviceConnected', device);
        }
      } catch (err) {
        console.error('❌ onDeviceConnected error:', err);
      }
    });

    bridgefyEmitter.addListener('onDeviceLost', async (device) => {
      try {
        console.log('📱 Device lost:', device);
        if (device.userId) {
          this.connectedDevices.delete(device.userId);
          await databaseService.updateDeviceStatus(device.userId, 'offline');
          this.emitEvent('onDeviceLost', device);
        }
      } catch (err) {
        console.error('❌ onDeviceLost error:', err);
      }
    });

    // Message events
    bridgefyEmitter.addListener('onMessageReceived', async (rawMessage) => {
      try {
        console.log('📨 Direct message received:', rawMessage);
        await this.handleIncomingMessage(rawMessage, false);
      } catch (err) {
        console.error('❌ onMessageReceived error:', err);
      }
    });

    bridgefyEmitter.addListener('onBroadcastMessageReceived', async (rawMessage) => {
      try {
        console.log('📢 Broadcast message received:', rawMessage);
        await this.handleIncomingMessage(rawMessage, true);
      } catch (err) {
        console.error('❌ onBroadcastMessageReceived error:', err);
      }
    });

    bridgefyEmitter.addListener('onRegistrationFailed', (error) => {
      console.warn("⚠️ Bridgefy registration failed:", error);
      this.emitEvent('onError', error);
    });

    bridgefyEmitter.addListener('onDeviceListUpdated', async (data) => {
      try {
        console.log('ðŸ”± Device list updated:', data?.devices?.length);
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
      } catch (err) {
        console.error('❌ onDeviceListUpdated error:', err);
      }
    });

    bridgefyEmitter.addListener('onMessageSent', (data) => {
      console.log('âœ… Message sent:', data);
      this.emitEvent('onMessageSent', data);
    });

    bridgefyEmitter.addListener('onMessageSendFailed', (error) => {
      console.error('âŒ Message send failed:', error);
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
      console.log('ðŸ›‘ Bridgefy service stopped');
      this.emitEvent('onStopped', {});
    });
  }

  async handleIncomingMessage(rawMessage, isBroadcast) {
    try {
      const rawContent = rawMessage.content || '';

      // Intercept protocol messages — don't save to chat DB
      if (rawContent) {
        try {
          const parsed = JSON.parse(rawContent);
          if (
            parsed.type === 'internet_request' ||
            parsed.type === 'internet_response' ||
            parsed.type === 'cache_share'
          ) {
            await gatewayService.handleIncomingGatewayMessage(parsed, rawMessage.senderId);
            return;
          }
          // Typing indicator — ephemeral, never stored
          if (parsed.type === 'typing') {
            const senderId = rawMessage.senderId || parsed.senderId;
            const senderName = parsed.senderName || this.connectedDevices.get(senderId) || 'Someone';
            this.emitEvent('onTyping', { senderId, senderName, isBroadcast });
            return;
          }
        } catch {
          // Not JSON — treat as regular chat message below
        }
      }

      const messageType = isBroadcast ? 'broadcast' : 'direct';
      const senderId = rawMessage.senderId || 'unknown';
      const senderName = rawMessage.senderName || this.connectedDevices.get(senderId) || 'Unknown Device';

      // Detect photo / location content types
      let contentType = 'text';
      let mediaData = null;
      if (rawContent.startsWith('{')) {
        try {
          const parsed = JSON.parse(rawContent);
          if (parsed.type === 'photo' || parsed.type === 'location') {
            contentType = parsed.type;
            mediaData = parsed;
          }
        } catch (_e) { /* not JSON */ }
      }

      // Create database message object — store full JSON for photo/location
      const dbMessage = {
        id: rawMessage.messageId || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
        content: rawContent,
        sender_id: senderId,
        sender_name: senderName,
        receiver_id: isBroadcast ? null : this.myDeviceId,
        message_type: messageType,
        is_mine: false,
        is_broadcast: isBroadcast,
        timestamp: parseInt(rawMessage.timestamp) || Date.now(),
        read_status: 0,
        delivery_status: 'delivered'
      };

      // Save to database
      const savedMessage = await databaseService.saveMessage(dbMessage);

      // Convert to app message format
      const message = {
        id: savedMessage.id,
        text: mediaData?.text || rawContent,
        contentType,
        mediaData,
        senderId: savedMessage.sender_id,
        senderName: savedMessage.sender_name,
        receiverId: savedMessage.receiver_id,
        timestamp: savedMessage.timestamp,
        isMine: false,
        isBroadcast: isBroadcast,
        type: messageType,
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

  showNotification(message) {
    const preview = (message.text || `[${message.contentType || 'message'}]`).substring(0, 50);
    console.log(`ðŸ”” NEW ${message.isBroadcast ? 'BROADCAST' : 'MESSAGE'} from ${message.senderName}: ${preview}...`);
  }

  handleAppStateChange(nextState) {
    // Pause background work when not active; refresh unread counts on resume.
    if (nextState === 'active') {
      this.getUnreadCounts()
        .then(counts => this.emitEvent('onUnreadUpdated', counts))
        .catch(err => console.error('❌ getUnreadCounts error:', err));
      return;
    }

    if (nextState === 'background' || nextState === 'inactive') {
      if (this.currentChatId !== null) {
        this.currentChatId = null;
      }
    }
  }

  // ============ PRIVATE HELPERS ============

  // Builds the DB row for any outbound message.
  _buildDbMessage({ responseId, content, receiverId = null, messageType, isBroadcast = false, replyToId = null, replyPreview = null }) {
    const prefix = isBroadcast ? 'broadcast' : 'sent';
    return {
      id: responseId || `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
      content,
      sender_id: this.myDeviceId,
      sender_name: this.myDeviceName,
      receiver_id: receiverId,
      message_type: messageType,
      is_mine: true,
      is_broadcast: isBroadcast,
      timestamp: Date.now(),
      read_status: 1,
      delivery_status: 'sent',
      reply_to_id: replyToId,
      reply_preview: replyPreview,
    };
  }

  // Converts a saved DB row back to the app message format used by screens.
  _buildAppMessage(dbMsg, { contentType = 'text', mediaData = null, text = null } = {}) {
    // For photo/location the content is a JSON blob — extract the human-readable text field.
    let resolvedText = text;
    if (!resolvedText) {
      if (contentType !== 'text' && dbMsg.content && dbMsg.content.startsWith('{')) {
        try { resolvedText = JSON.parse(dbMsg.content).text || dbMsg.content; } catch (_e) { resolvedText = dbMsg.content; }
      } else {
        resolvedText = dbMsg.content;
      }
    }
    return {
      id: dbMsg.id,
      text: resolvedText,
      contentType,
      mediaData,
      senderId: dbMsg.sender_id,
      senderName: dbMsg.sender_name,
      receiverId: dbMsg.receiver_id,
      timestamp: dbMsg.timestamp,
      isMine: true,
      isBroadcast: dbMsg.is_broadcast,
      type: dbMsg.message_type,
      read: true,
      replyToId: dbMsg.reply_to_id || null,
      replyPreview: dbMsg.reply_preview || null,
    };
  }

  // ============ PUBLIC API ============

  async initialize(apiKey) {
    console.log('Initializing Bridgefy with SQLite...');
    if (!Bridgefy) throw new Error('Bridgefy native module not loaded. Check that the AAR is properly linked.');
    try {
      if (this.isInitialized || this.isInitializing) {
        return true;
      }
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

  async sendMessage(receiverId, text, replyTo = null) {
    if (!this.myDeviceId) throw new Error('Mesh not ready — please wait for initialization');
    try {
      console.log(`📤 Sending to ${receiverId}: ${text}`);
      const response = await Bridgefy.sendMessage(receiverId, text);
      const dbMsg = this._buildDbMessage({
        responseId: response.id,
        content: text,
        receiverId,
        messageType: 'direct',
        replyToId: replyTo?.id || null,
        replyPreview: replyTo ? `${replyTo.senderName}: ${replyTo.text}` : null,
      });
      await databaseService.saveMessage(dbMsg);
      return this._buildAppMessage(dbMsg);
    } catch (error) {
      console.error('❌ Send message failed:', error);
      throw error;
    }
  }

  async sendPhoto(receiverId, base64Data, width, height) {
    if (!this.myDeviceId) throw new Error('Mesh not ready — please wait for Bridgefy to initialize');
    try {
      const payload = JSON.stringify({
        type: 'photo', text: '[Photo]',
        senderId: this.myDeviceId, senderName: this.myDeviceName,
        timestamp: Date.now(), isBroadcast: false,
        data: base64Data, width, height,
      });
      const response = await Bridgefy.sendPayload(receiverId, payload);
      const dbMsg = this._buildDbMessage({ responseId: response.id, content: payload, receiverId, messageType: 'direct' });
      await databaseService.saveMessage(dbMsg);
      return this._buildAppMessage(dbMsg, { contentType: 'photo', mediaData: { data: base64Data, width, height } });
    } catch (error) {
      console.error('❌ Send photo failed:', error);
      throw error;
    }
  }

  async sendLocation(receiverId, lat, lng) {
    if (!this.myDeviceId) throw new Error('Mesh not ready — please wait for Bridgefy to initialize');
    try {
      const payload = JSON.stringify({
        type: 'location', text: '[Location]',
        senderId: this.myDeviceId, senderName: this.myDeviceName,
        timestamp: Date.now(), isBroadcast: false, lat, lng,
      });
      const response = await Bridgefy.sendPayload(receiverId, payload);
      const dbMsg = this._buildDbMessage({ responseId: response.id, content: payload, receiverId, messageType: 'direct' });
      await databaseService.saveMessage(dbMsg);
      return this._buildAppMessage(dbMsg, { contentType: 'location', mediaData: { lat, lng } });
    } catch (error) {
      console.error('❌ Send location failed:', error);
      throw error;
    }
  }

  async sendBroadcastPhoto(base64Data, width, height) {
    if (!this.myDeviceId) throw new Error('Mesh not ready — please wait for Bridgefy to initialize');
    try {
      const payload = JSON.stringify({
        type: 'photo', text: '[Photo]',
        senderId: this.myDeviceId, senderName: this.myDeviceName,
        timestamp: Date.now(), isBroadcast: true,
        data: base64Data, width, height,
      });
      const response = await Bridgefy.sendBroadcastPayload(payload);
      const dbMsg = this._buildDbMessage({ responseId: response.id, content: payload, messageType: 'broadcast', isBroadcast: true });
      await databaseService.saveMessage(dbMsg);
      return this._buildAppMessage(dbMsg, { contentType: 'photo', mediaData: { data: base64Data, width, height } });
    } catch (error) {
      console.error('❌ Broadcast photo failed:', error);
      throw error;
    }
  }

  async sendBroadcastLocation(lat, lng) {
    if (!this.myDeviceId) throw new Error('Mesh not ready — please wait for Bridgefy to initialize');
    try {
      const payload = JSON.stringify({
        type: 'location', text: '[Location]',
        senderId: this.myDeviceId, senderName: this.myDeviceName,
        timestamp: Date.now(), isBroadcast: true, lat, lng,
      });
      const response = await Bridgefy.sendBroadcastPayload(payload);
      const dbMsg = this._buildDbMessage({ responseId: response.id, content: payload, messageType: 'broadcast', isBroadcast: true });
      await databaseService.saveMessage(dbMsg);
      return this._buildAppMessage(dbMsg, { contentType: 'location', mediaData: { lat, lng } });
    } catch (error) {
      console.error('❌ Broadcast location failed:', error);
      throw error;
    }
  }

  async sendBroadcast(text, replyTo = null) {
    if (!this.myDeviceId) throw new Error('Mesh not ready — please wait for initialization');
    try {
      // Gateway protocol messages: send over BLE but never save to chat DB
      try {
        const parsed = JSON.parse(text);
        if (
          parsed.type === 'internet_request' ||
          parsed.type === 'internet_response' ||
          parsed.type === 'cache_share'
        ) {
          await Bridgefy.sendBroadcast(text);
          return {
            id: `gw_${Date.now()}`,
            text: '',
            contentType: 'text',
            mediaData: null,
            senderId: this.myDeviceId,
            senderName: this.myDeviceName,
            timestamp: Date.now(),
            isMine: true,
            isBroadcast: true,
            type: 'broadcast',
            read: true,
            isGatewayProtocol: true,
          };
        }
      } catch (_e) {
        // Not JSON — regular chat broadcast, fall through
      }

      console.log(`📢 Broadcasting: ${text}`);
      const response = await Bridgefy.sendBroadcast(text);
      const dbMsg = this._buildDbMessage({
        responseId: response.id,
        content: text,
        messageType: 'broadcast',
        isBroadcast: true,
        replyToId: replyTo?.id || null,
        replyPreview: replyTo ? `${replyTo.senderName}: ${replyTo.text}` : null,
      });
      await databaseService.saveMessage(dbMsg);
      return this._buildAppMessage(dbMsg);
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

  async searchMessages(query) {
    try {
      return await databaseService.searchMessages(query);
    } catch (error) {
      console.error('❌ Search failed:', error);
      return [];
    }
  }

  async deleteMessage(messageId) {
    return databaseService.deleteMessage(messageId);
  }

  async pinMessage(messageId, pinned) {
    return databaseService.pinMessage(messageId, pinned);
  }

  async getPinnedMessages(conversationId, isBroadcast) {
    return databaseService.getPinnedMessages(conversationId, isBroadcast);
  }

  async getMediaMessages(conversationId, isBroadcast) {
    return databaseService.getMediaMessages(conversationId, isBroadcast);
  }

  async clearChat(conversationId, isBroadcast) {
    return databaseService.deleteConversation(conversationId, isBroadcast ? 'broadcast' : 'direct');
  }

  async sendTypingIndicator(receiverId, isBroadcast) {
    if (!this.myDeviceId) return;
    try {
      const payload = JSON.stringify({ type: 'typing', senderId: this.myDeviceId, senderName: this.myDeviceName });
      if (isBroadcast) {
        await Bridgefy.sendBroadcast(payload);
      } else {
        await Bridgefy.sendPayload(receiverId, payload);
      }
    } catch (_e) { /* typing failures are silent */ }
  }

  setOnTypingHandler(callback) { this.onTypingHandler = callback; }

  async _loadDisplayName() {
    try {
      const saved = await AsyncStorage.getItem(DISPLAY_NAME_KEY);
      if (saved && saved.trim()) this.myDeviceName = saved.trim();
    } catch (_e) {}
  }

  async setDisplayName(name) {
    const trimmed = (name || '').trim();
    if (!trimmed) return;
    await AsyncStorage.setItem(DISPLAY_NAME_KEY, trimmed);
    this.myDeviceName = trimmed;
  }

  getDisplayName() { return this.myDeviceName; }

  setCurrentChat(deviceId) {
    this.currentChatId = deviceId;
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
      // Custom display name always wins over hardware name
      const custom = await AsyncStorage.getItem(DISPLAY_NAME_KEY).catch(() => null);
      if (custom && custom.trim()) {
        this.myDeviceName = custom.trim();
        return this.myDeviceName;
      }
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

  emitEvent(eventName, data) {
    if (this[`${eventName}Handler`]) {
      this[`${eventName}Handler`](data);
    }
  }

  async stop() {
    try {
      if (this._appStateSubscription) {
        this._appStateSubscription.remove();
        this._appStateSubscription = null;
      }
      gatewayService.destroy();
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


