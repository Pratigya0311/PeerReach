// src/services/BridgefyService.js - UPDATED FOR SQLITE + GATEWAY
import { NativeModules, NativeEventEmitter, Platform, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import databaseService from './DatabaseService';
import gatewayService from './GatewayService';
import weatherService from './WeatherService';

const DISPLAY_NAME_KEY = '@peerreach_display_name';

const { Bridgefy } = NativeModules;

if (!Bridgefy) {
  console.error('âŒ Bridgefy native module is NULL â€” the .aar may not have loaded correctly');
}

const bridgefyEmitter = Bridgefy ? new NativeEventEmitter(Bridgefy) : { addListener: () => ({}) };

const ANNOUNCE_INTERVAL_MS = 90000;
const ANNOUNCE_TTL_MS = 180000;
const DIRECT_TTL_MS = 15000;
const DIRECT_FRESH_MS = 12000;
const DIRECT_SCAN_FRESH_MS = 20000;
const DIRECT_MIN_NEARBY_MS = 30000;
const DIRECT_SEND_TTL_MS = 5000;
const MAX_HOPS = 5;

class BridgefyService {
  constructor() {
    this.messageListener = null;
    this.connectedDevices  = new Map();  // deviceId â†’ name
    this.deviceBatteries   = new Map();  // deviceId â†’ battery %
    this.deviceLastSeen    = new Map();  // deviceId â†’ timestamp
    this.deviceLocations   = new Map();  // deviceId â†’ {lat, lng, ts}
    this.myLocation        = null;       // {lat, lng, ts}
    this._locationInterval = null;
    this.onLocationUpdated = null;
    this._batteryWarningSent = false;
    this._sendBattery = true;
    this.myDeviceId = null;
    this._apiKey = null;
    this.useAsyncStorage = false;
    this.seenAnnounces = new Map();
    this.announceTimer = null;
    this.sendCooldowns = new Map();
    this.offlineBlocked = new Set();
    this.pendingSendMap = new Map();
    this.lastApiKey = null;
    this.healthTimer = null;
    this.isRestarting = false;
    this.watchdogTimer = null;
    this._lastNoPeersLogAt = 0;
    this._emptyListTimer = null;
    this.directCache = new Map(); // deviceId -> { name, lastSeen }
    this.directActivity = new Map(); // deviceId -> last direct send/receive ts
    this.directStickyUntil = new Map(); // deviceId -> timestamp (minimum nearby window)
    this.lastAnnounceAt = 0;
    this.lastDirectScanAt = 0;
    this.myDeviceName = Platform.OS === 'android' ? (Bridgefy?.deviceName || 'Android Device') : 'iOS Device';
    this.isInitialized = false;
    this.isInitializing = false;
    this.currentChatId = null;
    this._deviceLostTimers = new Map();  // deviceId â†’ setTimeout handle (grace-period before removal)
    this._debugLog = [];
    this._debugLogMax = 80;
    this._lastDebugAt = 0;

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
  }

  async initializeDatabase() {
    try {
      await databaseService.initialize();
      this.useAsyncStorage = false;
      console.log('Ã¢Å“â€¦ Database ready');
    } catch (error) {
      console.error('âŒ Database initialization failed, using AsyncStorage fallback:', error);
      this.useAsyncStorage = true;
    }
  }

  _pushDebug(event, data = null) {
    const entry = { ts: Date.now(), event, data };
    this._debugLog.push(entry);
    if (this._debugLog.length > this._debugLogMax) this._debugLog.shift();
    if (__DEV__) {
      if (!this._lastDebugAt || Date.now() - this._lastDebugAt > 1500) {
        console.log(`[BFY] ${event}`, data ?? '');
        this._lastDebugAt = Date.now();
      }
    }
  }

  getDebugLog() {
    return this._debugLog.slice(-this._debugLogMax);
  }

    setupEventListeners() {
    // Registration events
    bridgefyEmitter.addListener('onRegistrationSuccessful', async (data) => {
      try {
        console.log('Bridgefy registered:', data);
        this._pushDebug('registered', { id: data?.userUuid });
        this.myDeviceId = data.userUuid;
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
        this.startAnnounceLoop();
        this.sendAnnounce('online', 0);
        this.flushQueuedMessages();
        this.flushQueuedBroadcasts();
        this.startHealthCheck();
        this.emitEvent('onReady', { deviceId: this.myDeviceId, deviceName: this.myDeviceName });
        weatherService.startAutoRefresh();
        this._startLocationTracking();
      } catch (err) {
        console.error('onRegistrationSuccessful error:', err);
        this.emitEvent('onReady', { deviceId: this.myDeviceId, deviceName: this.myDeviceName });
      }
    });

    bridgefyEmitter.addListener('onRegistrationFailed', (error) => {
      console.warn('Bridgefy registration failed:', error);
      this._pushDebug('registration_failed', { error: error?.message || error });
      this.emitEvent('onError', error);
    });

    bridgefyEmitter.addListener('onDeviceConnected', async (device) => {
      try {
        console.log('Device connected:', device);
        const id = device?.userId || device?.id;
        const name = device?.deviceName || device?.name;
        if (id) {
          if (this._deviceLostTimers.has(id)) {
            clearTimeout(this._deviceLostTimers.get(id));
            this._deviceLostTimers.delete(id);
            console.log('Reconnected within grace period - removal cancelled:', id);
          }
          const existing = this.connectedDevices.get(id);
          const resolvedName = existing || name || `Device_${id.substring(0, 8)}`;
          this.connectedDevices.set(id, resolvedName);
          this.lastDirectScanAt = Date.now();
          this.deviceLastSeen.set(id, Date.now());
          this.directCache.set(id, { name: resolvedName, lastSeen: Date.now() });
          this.directActivity.set(id, Date.now());
          this.directStickyUntil.set(id, Date.now() + DIRECT_MIN_NEARBY_MS);
          this.offlineBlocked.delete(id);
          await databaseService.saveDevice({
            id: id,
            name: resolvedName,
            connection_status: 'online',
            last_seen: Date.now(),
          });
          this.sendAnnounce('online', 0);
          await this.flushQueuedMessages(id);
          await this.flushQueuedBroadcasts();
          this.emitEvent('onDeviceConnected', device);
        }
      } catch (err) {
        console.error('onDeviceConnected error:', err);
      }
    });

    bridgefyEmitter.addListener('onDeviceLost', (device) => {
      console.log('Device lost (grace period started):', device);
      const id = device?.userId || device?.id;
      if (!id) return;
      if (this._deviceLostTimers.has(id)) return;
      const timer = setTimeout(async () => {
        this._deviceLostTimers.delete(id);
        if (this.connectedDevices.has(id)) {
          console.log('Device confirmed lost after grace period:', id);
          this.connectedDevices.delete(id);
          this.directCache.delete(id);
          this.directActivity.delete(id);
          this.directStickyUntil.delete(id);
          try {
            await databaseService.updateDeviceStatus(id, 'offline');
          } catch (err) {
            console.error('onDeviceLost DB update error:', err);
          }
          this.emitEvent('onDeviceLost', device);
        }
      }, 8000);
      this._deviceLostTimers.set(id, timer);
    });

    bridgefyEmitter.addListener('onDeviceListUpdated', async (data) => {
      try {
        console.log('Device list updated:', data?.devices?.length);
        if (data?.devices && Array.isArray(data.devices)) {
          this.lastDirectScanAt = Date.now();
          // Do not clear on empty or partial lists — membership is managed by onDeviceConnected/onDeviceLost.
          const nextMap = new Map();
          for (const device of data.devices) {
            const id = device?.userId || device?.id;
            const name = device?.deviceName || device?.name;
            if (id) {
              nextMap.set(id, name || `Device_${id.substring(0, 8)}`);
            }
          }
          if (nextMap.size === 0) {
            this.emitEvent('onDeviceListUpdated', {
              devices: Array.from(this.connectedDevices.entries()).map(([id, name]) => ({ id, name }))
            });
            return;
          }
          // Merge updates; do not drop missing devices here (onDeviceLost handles removal)
          for (const [id, name] of nextMap.entries()) {
            this.connectedDevices.set(id, name);
            this.offlineBlocked.delete(id);
            await databaseService.saveDevice({
              id: id,
              name: name,
              connection_status: 'online'
            });
            this.deviceLastSeen.set(id, Date.now());
            this.directCache.set(id, { name, lastSeen: Date.now() });
            this.directActivity.set(id, Date.now());
            this.directStickyUntil.set(id, Date.now() + DIRECT_MIN_NEARBY_MS);
          }
          await this.flushQueuedBroadcasts();
          this.emitEvent('onDeviceListUpdated', {
            devices: Array.from(this.connectedDevices.entries()).map(([id, name]) => ({ id, name }))
          });
        }
      } catch (err) {
        console.error('onDeviceListUpdated error:', err);
      }
    });

    bridgefyEmitter.addListener('onMessageReceived', async (rawMessage) => {
      try {
        console.log('Direct message received:', rawMessage);
        await this.handleIncomingMessage(rawMessage, false);
      } catch (err) {
        console.error('onMessageReceived error:', err);
      }
    });

    bridgefyEmitter.addListener('onBroadcastMessageReceived', async (rawMessage) => {
      try {
        console.log('Broadcast message received:', rawMessage);
        await this.handleIncomingMessage(rawMessage, true);
      } catch (err) {
        console.error('onBroadcastMessageReceived error:', err);
      }
    });

    bridgefyEmitter.addListener('onMessageSent', (data) => {
      console.log('Message sent:', data);
      if (data?.messageId) {
        const rid = this.pendingSendMap.get(data.messageId);
        if (rid) this.directActivity.set(rid, Date.now());
        this.pendingSendMap.delete(data.messageId);
      }
      this.emitEvent('onMessageSent', data);
    });

    bridgefyEmitter.addListener('onMessageSendFailed', (error) => {
      const errMsg = error?.error || error?.message || '';
      if (this._isNoPeersError(errMsg)) {
        const now = Date.now();
        if (now - this._lastNoPeersLogAt > 2000) {
          console.warn('Send failed (no peers):', errMsg);
          this._lastNoPeersLogAt = now;
        }
      } else {
        console.warn('Message send failed:', error);
      }
      const receiverId = error?.receiverId || (error?.messageId ? this.pendingSendMap.get(error.messageId) : null);
      if (receiverId) {
        if (!this._isNoPeersError(errMsg)) {
          this.applySendFailure(receiverId);
        }
        this.sendCooldowns.set(receiverId, Date.now() + 60000);
      }
      if (!this._isNoPeersError(errMsg)) {
        this.sendAnnounce('online', 0);
        this.ensureHealth();
      }
      this.emitEvent('onMessageSendFailed', error);
    });

    bridgefyEmitter.addListener('onStarted', () => {
      console.log('Bridgefy service started');
      this.emitEvent('onStarted', {});
    });

    bridgefyEmitter.addListener('onStartError', (error) => {
      console.error('onStartError:', JSON.stringify(error));
      this._pushDebug('start_error', { error });
      this.emitEvent('onError', { ...error, isStartError: true });
    });

    bridgefyEmitter.addListener('onStopped', () => {
      console.log('Bridgefy service stopped');
      this._pushDebug('stopped');
      this.stopAnnounceLoop();
      this.stopHealthCheck();
      this.emitEvent('onStopped', {});
    });

    bridgefyEmitter.addListener('onBluetoothStateChanged', (data) => {
      this._pushDebug('bt_state', data);
      this.emitEvent('onBluetoothStateChanged', data);
    });
  }

  async handleIncomingMessage(rawMessage, isBroadcast) {
    try {
      if (rawMessage && rawMessage.type === 'announce') {
        await this.handleAnnounce(rawMessage);
        return;
      }
      const rawContent = rawMessage.content || '';

      // Intercept protocol messages â€” don't save to chat DB
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
          // Typing indicator â€” ephemeral, never stored
          if (parsed.type === 'typing') {
            const senderId = rawMessage.senderId || parsed.senderId;
            const senderName = parsed.senderName || this.connectedDevices.get(senderId) || 'Someone';
            this.emitEvent('onTyping', { senderId, senderName, isBroadcast });
            return;
          }

          // Announce â€” ephemeral, update device info
          if (parsed.type === 'announce') {
            await this.handleAnnounce({
              announceId: parsed.announceId,
              userId: parsed.userId || parsed.deviceId,
              userName: parsed.userName || parsed.name,
              status: parsed.status || 'online',
              hop: parsed.hop,
              ts: parsed.ts || parsed.timestamp,
              battery: parsed.battery,
              senderId: rawMessage.senderId
            });
            return;
          }

          // Battery warning â€” show as system message in active chats
          if (parsed.type === 'battery_warning') {
            this._handleAnnounce(parsed, rawMessage.senderId); // update battery map
            this.emitEvent('onBatteryWarning', { senderId: parsed.deviceId || rawMessage.senderId, name: parsed.name, battery: parsed.battery });
            return;
          }

          // Weather update â€” share through mesh, never store in chat
          if (parsed.type === 'weather_update') {
            weatherService.handleWeatherUpdate(parsed, rawMessage.senderId);
            return;
          }

          // Delivery / read ack â€” update sent message status
          if (parsed.type === 'ack') {
            this._handleAck(parsed);
            return;
          }
        } catch {
          // Not JSON â€” treat as regular chat message below
        }
      }

      const messageType = isBroadcast ? 'broadcast' : 'direct';
      const senderId = rawMessage.senderId || 'unknown';
      if (!isBroadcast && senderId && senderId !== 'unknown') {
        this.directActivity.set(senderId, Date.now());
      }
      // Prefer stored display name (set via announce) over SDK hardware name
      const senderName = this.connectedDevices.get(senderId) || rawMessage.senderName || 'Unknown Device';

      // Only update name for direct peers (avoid polluting direct list for mesh-only users)
      if (rawMessage.senderName && this.connectedDevices.has(senderId)) {
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

      // Create database message object â€” store full JSON for photo/location
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

      // Send delivery ack â€” use the Bridgefy SDK message ID (rawMessage.messageId)
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
      console.error('âŒ Error handling incoming message:', error);
    }
  }

  startAnnounceLoop() {
    if (this.announceTimer) return;
    this.announceTimer = setInterval(async () => {
      this.pruneAnnounces();
      this.sendAnnounce('online', 0);
      this.flushQueuedMessages();
      this.flushQueuedBroadcasts();
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
      const battery = await this._getBattery();
      this.lastAnnounceAt = Date.now();
      const announceId = `${this.myDeviceId}:${Date.now()}`;
      const payload = {
        type: 'announce',
        text: '',
        userId: this.myDeviceId,
        userName: this.myDeviceName,
        status: status,
        hop: hop,
        announceId: announceId,
        ts: Date.now(),
        battery: battery
      };
      if (Bridgefy.sendBroadcastPayload) {
        await Bridgefy.sendBroadcastPayload(JSON.stringify(payload));
      } else {
        await Bridgefy.sendBroadcast(JSON.stringify(payload));
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
      const userName = rawMessage.userName || rawMessage.name || 'Unknown Device';
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

      if (rawMessage.battery != null) {
        this.deviceBatteries.set(userId, rawMessage.battery);
      }

      if (status === 'online') {
        this.offlineBlocked.delete(userId);
        await this.flushQueuedMessages(userId);
      } else {
        this.offlineBlocked.add(userId);
        this.connectedDevices.delete(userId);
        this.directCache.delete(userId);
        this.directActivity.delete(userId);
      }

      if (distance < MAX_HOPS) {
        const forwardPayload = {
          type: 'announce',
          text: '',
          userId: userId,
          userName: userName,
          status: status,
          hop: hop + 1,
          announceId: announceId,
          ts: rawMessage.ts || Date.now(),
          battery: rawMessage.battery
        };
        if (Bridgefy.sendBroadcastPayload) {
          await Bridgefy.sendBroadcastPayload(JSON.stringify(forwardPayload));
        } else {
          await Bridgefy.sendBroadcast(JSON.stringify(forwardPayload));
        }
      }
    } catch (error) {
      console.error('Error handling announce:', error);
    }
  }

  isInCooldown(receiverId) {
    if (this.offlineBlocked.has(receiverId)) return true;
    const until = this.sendCooldowns.get(receiverId);
    return until && Date.now() < until;
  }

  applySendFailure(receiverId) {
    const cachedName =
      this.connectedDevices.get(receiverId) ||
      this.directCache.get(receiverId)?.name ||
      'Unknown Device';
    this.offlineBlocked.add(receiverId);
    this.connectedDevices.delete(receiverId);
    this.directCache.delete(receiverId);
    this.directActivity.delete(receiverId);
    databaseService.upsertKnownUser({
      id: receiverId,
      name: cachedName,
      last_seen: Date.now(),
      hops: 0,
      via_peer: null,
      is_online: 0
    }).catch(() => {});
  }

  async queueOutgoingMessage(receiverId, text, replyTo = null) {
    const dbMsg = this._buildDbMessage({
      content: text,
      receiverId,
      messageType: 'direct',
      replyToId: replyTo?.id || null,
      replyPreview: replyTo ? `${replyTo.senderName}: ${replyTo.text}` : null,
    });
    dbMsg.delivery_status = 'queued';
    await databaseService.saveMessage(dbMsg);
    return this._buildAppMessage(dbMsg);
  }

  async queueBroadcastMessage(text, replyTo = null) {
    const dbMsg = this._buildDbMessage({
      content: text,
      messageType: 'broadcast',
      isBroadcast: true,
      replyToId: replyTo?.id || null,
      replyPreview: replyTo ? `${replyTo.senderName}: ${replyTo.text}` : null,
    });
    dbMsg.delivery_status = 'queued';
    await databaseService.saveMessage(dbMsg);
    return this._buildAppMessage(dbMsg);
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

  startWatchdog() {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      this._watchdogTick();
    }, 15000);
  }

  stopWatchdog() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  async _watchdogTick() {
    try {
      if (this.isRestarting || this.isInitializing) return;
      if (!Bridgefy || !this.lastApiKey) return;
      if (!this.isInitialized) {
        this._pushDebug('watchdog_init');
        await this.initialize(this.lastApiKey);
        return;
      }
      await this.ensureHealth();
      // Warm direct scan so nearby stays accurate
      await this.getConnectedDevices();
    } catch (error) {
      this._pushDebug('watchdog_error', { error: error?.message || error });
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
        this.flushQueuedBroadcasts();
        this.isRestarting = false;
        this.emitEvent('onReconnected', {});
      }
    } catch (error) {
      this.isRestarting = false;
    }
  }

  async sendDirectRaw(receiverId, text) {
    const battery = await this._getBattery();
    const envelope = JSON.stringify({
      type: 'text', text,
      senderId: this.myDeviceId,
      senderName: this.myDeviceName,
      _bat: battery,
    });
    const response = await Bridgefy.sendPayload(receiverId, envelope);
    if (response?.id) {
      this.pendingSendMap.set(response.id, receiverId);
    }
    return response;
  }

  async sendMeshRaw(receiverId, text) {
    const battery = await this._getBattery();
    const envelope = JSON.stringify({
      type: 'text', text,
      senderId: this.myDeviceId,
      senderName: this.myDeviceName,
      _bat: battery,
    });
    if (Bridgefy.sendMeshMessage) {
      const response = await Bridgefy.sendMeshMessage(receiverId, envelope);
      if (response?.id) {
        this.pendingSendMap.set(response.id, receiverId);
      }
      return response;
    }
    return this.sendDirectRaw(receiverId, text);
  }

  async flushQueuedMessages(receiverId = null) {
    const queued = await databaseService.getQueuedMessages(receiverId);
    for (const msg of queued) {
      try {
        const canSend = await this.isReceiverOnline(msg.receiverId);
        if (!canSend || this.isInCooldown(msg.receiverId)) {
          continue;
        }
        if (!this.isDirectDevice(msg.receiverId)) {
          await this.sendMeshRaw(msg.receiverId, msg.text);
        } else {
          await this.sendDirectRaw(msg.receiverId, msg.text);
        }
        await databaseService.updateMessageStatus(msg.id, 'sent');
      } catch (error) {
        const errMsg = error?.error || error?.message || '';
        if (!this._isNoPeersError(errMsg)) {
          this.applySendFailure(msg.receiverId);
        }
        this.sendCooldowns.set(msg.receiverId, Date.now() + 60000);
        if (this._isNoPeersError(errMsg)) break;
      }
    }
  }

  async flushQueuedBroadcasts() {
    if (this._getDirectListFromCache({ freshOnly: true }).length === 0) return;
    const queued = await databaseService.getQueuedBroadcastMessages();
    for (const msg of queued) {
      try {
        await Bridgefy.sendBroadcast(msg.text);
        await databaseService.updateMessageStatus(msg.id, 'sent');
      } catch (error) {
        break;
      }
    }
  }
  showNotification(message) {
    const preview = (message.text || `[${message.contentType || 'message'}]`).substring(0, 50);
    console.log(`Ã°Å¸â€â€ NEW ${message.isBroadcast ? 'BROADCAST' : 'MESSAGE'} from ${message.senderName}: ${preview}...`);
  }

  handleAppStateChange(nextState) {
    if (nextState === 'active') {
      this.getUnreadCounts()
        .then(counts => this.emitEvent('onUnreadUpdated', counts))
        .catch(err => console.error('getUnreadCounts error:', err));
      if (this.isInitialized) {
        this.startAnnounceLoop();
        this.sendAnnounce('online', 0);
        this.flushQueuedMessages();
        this.flushQueuedBroadcasts();
        this.startHealthCheck();
      }
      this.startWatchdog();
      return;
    }

    if (nextState === 'background' || nextState === 'inactive') {
      if (this.isInitialized) {
        this.sendAnnounce('offline', 0);
        this.stopAnnounceLoop();
        this.stopHealthCheck();
      }
      this.stopWatchdog();
      if (this.currentChatId !== null) {
        this.currentChatId = null;
      }
    }
  }

  // ============ PRIVATE HELPERS ============

  _isNoPeersError(message) {
    const msg = String(message || '').toLowerCase();
    return (
      msg.includes('no peers') ||
      msg.includes('transaction canceled') ||
      msg.includes('transaction cancelled') ||
      msg.includes('timed out')
    );
  }

  _withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('send_timeout')), ms);
      promise
        .then((res) => { clearTimeout(timer); resolve(res); })
        .catch((err) => { clearTimeout(timer); reject(err); });
    });
  }

  _isDirectFresh(deviceId) {
    const info = this.directCache.get(deviceId);
    if (!info || this.offlineBlocked.has(deviceId)) return false;
    if (!this.lastDirectScanAt || Date.now() - this.lastDirectScanAt > DIRECT_SCAN_FRESH_MS) {
      return false;
    }
    const lastSeen = info.lastSeen || 0;
    const stickyUntil = this.directStickyUntil.get(deviceId) || 0;
    if (stickyUntil > Date.now()) return true;
    if (Date.now() - lastSeen > DIRECT_TTL_MS) return false;
    const lastActivity = this.directActivity.get(deviceId) || lastSeen;
    return Date.now() - lastActivity <= DIRECT_FRESH_MS;
  }

  _getDirectListFromCache({ freshOnly = true } = {}) {
    if (freshOnly && (!this.lastDirectScanAt || Date.now() - this.lastDirectScanAt > DIRECT_SCAN_FRESH_MS)) {
      return [];
    }
    const now = Date.now();
    const result = [];
    for (const [id, info] of this.directCache.entries()) {
      if (!id || id === this.myDeviceId) continue;
      if (!info?.lastSeen || now - info.lastSeen > DIRECT_TTL_MS) continue;
      if (this.offlineBlocked.has(id)) continue;
      if (freshOnly && !this._isDirectFresh(id)) continue;
      result.push({
        id,
        name: info.name,
        battery: this.deviceBatteries.get(id) ?? null,
        lastSeen: info.lastSeen ?? null,
      });
    }
    return result;
  }

  getStaleDirectDevices() {
    const now = Date.now();
    const result = [];
    for (const [id, info] of this.directCache.entries()) {
      if (!id || id === this.myDeviceId) continue;
      if (this.offlineBlocked.has(id)) continue;
      if (!info?.lastSeen || now - info.lastSeen > DIRECT_TTL_MS) continue;
      const last = this.directActivity.get(id) || info.lastSeen || 0;
      if (now - last <= DIRECT_FRESH_MS) continue;
      result.push({
        id,
        name: info.name,
        battery: this.deviceBatteries.get(id) ?? null,
        lastSeen: info.lastSeen ?? null,
        hops: 1,
      });
    }
    return result;
  }

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
    // For photo/location the content is a JSON blob â€” extract the human-readable text field.
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
      this._pushDebug('init_start');
      this._apiKey = apiKey;
      this.lastApiKey = apiKey;
      await Bridgefy.initialize(apiKey);
      this._pushDebug('init_called');
      return true;
    } catch (error) {
      console.error('Bridgefy initialization failed:', error);
      this._pushDebug('init_failed', { error: error?.message || error });
      throw error;
    } finally {
      this.isInitializing = false;
    }
  }

  async sendMessage(receiverId, text, replyTo = null) {
    if (!this.myDeviceId) throw new Error('Mesh not ready — please wait for initialization');
    const canSend = await this.isReceiverOnline(receiverId);
    if (!canSend || this.isInCooldown(receiverId)) {
      return this.queueOutgoingMessage(receiverId, text, replyTo);
    }
    try {
      const response = await this._withTimeout(
        this.isDirectDevice(receiverId)
          ? this.sendDirectRaw(receiverId, text)
          : this.sendMeshRaw(receiverId, text),
        12000
      );
      const dbMsg = this._buildDbMessage({
        responseId: response?.id,
        content: text,
        receiverId,
        messageType: 'direct',
        replyToId: replyTo?.id || null,
        replyPreview: replyTo ? `${replyTo.senderName}: ${replyTo.text}` : null,
      });
      dbMsg.delivery_status = 'sent';
      await databaseService.saveMessage(dbMsg);
      return this._buildAppMessage(dbMsg);
    } catch (error) {
      if (String(error?.message || '') === 'send_timeout') {
        return this.queueOutgoingMessage(receiverId, text, replyTo);
      }
      console.error('Send message failed:', error);
      return this.queueOutgoingMessage(receiverId, text, replyTo);
    }
  }

  async sendPhoto(receiverId, base64Data, width, height) {
    if (!this.myDeviceId) throw new Error('Mesh not ready â€” please wait for Bridgefy to initialize');
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
      console.error('âŒ Send photo failed:', error);
      throw error;
    }
  }

  async sendLocation(receiverId, lat, lng) {
    if (!this.myDeviceId) throw new Error('Mesh not ready â€” please wait for Bridgefy to initialize');
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
      console.error('âŒ Send location failed:', error);
      throw error;
    }
  }

  async sendBroadcastPhoto(base64Data, width, height) {
    if (!this.myDeviceId) throw new Error('Mesh not ready â€” please wait for Bridgefy to initialize');
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
      console.error('âŒ Broadcast photo failed:', error);
      throw error;
    }
  }

  async sendBroadcastLocation(lat, lng) {
    if (!this.myDeviceId) throw new Error('Mesh not ready â€” please wait for Bridgefy to initialize');
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
      console.error('âŒ Broadcast location failed:', error);
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
          parsed.type === 'weather_update'
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

      if (this._getDirectListFromCache({ freshOnly: true }).length === 0) {
        return this.queueBroadcastMessage(text, replyTo);
      }

      console.log(`Broadcasting: ${text}`);
      const dbMsg = this._buildDbMessage({
        content: text,
        messageType: 'broadcast',
        isBroadcast: true,
        replyToId: replyTo?.id || null,
        replyPreview: replyTo ? `${replyTo.senderName}: ${replyTo.text}` : null,
      });
      try {
        const response = await Bridgefy.sendBroadcast(text);
        dbMsg.id = response.id || dbMsg.id;
        dbMsg.delivery_status = 'sent';
      } catch (sendErr) {
        dbMsg.delivery_status = 'queued';
      }
      await databaseService.saveMessage(dbMsg);
      return this._buildAppMessage(dbMsg);
    } catch (error) {
      console.error('Broadcast failed:', error);
      return this.queueBroadcastMessage(text, replyTo);
    }
  }
  async getConnectedDevices() {
    try {
      const devices = await Bridgefy.getConnectedDevices();
      this.lastDirectScanAt = Date.now();
      if (devices && Array.isArray(devices)) {
        if (devices.length === 0) {
          // Avoid clearing nearby on transient empty scan
          if (this.directCache.size === 0 && this.connectedDevices.size > 0) {
            const now = Date.now();
            for (const [id, name] of this.connectedDevices.entries()) {
              this.directCache.set(id, { name, lastSeen: now });
            }
          }
          return this._getDirectListFromCache({ freshOnly: true });
        }
        const seen = new Set();
        for (const device of devices) {
          const id = device?.userId || device?.id;
          const name = device?.deviceName || device?.name;
          if (id) {
            this.connectedDevices.set(id, name || `Device_${id.substring(0, 8)}`);
            seen.add(id);
            await databaseService.saveDevice({
              id: id,
              name: name || `Device_${id.substring(0, 8)}`,
              connection_status: 'online'
            });
            this.deviceLastSeen.set(id, Date.now());
            this.directCache.set(id, { name: name || `Device_${id.substring(0, 8)}`, lastSeen: Date.now() });
            this.directActivity.set(id, Date.now());
            this.directStickyUntil.set(id, Date.now() + DIRECT_MIN_NEARBY_MS);
          }
        }
        // Do not prune here; removal is handled by onDeviceLost + grace timer.
      }
      return this._getDirectListFromCache({ freshOnly: true });
    } catch (error) {
      console.error('Error getting devices from Bridgefy, using database cache:', error);
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
        return this._getDirectListFromCache({ freshOnly: true });
      } catch (dbError) {
        console.error('Error getting devices from database:', dbError);
        return this._getDirectListFromCache({ freshOnly: true });
      }
    }
  }

  async getReachableUsers() {
    try {
      const minLastSeen = Date.now() - ANNOUNCE_TTL_MS;
      const users = await databaseService.getKnownUsers(minLastSeen);
      const directFreshIds = new Set(this._getDirectListFromCache({ freshOnly: true }).map(d => d.id));
      const staleDirect = this.getStaleDirectDevices();
      const map = new Map();
      for (const u of users) {
        if (u.id === this.myDeviceId || directFreshIds.has(u.id)) continue;
        map.set(u.id, {
          id: u.id,
          name: u.name,
          hops: u.hops,
          lastSeen: u.last_seen,
          viaPeer: u.via_peer
        });
      }
      for (const d of staleDirect) {
        if (!map.has(d.id)) {
          map.set(d.id, {
            id: d.id,
            name: d.name,
            hops: d.hops ?? 1,
            lastSeen: d.lastSeen ?? null,
            viaPeer: null
          });
        }
      }
      return Array.from(map.values());
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
      console.error('âŒ Error getting conversations:', error);
      return [];
    }
  }

  async getMessages(deviceId = null, isBroadcast = false, limit = 100) {
    try {
      const messageType = isBroadcast ? 'broadcast' : 'direct';
      const messages = await databaseService.getMessages(deviceId, messageType, limit);
      return messages;
    } catch (error) {
      console.error('âŒ Error getting messages:', error);
      return [];
    }
  }

  async markAsRead(deviceId, isBroadcast = false) {
    try {
      await databaseService.markMessagesAsRead(deviceId, isBroadcast ? 'broadcast' : 'direct');
      this.emitEvent('onUnreadUpdated', await this.getUnreadCounts());
      return true;
    } catch (error) {
      console.error('âŒ Error marking as read:', error);
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
      console.error('âŒ Error getting unread counts:', error);
      return { broadcast: 0, direct: 0, total: 0 };
    }
  }

  async clearAllData() {
    try {
      await databaseService.clearAllMessages();
      this.connectedDevices.clear();
      this.emitEvent('onDataCleared', {});
      console.log('ðŸ—‘ï¸ All data cleared from SQLite');
      return true;
    } catch (error) {
      console.error('âŒ Error clearing data:', error);
      throw error;
    }
  }

  async searchMessages(query) {
    try {
      return await databaseService.searchMessages(query);
    } catch (error) {
      console.error('âŒ Search failed:', error);
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

  isDirectDevice(deviceId) {
    return this._isDirectFresh(deviceId);
  }

  async isReceiverOnline(receiverId) {
    try {
      if (this._isDirectFresh(receiverId)) return true;
      const user = await databaseService.getKnownUser(receiverId);
      if (!user) return false;
      const fresh = Date.now() - user.last_seen <= ANNOUNCE_TTL_MS;
      return user.is_online === 1 && fresh;
    } catch (_e) {
      return false;
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

  getScanHealth() {
    return {
      isInitialized: this.isInitialized,
      isInitializing: this.isInitializing,
      lastAnnounceAt: this.lastAnnounceAt || 0,
      lastDirectScanAt: this.lastDirectScanAt || 0,
      directFreshCount: this._getDirectListFromCache({ freshOnly: true }).length,
      directCachedCount: this.directCache.size,
    };
  }

  // ============ ANNOUNCE (ephemeral broadcast) ============

  async _sendAnnounce() {
    if (!this.myDeviceId || !this.isInitialized) return;
    try {
      const battery = await this._getBattery();
      this.lastAnnounceAt = Date.now();
      // Battery warning â€” one shot per session when critically low
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
    } catch (_e) { /* silent â€” announce is best-effort */ }
  }

  async _handleAnnounce(parsed, rawSenderId) {
    const senderId = parsed.deviceId || rawSenderId;
    if (!senderId || senderId === this.myDeviceId) return;

    // Announce name always wins â€” it's the user's chosen display name
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

  async sendDirectProtocol(receiverId, jsonString) {
    await Bridgefy.sendPayload(receiverId, jsonString);
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
      const { NativeModules } = require('react-native');
      if (!NativeModules || !NativeModules.RNDeviceInfo) return null;
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
          console.log('ðŸ“ Location permission denied â€” location tracking disabled');
          return;
        }
      } catch (_e) {
        console.warn('ðŸ“ Could not request location permission:', _e);
        return;
      }
    }

    const Geolocation = require('react-native-geolocation-service').default;
    if (!Geolocation || typeof Geolocation.getCurrentPosition !== 'function') {
      console.warn('Location service not available — skipping tracking');
      return;
    }
    const fetch = () => {
      Geolocation.getCurrentPosition(
        (pos) => {
          this.myLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude, ts: Date.now() };
          console.log('ðŸ“ Location updated:', this.myLocation.lat.toFixed(4), this.myLocation.lng.toFixed(4));
          if (this.onLocationUpdated) this.onLocationUpdated(this.myLocation);
        },
        (err) => {
          // POSITION_UNAVAILABLE (2) or TIMEOUT (3) are expected when GPS is off â€” suppress noise
          if (err.code !== 2 && err.code !== 3) {
            console.warn('ðŸ“ Location error:', err.message);
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

  setOnLocationUpdated(cb) { this.onLocationUpdated = cb; }

  isBatterySendEnabled() { return this._sendBattery !== false; }
  setBatterySendEnabled(val) { this._sendBattery = val; }

  async getMyBattery() {
    try {
      const { NativeModules } = require('react-native');
      if (!NativeModules || !NativeModules.RNDeviceInfo) return null;
      const DeviceInfo = require('react-native-device-info');
      const level = await DeviceInfo.getBatteryLevel();
      return Math.round(level * 100);
    } catch (_e) {
      return null;
    }
  }

  getDeviceBattery(deviceId) {
    return this.deviceBatteries.get(deviceId) ?? null;
  }

  // ============ SOS BROADCAST ============

  async sendSOS(lat, lng) {
    if (!this.myDeviceId) throw new Error('Mesh not ready');
    const payload = JSON.stringify({
      type: 'sos',
      text: 'ðŸš¨ SOS â€” Emergency',
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
      // Original request was broadcast â€” reply via broadcast so mesh can relay it back
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
      throw new Error(`File too large â€” max ~30 KB (got ${Math.round(base64Data.length * 0.75 / 1024)} KB)`);
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

  async sendBroadcastFile(fileName, mimeType, base64Data, fileSize) {
    if (!this.myDeviceId) throw new Error('Mesh not ready');
    const MAX_FILE_BASE64 = 40960;
    if (base64Data.length > MAX_FILE_BASE64) {
      throw new Error(`File too large â€” max ~30 KB (got ${Math.round(base64Data.length * 0.75 / 1024)} KB)`);
    }
    const payload = JSON.stringify({
      type: 'file',
      text: `[File] ${fileName}`,
      fileName, mimeType, fileSize, data: base64Data,
      senderId: this.myDeviceId, senderName: this.myDeviceName,
      timestamp: Date.now(), isBroadcast: true,
    });
    const response = await Bridgefy.sendBroadcast(payload);
    const dbMsg = this._buildDbMessage({ responseId: response.id, content: payload, messageType: 'broadcast', isBroadcast: true });
    await databaseService.saveMessage(dbMsg);
    return this._buildAppMessage(dbMsg, { contentType: 'file', mediaData: { fileName, mimeType, fileSize, data: base64Data } });
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

  setOnBluetoothStateChangedHandler(callback) {
    this.onBluetoothStateChangedHandler = callback;
  }

  emitEvent(eventName, data) {
    if (this[`${eventName}Handler`]) {
      this[`${eventName}Handler`](data);
    }
  }

  async getBluetoothState() {
    try {
      if (Bridgefy?.getBluetoothState) {
        return await Bridgefy.getBluetoothState();
      }
      return true;
    } catch (_e) {
      return true;
    }
  }

  async stop() {
    try {
      this.stopHealthCheck();
      this.stopAnnounceLoop();
      if (this._appStateSubscription) {
        this._appStateSubscription.remove();
        this._appStateSubscription = null;
      }      if (this._locationInterval) clearInterval(this._locationInterval);
      gatewayService.destroy();
      weatherService.stop();
      await Bridgefy.stop();
      await databaseService.close();
      this.isInitialized = false;
      return true;
    } catch (error) {
      console.error('âŒ Stop failed:', error);
      throw error;
    }
  }
}

// Export singleton instance
export default new BridgefyService();








