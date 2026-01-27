import { NativeModules, NativeEventEmitter, Platform } from 'react-native';

const { Bridgefy } = NativeModules;
const bridgefyEmitter = new NativeEventEmitter(Bridgefy);

class BridgefyService {
  constructor() {
    this.deviceListListener = null;
    this.messageListener = null;
    this.connectionListener = null;
    this.connectedDevices = new Map();
    this.myDeviceId = null;
    this.myDeviceName = Platform.OS === 'android' ? Bridgefy.deviceName || 'Android Device' : 'iOS Device';

    bridgefyEmitter.addListener('onRegistrationSuccessful', (data) => {
      console.log('JS: Registration successful', data);
      this.myDeviceId = data.userUuid;
      if (data.deviceName) {
        this.myDeviceName = data.deviceName;
      }
    });

    bridgefyEmitter.addListener('onDeviceListUpdated', (data) => {
      console.log('JS: Device List Updated', data.devices);
      if (this.deviceListListener && data.devices) {
        this.deviceListListener(data.devices);
      }
    });

    bridgefyEmitter.addListener('onMessageReceived', (message) => {
      console.log('JS: Direct Message Received', message);
      if (this.messageListener) {
        const senderId = message.senderId || 'unknown';
        const senderName = message.senderName || this.connectedDevices.get(senderId) || `Device_${senderId.substring(0, 8)}`;

        if (senderId && senderName && senderId !== 'unknown') {
          this.connectedDevices.set(senderId, senderName);
        }
        
        this.messageListener({
          id: message.messageId || Date.now().toString(),
          text: message.content || '',
          senderId: senderId,
          senderName: senderName,
          timestamp: parseInt(message.timestamp) || Date.now(),
          isMine: false,
          isBroadcast: false,
          type: message.type || 'text'
        });
      }
    });

    bridgefyEmitter.addListener('onBroadcastMessageReceived', (message) => {
      console.log('JS: Broadcast Message Received', message);
      if (this.messageListener) {
        const senderId = message.senderId || 'unknown';
        const senderName = message.senderName || this.connectedDevices.get(senderId) || `Broadcast_${senderId.substring(0, 8)}`;

        if (senderId && senderName && senderId !== 'unknown') {
          this.connectedDevices.set(senderId, senderName);
        }
        
        this.messageListener({
          id: message.messageId || Date.now().toString(),
          text: message.content || '',
          senderId: senderId,
          senderName: senderName,
          timestamp: parseInt(message.timestamp) || Date.now(),
          isMine: false,
          isBroadcast: true,
          type: message.type || 'text'
        });
      }
    });

    bridgefyEmitter.addListener('onDeviceConnected', (device) => {
      console.log('JS: Device Connected', device);
      if (device.userId && device.deviceName) {
        this.connectedDevices.set(device.userId, device.deviceName);
      }
    });

    bridgefyEmitter.addListener('onDeviceLost', (device) => {
      console.log('JS: Device Lost', device);
      if (device.userId) {
        this.connectedDevices.delete(device.userId);
      }
    });

    bridgefyEmitter.addListener('onMessageSent', (data) => {
      console.log('JS: Message Sent', data);
    });

    bridgefyEmitter.addListener('onStartError', (error) => {
      console.error('JS: Start Error', error);
    });

    bridgefyEmitter.addListener('onRegistrationFailed', (error) => {
      console.error('JS: Registration Failed', error);
    });
  }

  async initialize(apiKey) {
    console.log('JS: Initializing Bridgefy with API key:', apiKey);
    try {
      await Bridgefy.initialize(apiKey);
      console.log('JS: Bridgefy initialized successfully');

      setTimeout(async () => {
        try {
          const id = await this.getMyDeviceId();
          const name = await this.getMyDeviceName();
          if (id && id !== 'initializing...') {
            this.myDeviceId = id;
          }
          if (name) {
            this.myDeviceName = name;
          }
        } catch (e) {
          console.log('JS: Could not get device info yet');
        }
      }, 2000);
      
    } catch (error) {
      console.error('JS Init Error:', error);
      throw error;
    }
  }

  async getMyDeviceId() {
    try {
      const id = await Bridgefy.getMyDeviceId();
      if (id && id !== 'initializing...') {
        this.myDeviceId = id;
      }
      return id || 'unknown';
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

  async sendMessage(receiverId, text) {
    try {
      console.log(`JS: Sending to ${receiverId}: ${text}`);
      const message = await Bridgefy.sendMessage(receiverId, text);
      return {
        id: message.id || Date.now().toString(),
        text: message.text || text,
        senderId: this.myDeviceId || message.senderId,
        senderName: this.myDeviceName,
        receiverId: receiverId,
        timestamp: parseInt(message.timestamp) || Date.now(),
        isMine: true,
        isBroadcast: false,
        type: 'text'
      };
    } catch (error) {
      console.error('JS Send Error:', error);
      throw error;
    }
  }

  async sendBroadcast(text) {
    try {
      console.log(`JS: Broadcasting: ${text}`);
      const message = await Bridgefy.sendBroadcast(text);
      return {
        id: message.id || Date.now().toString(),
        text: message.text || text,
        senderId: this.myDeviceId || message.senderId,
        senderName: this.myDeviceName,
        timestamp: parseInt(message.timestamp) || Date.now(),
        isMine: true,
        isBroadcast: true,
        type: 'text'
      };
    } catch (error) {
      console.error('JS Broadcast Error:', error);
      throw error;
    }
  }

  async getConnectedDevices() {
    try {
      const devices = await Bridgefy.getConnectedDevices();
      return devices || [];
    } catch (error) {
      console.log('JS: Error getting connected devices, returning cached', error);
      const devicesArray = [];
      this.connectedDevices.forEach((name, id) => {
        devicesArray.push({ id, name });
      });
      return devicesArray;
    }
  }

  async stop() {
    try {
      await Bridgefy.stop();
      this.connectedDevices.clear();
      this.myDeviceId = null;
    } catch (error) {
      console.error('JS Stop Error:', error);
    }
  }

  setDeviceListListener(callback) {
    this.deviceListListener = callback;
  }

  setMessageListener(callback) {
    this.messageListener = callback;
  }
}

export default new BridgefyService();