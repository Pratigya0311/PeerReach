// src/services/BridgefyService.js - UPDATED FOR SQLITE + GATEWAY
import { NativeModules, NativeEventEmitter, Platform, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import databaseService from './DatabaseService';
import gatewayService from './GatewayService';
import weatherService from './WeatherService';

const DISPLAY_NAME_KEY = '@peerreach_display_name';

const { Bridgefy } = NativeModules;

if (!Bridgefy) {
  console.error('❌ Bridgefy native module is NULL — the .aar may not have loaded correctly');
}

const bridgefyEmitter = Bridgefy ? new NativeEventEmitter(Bridgefy) : { addListener: () => ({}) };

class BridgefyService {
  constructor() {
    this.messageListener = null;
    this.connectedDevices  = new Map();  // deviceId → name
    this.deviceBatteries   = new Map();  // deviceId → battery %
    this.deviceLastSeen    = new Map();  // deviceId → timestamp
    this.deviceLocations   = new Map();  // deviceId → {lat, lng, ts}
    this.myLocation        = null;       // {lat, lng, ts}
    this._locationInterval = null;
    this._batteryWarningSent = false;
    this.myDeviceId = null;
    this._apiKey = null;
    this._broadcastQueue  = [];
    this._broadcastRetry  = null;
    this.myDeviceName = Platform.OS === 'android' ? (Bridgefy?.deviceName || 'Android Device') : 'iOS Device';
    this.isInitialized = false;
    this.isInitializing = false;
    this.currentChatId = null;

    // Handlers for special events
    this.onFindMeUpdateHandler = null;
    this.onSOSHandler = null;

    // Initialize database and load saved display name
    this.initializeDatabase();
    this._loadDisplayName();

    // Wire up gateway and weather services
    gatewayService.init(this);
    weatherService.init(this);

    // Set up event listeners
    this.setupEventListeners();

    // Listen for app state changes
    this._appStateHandler = this.handleAppStateChange.bind(this);
    this._appStateSubscription = AppState.addEventListener('change', this._appStateHandler);

    // Start broadcast retry timer
    this._startBroadcastRetry();
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
        weatherService.setMyDeviceId(this.myDeviceId);
        await databaseService.saveDevice({
          id: this.myDeviceId,
          name: this.myDeviceName,
          connection_status: 'online'
        });
        this.emitEvent('onReady', { deviceId: this.myDeviceId, deviceName: this.myDeviceName });
        // Announce ourselves, start weather + location tracking
        setTimeout(() => this._sendAnnounce(), 2000);
        weatherService.startAutoRefresh();
        this._startLocationTracking();
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
          // Use hardware name only if we don't already have a display name from a prior announce
          const existing = this.connectedDevices.get(device.userId);
          const name = existing || device.deviceName || `Device_${device.userId.substring(0, 8)}`;
          this.connectedDevices.set(device.userId, name);
          this.deviceLastSeen.set(device.userId, Date.now());
          await databaseService.saveDevice({
            id: device.userId,
            name,
            connection_status: 'online',
            last_seen: Date.now(),
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
      // Timeouts and cancellations are normal when no peers are nearby — log as warn, not error
      const errMsg = error?.error || '';
      if (errMsg.includes('Timed out') || errMsg.includes('cancelled') || errMsg.includes('canceled')) {
        console.warn('⚠️ Send failed (no peers):', errMsg);
      } else {
        console.warn('⚠️ Message send failed:', error);
      }
      this.emitEvent('onMessageSendFailed', error);
    });

    bridgefyEmitter.addListener('onStarted', () => {
      console.log('ðŸš€ Bridgefy service started');
      this.emitEvent('onStarted', {});
    });

    bridgefyEmitter.addListener('onStartError', (error) => {
      console.error('onStartError:', JSON.stringify(error));
      this.emitEvent('onError', { ...error, isStartError: true });
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

          // Announce — ephemeral, update device info
          if (parsed.type === 'announce') {
            this._handleAnnounce(parsed, rawMessage.senderId);
            return;
          }

          // Battery warning — show as system message in active chats
          if (parsed.type === 'battery_warning') {
            this._handleAnnounce(parsed, rawMessage.senderId); // update battery map
            this.emitEvent('onBatteryWarning', { senderId: parsed.deviceId || rawMessage.senderId, name: parsed.name, battery: parsed.battery });
            return;
          }

          // Weather update — share through mesh, never store in chat
          if (parsed.type === 'weather_update') {
            weatherService.handleWeatherUpdate(parsed, rawMessage.senderId);
            return;
          }

          // Delivery / read ack — update sent message status
          if (parsed.type === 'ack') {
            this._handleAck(parsed);
            return;
          }
        } catch {
          // Not JSON — treat as regular chat message below
        }
      }

      const messageType = isBroadcast ? 'broadcast' : 'direct';
      const senderId = rawMessage.senderId || 'unknown';
      // Prefer stored display name (set via announce) over SDK hardware name
      const senderName = this.connectedDevices.get(senderId) || rawMessage.senderName || 'Unknown Device';

      // Only update stored name from SDK if we don't already have a display name
      if (rawMessage.senderName && !this.connectedDevices.get(senderId)) {
        this.connectedDevices.set(senderId, rawMessage.senderName);
        databaseService.saveDevice({ id: senderId, name: rawMessage.senderName, connection_status: 'online' }).catch(() => {});
      }

      // Detect content types from JSON payload
      let contentType = 'text';
      let mediaData = null;
      if (rawContent.startsWith('{')) {
        try {
          const parsed = JSON.parse(rawContent);

          // Extract battery metadata from any message
          if (parsed._bat != null) this.deviceBatteries.set(senderId, parsed._bat);

          const richTypes = ['photo', 'location', 'sos', 'file', 'find_me_request', 'find_me_response', 'text'];
          if (richTypes.includes(parsed.type)) {
            contentType = parsed.type;
            mediaData = parsed;
            // Emit special handlers without blocking the regular message flow
            if (parsed.type === 'sos' && this.onSOSHandler) {
              this.onSOSHandler({ senderId, senderName, mediaData: parsed });
            }
            if (parsed.type === 'find_me_request' && this.onFindMeUpdateHandler) {
              // Broadcast find_me_request is open to anyone; direct is only for us (already filtered by Bridgefy)
              this.onFindMeUpdateHandler({ type: parsed.type, senderId, senderName, mediaData: parsed });
            }
            if (parsed.type === 'find_me_response' && this.onFindMeUpdateHandler) {
              // Only act on a response addressed to us
              const target = parsed.targetDeviceId;
              if (!target || target === this.myDeviceId) {
                this.onFindMeUpdateHandler({ type: parsed.type, senderId, senderName, mediaData: parsed });
              }
            }
          }
        } catch (_e) { /* not JSON */ }
      }

      // For plain text messages sent as JSON envelopes, unwrap to store clean text in DB.
      // For rich types (photo/location/etc.) keep the full JSON.
      let storedContent = rawContent;
      if (contentType === 'text' && mediaData?.text) {
        storedContent = mediaData.text;
      }

      // Create database message object — store full JSON for photo/location
      const dbMessage = {
        id: rawMessage.messageId || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
        content: storedContent,
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

      // Send delivery ack — use the Bridgefy SDK message ID (rawMessage.messageId)
      // because that's the same ID the sender stored their copy under
      if (!isBroadcast) {
        const ackId = rawMessage.messageId || savedMessage.id;
        this._sendAck(senderId, ackId, 'delivered').catch(() => {});
      }

      // Convert to app message format
      const message = {
        id: savedMessage.id,
        text: storedContent,
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
    // Pause background work when not active; refresh unread counts and re-announce on resume.
    if (nextState === 'active') {
      this.getUnreadCounts()
        .then(counts => this.emitEvent('onUnreadUpdated', counts))
        .catch(err => console.error('❌ getUnreadCounts error:', err));
      // Re-announce ourselves so nearby devices know we're back
      this._sendAnnounce();
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

  // Inject battery into outgoing JSON payloads (location is never shared passively)
  async _injectMeta(payload) {
    try {
      const battery = await this._getBattery();
      const parsed = JSON.parse(payload);
      parsed._bat = battery;
      return JSON.stringify(parsed);
    } catch (_e) {
      return payload;
    }
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
      deliveryStatus: dbMsg.delivery_status || 'sent',
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
      this._apiKey = apiKey;
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
      // Wrap text in JSON envelope to carry battery metadata
      const battery = await this._getBattery();
      const envelope = JSON.stringify({
        type: 'text', text,
        _bat: battery,
      });
      console.log(`📤 Sending to ${receiverId}: ${text}`);
      const response = await Bridgefy.sendPayload(receiverId, envelope);
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
      // Protocol messages: send over BLE but never save to chat DB
      try {
        const parsed = JSON.parse(text);
        if (
          parsed.type === 'internet_request' ||
          parsed.type === 'internet_response' ||
          parsed.type === 'cache_share'  ||
          parsed.type === 'weather_update' ||
          parsed.type === 'announce'
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
      // Save to DB first (optimistic) so message appears immediately in UI
      const dbMsg = this._buildDbMessage({
        content: text,
        messageType: 'broadcast',
        isBroadcast: true,
        replyToId: replyTo?.id || null,
        replyPreview: replyTo ? `${replyTo.senderName}: ${replyTo.text}` : null,
      });
      if (this.connectedDevices.size === 0) {
        // No peers — queue for retry
        dbMsg.delivery_status = 'queued';
        await databaseService.saveMessage(dbMsg);
        this._broadcastQueue.push({ dbMsgId: dbMsg.id, content: text });
        console.log(`📭 No peers — broadcast queued (queue size: ${this._broadcastQueue.length})`);
        return this._buildAppMessage(dbMsg);
      }
      try {
        const response = await Bridgefy.sendBroadcast(text);
        dbMsg.id = response.id || dbMsg.id;
        dbMsg.delivery_status = 'sent';
      } catch (sendErr) {
        // Send failed — queue for retry rather than throwing
        console.warn('⚠️ Broadcast send failed, queuing:', sendErr.message);
        dbMsg.delivery_status = 'queued';
        this._broadcastQueue.push({ dbMsgId: dbMsg.id, content: text });
      }
      await databaseService.saveMessage(dbMsg);
      return this._buildAppMessage(dbMsg);
    } catch (error) {
      console.error('❌ Broadcast failed:', error);
      throw error;
    }
  }

  _startBroadcastRetry() {
    this._broadcastRetry = setInterval(async () => {
      if (this._broadcastQueue.length === 0) return;
      if (this.connectedDevices.size === 0) return;
      const queue = [...this._broadcastQueue];
      this._broadcastQueue = [];
      for (const item of queue) {
        try {
          await Bridgefy.sendBroadcast(item.content);
          await databaseService.executeQuery(
            'UPDATE messages SET delivery_status = ? WHERE id = ?',
            ['sent', item.dbMsgId]
          ).catch(() => {});
          console.log(`✅ Queued broadcast sent: ${item.dbMsgId}`);
          this.emitEvent('onNewMessage', { queued: true });
        } catch (_e) {
          // Still failing — put back
          this._broadcastQueue.push(item);
        }
      }
    }, 30000);
  }

  async getConnectedDevices() {
    try {
      const devices = await Bridgefy.getConnectedDevices();
      if (devices && Array.isArray(devices)) {
        // Build the set of IDs currently reported by Bridgefy
        const freshIds = new Set(devices.map(d => d.id).filter(Boolean));

        // Remove stale entries from our map (missed onDeviceLost events)
        for (const id of this.connectedDevices.keys()) {
          if (!freshIds.has(id)) this.connectedDevices.delete(id);
        }

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
      return Array.from(this.connectedDevices.entries())
        .filter(([id]) => id !== this.myDeviceId)
        .map(([id, name]) => ({
          id,
          name,
          battery: this.deviceBatteries.get(id) ?? null,
          lastSeen: this.deviceLastSeen.get(id) ?? null,
        }));
    } catch (error) {
      console.error('❌ Error getting devices from Bridgefy, using database cache:', error);
      try {
        const devices = await databaseService.getAllDevices();
        const onlineDevices = devices.filter(device =>
          device.id !== this.myDeviceId && device.connection_status === 'online'
        );
        onlineDevices.forEach(device => {
          this.connectedDevices.set(device.id, device.name);
          if (device.battery != null) this.deviceBatteries.set(device.id, device.battery);
          if (device.last_seen)       this.deviceLastSeen.set(device.id, device.last_seen);
        });
        return onlineDevices.map(device => ({
          id: device.id,
          name: device.name,
          battery: device.battery ?? null,
          lastSeen: device.last_seen ?? null,
        }));
      } catch (dbError) {
        console.error('❌ Error getting devices from database:', dbError);
        return Array.from(this.connectedDevices.entries()).map(([id, name]) => ({ id, name, battery: null, lastSeen: null }));
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
    // Send read acks for all delivered messages from this sender
    if (deviceId && deviceId !== 'broadcast') {
      this._sendReadAcks(deviceId).catch(() => {});
    }
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

  // ============ ANNOUNCE (ephemeral broadcast) ============

  async _sendAnnounce() {
    if (!this.myDeviceId || !this.isInitialized) return;
    try {
      const battery = await this._getBattery();
      // Battery warning — one shot per session when critically low
      if (battery != null && battery <= 15 && !this._batteryWarningSent) {
        this._batteryWarningSent = true;
        const warnPacket = JSON.stringify({
          type: 'battery_warning',
          deviceId: this.myDeviceId,
          name: this.myDeviceName,
          battery,
          timestamp: Date.now(),
        });
        await Bridgefy.sendBroadcast(warnPacket).catch(() => {});
      }
      // Reset warning flag if charged back above 20%
      if (battery != null && battery > 20) this._batteryWarningSent = false;

      const packet = JSON.stringify({
        type: 'announce',
        deviceId: this.myDeviceId,
        name: this.myDeviceName,
        battery,
        timestamp: Date.now(),
      });
      await Bridgefy.sendBroadcast(packet);
    } catch (_e) { /* silent — announce is best-effort */ }
  }

  async _handleAnnounce(parsed, rawSenderId) {
    const senderId = parsed.deviceId || rawSenderId;
    if (!senderId || senderId === this.myDeviceId) return;

    // Announce name always wins — it's the user's chosen display name
    const name = parsed.name || this.connectedDevices.get(senderId) || `Device_${senderId.substring(0, 8)}`;
    this.connectedDevices.set(senderId, name);

    if (parsed.battery != null) this.deviceBatteries.set(senderId, parsed.battery);
    this.deviceLastSeen.set(senderId, parsed.timestamp || Date.now());

    // Update device record
    databaseService.saveDevice({
      id: senderId,
      name,
      connection_status: 'online',
      last_seen: parsed.timestamp || Date.now(),
      battery: parsed.battery ?? null,
    }).catch(() => {});

    // Update conversation record so HomeScreen shows correct name immediately
    databaseService.executeQuery(
      'UPDATE conversations SET device_name = ? WHERE device_id = ?',
      [name, senderId]
    ).catch(() => {});

    this.emitEvent('onDeviceListUpdated', { deviceId: senderId, name });
  }

  async _sendAck(receiverId, messageId, ackType) {
    try {
      const packet = JSON.stringify({ type: 'ack', messageId, ackType });
      await Bridgefy.sendPayload(receiverId, packet);
    } catch (_e) { /* acks are best-effort */ }
  }

  async _handleAck(parsed) {
    const { messageId, ackType } = parsed;
    if (!messageId || !ackType) return;
    await databaseService.updateMessageStatus(messageId, ackType);
    this.emitEvent('onMessageStatusUpdated', { messageId, status: ackType });
  }

  async _sendReadAcks(senderId) {
    try {
      const msgs = await databaseService.getMessages(senderId, 'direct', 200, 0);
      const toAck = msgs.filter(m => !m.isMine && m.deliveryStatus === 'delivered');
      for (const m of toAck) {
        await this._sendAck(senderId, m.id, 'read');
        await databaseService.updateMessageStatus(m.id, 'read');
      }
    } catch (_e) {}
  }

  async _getBattery() {
    try {
      const DeviceInfo = require('react-native-device-info');
      const level = await DeviceInfo.getBatteryLevel();
      return Math.round(level * 100);
    } catch (_e) {
      return null;
    }
  }

  async _startLocationTracking() {
    // Request permission first on Android
    if (Platform.OS === 'android') {
      try {
        const { PermissionsAndroid } = require('react-native');
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          {
            title: 'Location Permission',
            message: 'PeerReach needs your location so peers can see your last known position.',
            buttonPositive: 'Allow',
            buttonNegative: 'Deny',
          }
        );
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
          console.log('📍 Location permission denied — location tracking disabled');
          return;
        }
      } catch (_e) {
        console.warn('📍 Could not request location permission:', _e);
        return;
      }
    }

    const Geolocation = require('react-native-geolocation-service').default;
    const fetch = () => {
      Geolocation.getCurrentPosition(
        (pos) => {
          this.myLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude, ts: Date.now() };
          console.log('📍 Location updated:', this.myLocation.lat.toFixed(4), this.myLocation.lng.toFixed(4));
        },
        (err) => {
          // POSITION_UNAVAILABLE (2) or TIMEOUT (3) are expected when GPS is off — suppress noise
          if (err.code !== 2 && err.code !== 3) {
            console.warn('📍 Location error:', err.message);
          }
        },
        { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 }
      );
    };
    fetch();
    this._locationInterval = setInterval(fetch, 5 * 60 * 1000); // every 5 min
  }

  getMyLocation() {
    return this.myLocation || null;
  }

  // ============ SOS BROADCAST ============

  async sendSOS(lat, lng) {
    if (!this.myDeviceId) throw new Error('Mesh not ready');
    const payload = JSON.stringify({
      type: 'sos',
      text: '🚨 SOS — Emergency',
      senderId: this.myDeviceId,
      senderName: this.myDeviceName,
      lat, lng,
      priority: true,
      timestamp: Date.now(),
      isBroadcast: true,
    });
    const response = await Bridgefy.sendBroadcast(payload);
    const dbMsg = this._buildDbMessage({ responseId: response.id, content: payload, messageType: 'broadcast', isBroadcast: true });
    await databaseService.saveMessage(dbMsg);
    return this._buildAppMessage(dbMsg, { contentType: 'sos', mediaData: { lat, lng, senderId: this.myDeviceId, senderName: this.myDeviceName } });
  }

  // ============ FIND ME ============

  async sendFindMeRequest(receiverId, lat, lng, isBroadcast = false) {
    if (!this.myDeviceId) throw new Error('Mesh not ready');
    const requestId = `fm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const payload = JSON.stringify({
      type: 'find_me_request',
      text: `${this.myDeviceName} wants you to find them`,
      requestId,
      senderId: this.myDeviceId,
      senderName: this.myDeviceName,
      targetDeviceId: isBroadcast ? null : receiverId,
      lat, lng,
      timestamp: Date.now(),
    });
    let response;
    if (isBroadcast) {
      response = await Bridgefy.sendBroadcast(payload);
    } else {
      response = await Bridgefy.sendPayload(receiverId, payload);
    }
    const dbMsg = this._buildDbMessage({
      responseId: response.id,
      content: payload,
      receiverId: isBroadcast ? null : receiverId,
      messageType: isBroadcast ? 'broadcast' : 'direct',
      isBroadcast,
    });
    await databaseService.saveMessage(dbMsg);
    return this._buildAppMessage(dbMsg, {
      contentType: 'find_me_request',
      mediaData: { requestId, lat, lng, senderId: this.myDeviceId, senderName: this.myDeviceName, targetDeviceId: isBroadcast ? null : receiverId },
    });
  }

  async sendFindMeResponse(receiverId, requestId, lat, lng, viabroadcast = false) {
    if (!this.myDeviceId) throw new Error('Mesh not ready');
    const payload = JSON.stringify({
      type: 'find_me_response',
      text: `${this.myDeviceName} shared their location`,
      requestId,
      senderId: this.myDeviceId,
      senderName: this.myDeviceName,
      targetDeviceId: receiverId, // always set so only requester acts on it
      lat, lng,
      timestamp: Date.now(),
    });
    let response;
    if (viabroadcast) {
      // Original request was broadcast — reply via broadcast so mesh can relay it back
      response = await Bridgefy.sendBroadcast(payload);
    } else {
      response = await Bridgefy.sendPayload(receiverId, payload);
    }
    const dbMsg = this._buildDbMessage({
      responseId: response.id,
      content: payload,
      receiverId: viabroadcast ? null : receiverId,
      messageType: viabroadcast ? 'broadcast' : 'direct',
      isBroadcast: viabroadcast,
    });
    await databaseService.saveMessage(dbMsg);
    return this._buildAppMessage(dbMsg, {
      contentType: 'find_me_response',
      mediaData: { requestId, lat, lng, senderId: this.myDeviceId, senderName: this.myDeviceName },
    });
  }

  // ============ FILE TRANSFER ============

  async sendFile(receiverId, fileName, mimeType, base64Data, fileSize) {
    if (!this.myDeviceId) throw new Error('Mesh not ready');
    const MAX_FILE_BASE64 = 40960; // ~30KB raw
    if (base64Data.length > MAX_FILE_BASE64) {
      throw new Error(`File too large — max ~30 KB (got ${Math.round(base64Data.length * 0.75 / 1024)} KB)`);
    }
    const payload = JSON.stringify({
      type: 'file',
      text: `[File] ${fileName}`,
      fileName,
      mimeType,
      fileSize,
      data: base64Data,
      senderId: this.myDeviceId,
      senderName: this.myDeviceName,
      timestamp: Date.now(),
    });
    const response = await Bridgefy.sendPayload(receiverId, payload);
    const dbMsg = this._buildDbMessage({ responseId: response.id, content: payload, receiverId, messageType: 'direct' });
    await databaseService.saveMessage(dbMsg);
    return this._buildAppMessage(dbMsg, {
      contentType: 'file',
      mediaData: { fileName, mimeType, fileSize, data: base64Data },
    });
  }

  // ============ SPECIAL EVENT HANDLERS ============

  setOnFindMeUpdateHandler(callback) { this.onFindMeUpdateHandler = callback; }
  setOnSOSHandler(callback) { this.onSOSHandler = callback; }

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

  setOnDeviceListUpdatedHandler(callback) {
    this.onDeviceListUpdatedHandler = callback;
  }

  setOnMessageStatusUpdatedHandler(callback) {
    this.onMessageStatusUpdatedHandler = callback;
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
      if (this._broadcastRetry) clearInterval(this._broadcastRetry);
      if (this._locationInterval) clearInterval(this._locationInterval);
      gatewayService.destroy();
      weatherService.stop();
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


