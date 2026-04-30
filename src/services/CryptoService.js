import { NativeModules } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const { CryptoModule } = NativeModules;

const PEER_PUBLIC_KEYS_STORAGE_KEY = '@peerreach_peer_public_keys_v1';

export const DIRECT_CRYPTO_ALG = 'ECDH-P256/AES-256-GCM';
export const SECURE_ENVELOPE_TYPE = 'secure_envelope';
export const CRYPTO_KEY_REQUEST_TYPE = 'crypto_key_request';
export const CRYPTO_KEY_ADVERT_TYPE = 'crypto_key_advert';

class CryptoService {
  constructor() {
    this.peerPublicKeys = new Map();
    this.myPublicKey = null;
    this._loadPromise = null;
  }

  isAvailable() {
    return Boolean(
      CryptoModule?.getPublicKey &&
      CryptoModule?.encryptForPeer &&
      CryptoModule?.decryptFromPeer
    );
  }

  async _ensureLoaded() {
    if (this._loadPromise) {
      return this._loadPromise;
    }

    this._loadPromise = (async () => {
      try {
        const raw = await AsyncStorage.getItem(PEER_PUBLIC_KEYS_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          Object.entries(parsed).forEach(([deviceId, publicKey]) => {
            if (deviceId && publicKey) {
              this.peerPublicKeys.set(deviceId, publicKey);
            }
          });
        }
      } catch (_error) {
        this.peerPublicKeys.clear();
      }

      if (this.isAvailable()) {
        try {
          this.myPublicKey = await CryptoModule.getPublicKey();
        } catch (_error) {
          this.myPublicKey = null;
        }
      }
    })();

    return this._loadPromise;
  }

  async ensureReady() {
    await this._ensureLoaded();
    if (!this.myPublicKey && this.isAvailable()) {
      this.myPublicKey = await CryptoModule.getPublicKey();
    }
    return Boolean(this.myPublicKey);
  }

  async getMyPublicKey() {
    await this.ensureReady();
    return this.myPublicKey;
  }

  async getPeerPublicKey(deviceId) {
    await this._ensureLoaded();
    return this.peerPublicKeys.get(deviceId) || null;
  }

  async hasPeerPublicKey(deviceId) {
    return Boolean(await this.getPeerPublicKey(deviceId));
  }

  async rememberPeerPublicKey(deviceId, publicKey) {
    const normalizedId = String(deviceId || '').trim();
    const normalizedKey = String(publicKey || '').trim();
    if (!normalizedId || !normalizedKey) {
      return false;
    }

    await this._ensureLoaded();
    if (this.peerPublicKeys.get(normalizedId) === normalizedKey) {
      return false;
    }

    this.peerPublicKeys.set(normalizedId, normalizedKey);
    await AsyncStorage.setItem(
      PEER_PUBLIC_KEYS_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(this.peerPublicKeys.entries()))
    );
    return true;
  }

  _buildAad({ senderId, senderName, receiverId, timestamp, kind = 'direct' }) {
    return JSON.stringify({
      version: 1,
      alg: DIRECT_CRYPTO_ALG,
      kind,
      senderId: senderId || '',
      senderName: senderName || '',
      receiverId: receiverId || '',
      timestamp: timestamp || Date.now(),
    });
  }

  async buildKeyAdvertPayload(senderId, senderName) {
    const publicKey = await this.getMyPublicKey();
    if (!publicKey) {
      throw new Error('Secure direct messaging is not available on this build.');
    }

    return JSON.stringify({
      type: CRYPTO_KEY_ADVERT_TYPE,
      version: 1,
      alg: DIRECT_CRYPTO_ALG,
      senderId,
      senderName,
      timestamp: Date.now(),
      cryptoPublicKey: publicKey,
    });
  }

  async buildKeyRequestPayload(senderId, senderName) {
    const publicKey = await this.getMyPublicKey();

    return JSON.stringify({
      type: CRYPTO_KEY_REQUEST_TYPE,
      version: 1,
      alg: DIRECT_CRYPTO_ALG,
      senderId,
      senderName,
      timestamp: Date.now(),
      cryptoPublicKey: publicKey || null,
    });
  }

  async encryptForPeer(deviceId, plaintext, metadata) {
    if (!this.isAvailable()) {
      throw new Error('Secure direct messaging is not available on this build.');
    }

    const peerPublicKey = await this.getPeerPublicKey(deviceId);
    if (!peerPublicKey) {
      return null;
    }

    const senderPublicKey = await this.getMyPublicKey();
    if (!senderPublicKey) {
      throw new Error('Secure direct messaging is not ready yet.');
    }

    const timestamp = metadata?.timestamp || Date.now();
    const aad = this._buildAad({
      senderId: metadata?.senderId,
      senderName: metadata?.senderName,
      receiverId: deviceId,
      timestamp,
      kind: metadata?.kind || 'direct',
    });

    const encrypted = await CryptoModule.encryptForPeer(peerPublicKey, plaintext, aad);
    return JSON.stringify({
      type: SECURE_ENVELOPE_TYPE,
      version: 1,
      alg: DIRECT_CRYPTO_ALG,
      senderId: metadata?.senderId || '',
      senderName: metadata?.senderName || '',
      receiverId: deviceId,
      timestamp,
      senderPublicKey,
      aad,
      iv: encrypted.iv,
      ephemeralPublicKey: encrypted.ephemeralPublicKey,
      ciphertext: encrypted.ciphertext,
    });
  }

  async decryptEnvelope(rawEnvelope) {
    if (!this.isAvailable()) {
      throw new Error('Secure direct messaging is not available on this build.');
    }

    const envelope = typeof rawEnvelope === 'string' ? JSON.parse(rawEnvelope) : rawEnvelope;
    if (!envelope || envelope.type !== SECURE_ENVELOPE_TYPE) {
      return null;
    }

    if (envelope.senderId && envelope.senderPublicKey) {
      await this.rememberPeerPublicKey(envelope.senderId, envelope.senderPublicKey);
    }

    const plaintext = await CryptoModule.decryptFromPeer(
      envelope.ephemeralPublicKey,
      envelope.ciphertext,
      envelope.iv,
      envelope.aad || ''
    );

    return { envelope, plaintext };
  }
}

export default new CryptoService();
