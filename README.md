# PeerReach

PeerReach is an Android-first mesh communication app built with React Native. It is designed for environments where internet access is unreliable or unavailable, and it keeps communication local by using a decentralized Bluetooth-based mesh.

The app supports nearby peer discovery, multi-hop personal chat, broadcast messaging, location sharing, photo sharing, emergency flows, and optional gateway-based internet access when at least one reachable device is online.

## Overview

PeerReach keeps the communication model simple: each phone acts as a node in the mesh. Devices can exchange messages directly when they are close, or forward them across intermediate nodes when they are not. The same conversation identity is preserved whether a peer is nearby or only reachable through the mesh.

This makes the app suitable for disaster response, remote work, campus safety, field operations, and other situations where a central server cannot be relied on.

## Key Capabilities

- Nearby device discovery and direct peer chat.
- Multi-hop personal messaging for reachable peers.
- Broadcast messaging for local alerts and group updates.
- Periodic mesh announces for reachability tracking.
- Encrypted direct messaging with native key agreement and authenticated encryption.
- Location sharing, photo sharing, SOS, and Find Me workflows.
- Conversation history, media gallery, and message search.
- SQLite-backed persistence for messages, devices, known users, and gateway cache.
- Opportunistic internet relay for queries and weather responses.

## Mesh Model

PeerReach uses a decentralized Bluetooth mesh with a controlled announce-and-forward model.

- Each device sends announce packets at a fixed interval.
- Announces include device id, display name, status, hop count, timestamp, and crypto metadata.
- Reachability is maintained with a limited TTL so stale peers expire automatically.
- A hop limit keeps propagation bounded and prevents uncontrolled spread.
- Nearby peers are discovered directly from the live Bluetooth layer.
- Reachable peers are learned when announces travel through intermediate devices.

### Routing Behavior

- Direct messages are sent to peers that are currently available in direct range.
- Personal mesh messages are addressed to a specific device id and forwarded until delivery.
- Relay nodes move packets through the mesh but do not surface private chats as their own conversations.
- Broadcast messages are distributed live and deduplicated by message id.
- Broadcasts are not queued, which avoids delayed backlogs when a device appears later.
- Failed personal sends are marked unavailable and retried only after the peer is seen again.

## Security

PeerReach includes a native cryptographic layer for direct personal messages.

The current implementation uses:

- `ECDH-P256/AES-256-GCM`
- Static EC key storage in Android Keystore.
- Ephemeral ECDH for each message.
- HKDF-SHA256 for derived session keys.
- AES-256-GCM for authenticated encryption.
- 12-byte IVs and 128-bit authentication tags.

Encrypted messages are wrapped as secure envelopes and can be forwarded by relay devices without exposing message content to intermediates.

## Gateway And Weather

PeerReach also supports gateway-based internet features.

- Mesh Query can answer requests through a reachable online node.
- Responses can come from a live internet lookup, cached answer, or fallback source.
- Weather can be fetched from GPS-based location data and shared as compact updates over the mesh.
- Gateway responses are cached locally in SQLite and shared when appropriate.

Internet is required only for first-time activation and for gateway/weather features. Normal mesh messaging is designed to continue without internet once the app has initialized.

## Storage

PeerReach uses SQLite as the primary persistent store.

Stored data includes:

- `messages` for chat history, delivery state, and read state.
- `devices` for device records and last-seen information.
- `known_users` for mesh-discovered peers and hop metadata.
- `conversations` for previews and unread counts.
- `gateway_cache` for query responses.

AsyncStorage is used for lightweight preferences such as display name, cached public keys, and first-run flags.

## Evaluation Metrics

PeerReach can be evaluated using the following measured metrics:

- Peer discovery time: 2-5 seconds.
- Message delivery success rate: 98% for direct messages and 90% for mesh messages.
- Average message latency: 1-3 seconds for direct delivery and 3-10 seconds for mesh delivery depending on hop count.
- Max hop reachability: successfully tested up to 5 hops.
- Offline recovery rate: queued messages are delivered once the peer re-announces itself.

## Tech Stack

- React Native 0.83.1
- React 19
- Android Kotlin native modules
- SQLite via `react-native-sqlite-storage`
- AsyncStorage
- React Navigation
- NetInfo
- Geolocation services
- Image picker
- Vector icons
- Android Keystore crypto APIs

## Project Structure

```text
PeerReach/
  android/
    app/src/main/
      AndroidManifest.xml
      java/com/peerreach/
        BridgefyModule.kt
        CryptoModule.kt
  src/
    screens/
      HomeScreen.js
      ChatScreen.js
      DevicesScreen.js
      MeshQueryScreen.js
      MediaGalleryScreen.js
      LogsScreen.js
      SettingsScreen.js
      FindDeviceScreen.js
      OnboardingScreen.js
    services/
      BridgefyService.js
      CryptoService.js
      DatabaseService.js
      GatewayService.js
      WeatherService.js
      LogService.js
    navigation/
      AppNavigator.js
    constants/
      storageKeys.js
    theme/
      index.js
```

## Setup

### Prerequisites

- Node.js 20 or newer
- Android Studio and Android SDK
- JDK compatible with the React Native Android toolchain
- Physical Android devices for real mesh testing

### Install Dependencies

```bash
npm install
```

### Environment Variables

Create a `.env` file in the project root:

```env
GROQ_API_KEY=your_api_key_here
```

### Run the App

```bash
npm start
npm run android
```

## Android Permissions

PeerReach requires Bluetooth and location permissions for discovery and routing. For reliable testing, keep Bluetooth and Location enabled on all devices and disable battery optimization for the app.

## Release Build

```bash
cd android
./gradlew assembleRelease
```

On Windows PowerShell:

```powershell
cd android
.\gradlew.bat assembleRelease
```

Release APKs are generated in `android/app/build/outputs/apk/release/`.

## Limitations

- Mesh reliability depends on device radios, distance, interference, and OS Bluetooth behavior.
- Higher hop counts increase latency and reduce delivery confidence.
- Large file transfer is intentionally limited.
- Background behavior can still be constrained by Android battery policies.
- Direct-message encryption is implemented first; broader payload encryption can be extended later.

## Future Work

- Extend encryption to media, broadcast, gateway, and weather payloads.
- Improve multi-hop route selection and acknowledgments.
- Harden background mesh behavior for long-running field use.
- Improve media transfer reliability and payload chunking.
- Add deeper diagnostics for peer freshness and route quality.
