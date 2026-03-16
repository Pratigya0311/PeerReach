package com.peerreach

import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONObject

// ✅ Bridgefy imports
import me.bridgefy.Bridgefy
import me.bridgefy.commons.TransmissionMode
import me.bridgefy.commons.exception.BridgefyException
import me.bridgefy.commons.listener.BridgefyDelegate
import me.bridgefy.commons.propagation.PropagationProfile
import java.util.*
import kotlin.collections.HashMap

class BridgefyModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    private var bridgefy: Bridgefy? = null
    private var currentUserId: UUID? = null
    private var isStarting: Boolean = false
    private var deviceName: String = "Unknown Device"
    private var connectedDevices = mutableMapOf<UUID, String>()
    private var knownNames = mutableMapOf<UUID, String>()

    override fun getName(): String {
        return "Bridgefy"
    }

    override fun getConstants(): Map<String, Any>? {
        return hashMapOf(
            "deviceName" to android.os.Build.MODEL
        )
    }

    private fun sendEvent(eventName: String, params: WritableMap?) {
        try {
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(eventName, params)
        } catch (e: Exception) {
            Log.e("BridgefyModule", "Failed to send event: $eventName", e)
        }
    }

    private fun parseMessageData(data: ByteArray): Map<String, Any> {
        return try {
            val jsonString = String(data, Charsets.UTF_8)
            val jsonObject = JSONObject(jsonString)
            val map = mutableMapOf<String, Any>()
            
            val keys = jsonObject.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                map[key] = jsonObject.get(key)
            }
            map
        } catch (e: Exception) {
            mapOf("text" to String(data, Charsets.UTF_8))
        }
    }

    private fun addExtraParams(messageData: Map<String, Any>, params: WritableMap) {
        val keys = listOf("announceId", "userId", "userName", "status", "hop", "ts", "targetId")
        for (key in keys) {
            val value = messageData[key] ?: continue
            when (value) {
                is String -> params.putString(key, value)
                is Int -> params.putInt(key, value)
                is Long -> params.putDouble(key, value.toDouble())
                is Double -> params.putDouble(key, value)
                is Boolean -> params.putBoolean(key, value)
                else -> {
                    params.putString(key, value.toString())
                }
            }
        }
    }

    // ✅ Delegate Implementation
    private val bridgefyDelegate = object : BridgefyDelegate {
        override fun onConnected(peerId: UUID) {
            Log.i("BridgefyModule", "Device connected: $peerId")
            connectedDevices[peerId] = "Device_${peerId.toString().substring(0, 8)}"
            
            sendDeviceListUpdate()
            
            val params = Arguments.createMap()
            params.putString("userId", peerId.toString())
            params.putString("deviceName", connectedDevices[peerId] ?: "Unknown")
            sendEvent("onDeviceConnected", params)
        }

        override fun onDisconnected(peerId: UUID) {
            Log.i("BridgefyModule", "Device disconnected: $peerId")
            connectedDevices.remove(peerId)
            
            sendDeviceListUpdate()
            
            val params = Arguments.createMap()
            params.putString("userId", peerId.toString())
            sendEvent("onDeviceLost", params)
        }

        override fun onConnectedPeers(connectedPeers: List<UUID>) {
            Log.i("BridgefyModule", "Connected peers: ${connectedPeers.size}")
            
            connectedPeers.forEach { peerId ->
                if (!connectedDevices.containsKey(peerId)) {
                    connectedDevices[peerId] = "Device_${peerId.toString().substring(0, 8)}"
                }
            }
            
            sendDeviceListUpdate()
        }

        override fun onReceiveData(data: ByteArray, messageID: UUID, transmissionMode: TransmissionMode) {
            try {
                Log.i("BridgefyModule", "Message received, length: ${data.size} bytes")
                
                // Parse the message data
                val messageData = parseMessageData(data)
                val content = messageData["text"] as? String ?: String(data, Charsets.UTF_8)
                val senderId = messageData["senderId"] as? String
                val senderName = messageData["senderName"] as? String
                val messageType = messageData["type"] as? String ?: "text"
                
                val params = Arguments.createMap()
                params.putString("content", content)
                params.putString("messageId", messageID.toString())
                params.putString("timestamp", System.currentTimeMillis().toString())
                params.putString("type", messageType)
                
                if (senderId != null) {
                    params.putString("senderId", senderId)
                }
                
                if (senderName != null) {
                    params.putString("senderName", senderName)
                }

                addExtraParams(messageData, params)
                
                // Store sender info for device name mapping
                if (senderId != null && senderName != null) {
                    try {
                        val uuid = UUID.fromString(senderId)
                        knownNames[uuid] = senderName
                    } catch (e: Exception) {
                        Log.w("BridgefyModule", "Invalid sender ID in message: $senderId")
                    }
                }
                
                // Determine if it's broadcast
                val isBroadcast = transmissionMode is TransmissionMode.Broadcast
                params.putBoolean("isBroadcast", isBroadcast)
                
                if (isBroadcast) {
                    sendEvent("onBroadcastMessageReceived", params)
                } else {
                    sendEvent("onMessageReceived", params)
                }
                
            } catch (e: Exception) {
                Log.e("BridgefyModule", "Error processing message", e)
            }
        }

        override fun onStarted(deviceUUID: UUID) {
            Log.i("BridgefyModule", "Bridgefy started with ID: $deviceUUID")
            currentUserId = deviceUUID
            isStarting = false
            
            // Get device name from build
            deviceName = android.os.Build.MODEL
            
            val params = Arguments.createMap()
            params.putString("userUuid", deviceUUID.toString())
            params.putString("deviceName", deviceName)
            sendEvent("onRegistrationSuccessful", params)
        }

        override fun onFailToStart(error: BridgefyException) {
            Log.e("BridgefyModule", "Failed to start: ${error.message}")
            isStarting = false
            
            val params = Arguments.createMap()
            params.putString("message", error.message)
            sendEvent("onRegistrationFailed", params)
        }

        override fun onStopped() {
            Log.i("BridgefyModule", "Bridgefy stopped")
            connectedDevices.clear()
            currentUserId = null
            isStarting = false
            sendEvent("onStopped", null)
        }

        override fun onFailToStop(error: BridgefyException) {
            Log.e("BridgefyModule", "Failed to stop: ${error.message}")
        }

        override fun onSend(messageID: UUID) {
            Log.i("BridgefyModule", "Message sent: $messageID")
            
            val params = Arguments.createMap()
            params.putString("messageId", messageID.toString())
            sendEvent("onMessageSent", params)
        }

        override fun onProgressOfSend(messageID: UUID, position: Int, of: Int) {
            // Optional progress tracking
        }

        override fun onFailToSend(messageID: UUID, error: BridgefyException) {
            Log.e("BridgefyModule", "Failed to send $messageID: ${error.message}")
            
            val params = Arguments.createMap()
            params.putString("messageId", messageID.toString())
            params.putString("error", error.message)
            sendEvent("onMessageSendFailed", params)
        }

        override fun onDestroySession() {}
        override fun onFailToDestroySession(error: BridgefyException) {}
        override fun onEstablishSecureConnection(userId: UUID) {}
        override fun onFailToEstablishSecureConnection(userId: UUID, error: BridgefyException) {}
    }

    private fun sendDeviceListUpdate() {
        val devicesArray = Arguments.createArray()
        
        connectedDevices.forEach { (peerId, deviceName) ->
            val deviceMap = Arguments.createMap()
            deviceMap.putString("id", peerId.toString())
            deviceMap.putString("name", deviceName)
            devicesArray.pushMap(deviceMap)
        }
        
        val params = Arguments.createMap()
        params.putArray("devices", devicesArray)
        sendEvent("onDeviceListUpdated", params)
    }

    @ReactMethod
    fun initialize(apiKey: String) {
        try {
            if (currentUserId != null) {
                val params = Arguments.createMap()
                params.putString("userUuid", currentUserId.toString())
                params.putString("deviceName", deviceName)
                sendEvent("onRegistrationSuccessful", params)
                return
            }
            if (isStarting) {
                return
            }
            isStarting = true
            Log.i("BridgefyModule", "Initializing with API key: $apiKey")
            
            // Get device name
            deviceName = android.os.Build.MODEL
            
            // ✅ 1. Instantiate Bridgefy
            bridgefy = Bridgefy(reactApplicationContext)

            // ✅ 2. Initialize with API Key
            val apiKeyUUID = UUID.fromString(apiKey)
            
            bridgefy?.init(
                apiKeyUUID,         // Arg 1: API Key (UUID)
                bridgefyDelegate    // Arg 2: Delegate
            )

            // ✅ 3. Start the service
            bridgefy?.start(null, PropagationProfile.Standard)

        } catch (e: IllegalArgumentException) {
            Log.e("BridgefyModule", "Invalid API key format", e)
            val params = Arguments.createMap()
            params.putString("error", "Invalid API key format. Must be a valid UUID.")
            sendEvent("onStartError", params)
        } catch (e: Exception) {
            Log.e("BridgefyModule", "Initialization failed", e)
            val params = Arguments.createMap()
            params.putString("error", e.message ?: "Unknown error")
            sendEvent("onStartError", params)
        }
    }

    @ReactMethod
    fun getMyDeviceId(promise: Promise) {
        currentUserId?.let {
            promise.resolve(it.toString())
        } ?: run {
            promise.resolve("initializing...")
        }
    }

    @ReactMethod
    fun getMyDeviceName(promise: Promise) {
        promise.resolve(deviceName)
    }

    @ReactMethod
    fun sendMessage(receiverId: String, text: String, promise: Promise) {
        try {
            val receiverUUID = UUID.fromString(receiverId)
            
            // Create structured message with sender info
            val messageObject = mapOf(
                "type" to "text",
                "text" to text,
                "senderId" to currentUserId.toString(),
                "senderName" to deviceName,
                "timestamp" to System.currentTimeMillis(),
                "isBroadcast" to false
            )
            
            val jsonString = JSONObject(messageObject).toString()
            val bytes = jsonString.toByteArray(Charsets.UTF_8)
            
            // Send using P2P transmission
            bridgefy?.send(bytes, TransmissionMode.P2P(receiverUUID))
            
            // Create response
            val result = Arguments.createMap()
            result.putString("id", UUID.randomUUID().toString())
            result.putString("text", text)
            result.putString("senderId", currentUserId.toString())
            result.putString("senderName", deviceName)
            result.putString("receiverId", receiverId)
            result.putString("timestamp", System.currentTimeMillis().toString())
            result.putBoolean("isMine", true)
            result.putBoolean("isBroadcast", false)
            
            promise.resolve(result)
        } catch (e: IllegalArgumentException) {
            promise.reject("INVALID_RECEIVER_ID", "Invalid receiver ID format")
        } catch (e: Exception) {
            promise.reject("SEND_ERROR", e.message ?: "Failed to send message")
        }
    }

    @ReactMethod
    fun sendMeshMessage(receiverId: String, text: String, promise: Promise) {
        try {
            val receiverUUID = UUID.fromString(receiverId)

            val messageObject = mapOf(
                "type" to "text",
                "text" to text,
                "senderId" to currentUserId.toString(),
                "senderName" to deviceName,
                "timestamp" to System.currentTimeMillis(),
                "isBroadcast" to false
            )

            val jsonString = JSONObject(messageObject).toString()
            val bytes = jsonString.toByteArray(Charsets.UTF_8)

            bridgefy?.send(bytes, TransmissionMode.Mesh(receiverUUID))

            val result = Arguments.createMap()
            result.putString("id", UUID.randomUUID().toString())
            result.putString("text", text)
            result.putString("senderId", currentUserId.toString())
            result.putString("senderName", deviceName)
            result.putString("receiverId", receiverId)
            result.putString("timestamp", System.currentTimeMillis().toString())
            result.putBoolean("isMine", true)
            result.putBoolean("isBroadcast", false)

            promise.resolve(result)
        } catch (e: IllegalArgumentException) {
            promise.reject("INVALID_RECEIVER_ID", "Invalid receiver ID format")
        } catch (e: Exception) {
            promise.reject("SEND_ERROR", e.message ?: "Failed to send mesh message")
        }
    }

    @ReactMethod
    fun sendBroadcastPayload(payloadJson: String, promise: Promise) {
        try {
            val userId = currentUserId ?: run {
                promise.reject("USER_NOT_INITIALIZED", "User not initialized yet")
                return
            }

            val jsonObject = JSONObject(payloadJson)
            if (!jsonObject.has("senderId")) {
                jsonObject.put("senderId", userId.toString())
            }
            if (!jsonObject.has("senderName")) {
                jsonObject.put("senderName", deviceName)
            }
            if (!jsonObject.has("timestamp")) {
                jsonObject.put("timestamp", System.currentTimeMillis())
            }

            val bytes = jsonObject.toString().toByteArray(Charsets.UTF_8)
            bridgefy?.send(bytes, TransmissionMode.Broadcast(userId))
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("BROADCAST_ERROR", e.message ?: "Failed to send broadcast payload")
        }
    }

    @ReactMethod
    fun sendBroadcast(text: String, promise: Promise) {
        try {
            currentUserId?.let { userId ->
                // Create structured message with sender info
                val messageObject = mapOf(
                    "type" to "text",
                    "text" to text,
                    "senderId" to userId.toString(),
                    "senderName" to deviceName,
                    "timestamp" to System.currentTimeMillis(),
                    "isBroadcast" to true
                )
                
                val jsonString = JSONObject(messageObject).toString()
                val bytes = jsonString.toByteArray(Charsets.UTF_8)
                
                bridgefy?.send(bytes, TransmissionMode.Broadcast(userId))
                
                // Create response
                val result = Arguments.createMap()
                result.putString("id", UUID.randomUUID().toString())
                result.putString("text", text)
                result.putString("senderId", userId.toString())
                result.putString("senderName", deviceName)
                result.putString("timestamp", System.currentTimeMillis().toString())
                result.putBoolean("isMine", true)
                result.putBoolean("isBroadcast", true)
                
                promise.resolve(result)
            } ?: run {
                promise.reject("USER_NOT_INITIALIZED", "User not initialized yet")
            }
        } catch (e: Exception) {
            promise.reject("BROADCAST_ERROR", e.message ?: "Failed to broadcast")
        }
    }
    
    @ReactMethod
    fun stop() {
        bridgefy?.stop()
    }

    @ReactMethod
    fun getConnectedDevices(promise: Promise) {
        val devicesArray = Arguments.createArray()
        
        connectedDevices.forEach { (peerId, deviceName) ->
            val deviceMap = Arguments.createMap()
            deviceMap.putString("id", peerId.toString())
            deviceMap.putString("name", deviceName)
            devicesArray.pushMap(deviceMap)
        }
        
        promise.resolve(devicesArray)
    }
}
