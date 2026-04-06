package com.peerreach

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.ByteArrayOutputStream
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.PublicKey
import java.security.SecureRandom
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class CryptoModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
    companion object {
        private const val KEY_ALIAS = "peerreach_direct_static_key_v1"
        private const val KEYSTORE_PROVIDER = "AndroidKeyStore"
        private const val CURVE_NAME = "secp256r1"
        private const val AES_MODE = "AES/GCM/NoPadding"
        private const val HKDF_ALGORITHM = "HmacSHA256"
        private const val HKDF_INFO = "PeerReach-Direct-v1"
        private const val GCM_TAG_BITS = 128
        private const val IV_LENGTH_BYTES = 12
        private const val AES_KEY_BYTES = 32
    }

    override fun getName(): String = "CryptoModule"

    @ReactMethod
    fun getPublicKey(promise: Promise) {
        try {
            val keyPair = getOrCreateStaticKeyPair()
            promise.resolve(encodeBase64(keyPair.public.encoded))
        } catch (error: Exception) {
            promise.reject("CRYPTO_PUBLIC_KEY_ERROR", error.message, error)
        }
    }

    @ReactMethod
    fun encryptForPeer(peerPublicKey: String, plaintext: String, aad: String?, promise: Promise) {
        try {
            val peerKey = decodePublicKey(peerPublicKey)
            val ephemeralKeyPair = generateEphemeralKeyPair()
            val aesKey = deriveAesKey(ephemeralKeyPair.private, peerKey)
            val iv = ByteArray(IV_LENGTH_BYTES).also { SecureRandom().nextBytes(it) }
            val ciphertext = aesGcmEncrypt(aesKey, iv, plaintext.toByteArray(Charsets.UTF_8), aad)

            val result = Arguments.createMap()
            result.putString("ciphertext", encodeBase64(ciphertext))
            result.putString("iv", encodeBase64(iv))
            result.putString("ephemeralPublicKey", encodeBase64(ephemeralKeyPair.public.encoded))
            promise.resolve(result)
        } catch (error: Exception) {
            promise.reject("CRYPTO_ENCRYPT_ERROR", error.message, error)
        }
    }

    @ReactMethod
    fun decryptFromPeer(ephemeralPublicKey: String, ciphertext: String, iv: String, aad: String?, promise: Promise) {
        try {
            val staticKeyPair = getOrCreateStaticKeyPair()
            val peerKey = decodePublicKey(ephemeralPublicKey)
            val aesKey = deriveAesKey(staticKeyPair.private, peerKey)
            val plaintext = aesGcmDecrypt(
                aesKey = aesKey,
                iv = decodeBase64(iv),
                ciphertext = decodeBase64(ciphertext),
                aad = aad,
            )
            promise.resolve(String(plaintext, Charsets.UTF_8))
        } catch (error: Exception) {
            promise.reject("CRYPTO_DECRYPT_ERROR", error.message, error)
        }
    }

    private fun getOrCreateStaticKeyPair(): KeyPair {
        val keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }
        val existingEntry = keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.PrivateKeyEntry
        if (existingEntry != null) {
            return KeyPair(existingEntry.certificate.publicKey, existingEntry.privateKey)
        }

        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE_PROVIDER)
        val spec = KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_AGREE_KEY)
            .setAlgorithmParameterSpec(ECGenParameterSpec(CURVE_NAME))
            .setUserAuthenticationRequired(false)
            .build()
        generator.initialize(spec)
        return generator.generateKeyPair()
    }

    private fun generateEphemeralKeyPair(): KeyPair {
        val generator = KeyPairGenerator.getInstance("EC")
        generator.initialize(ECGenParameterSpec(CURVE_NAME))
        return generator.generateKeyPair()
    }

    private fun decodePublicKey(publicKeyBase64: String): PublicKey {
        val keyFactory = KeyFactory.getInstance("EC")
        val keySpec = X509EncodedKeySpec(decodeBase64(publicKeyBase64))
        return keyFactory.generatePublic(keySpec)
    }

    private fun deriveAesKey(privateKey: PrivateKey, peerPublicKey: PublicKey): ByteArray {
        val agreement = KeyAgreement.getInstance("ECDH")
        agreement.init(privateKey)
        agreement.doPhase(peerPublicKey, true)
        val sharedSecret = agreement.generateSecret()
        return hkdfSha256(
            inputKeyMaterial = sharedSecret,
            salt = null,
            info = HKDF_INFO.toByteArray(Charsets.UTF_8),
            outputLength = AES_KEY_BYTES,
        )
    }

    private fun aesGcmEncrypt(aesKey: ByteArray, iv: ByteArray, plaintext: ByteArray, aad: String?): ByteArray {
        val cipher = Cipher.getInstance(AES_MODE)
        val spec = GCMParameterSpec(GCM_TAG_BITS, iv)
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(aesKey, "AES"), spec)
        if (!aad.isNullOrEmpty()) {
            cipher.updateAAD(aad.toByteArray(Charsets.UTF_8))
        }
        return cipher.doFinal(plaintext)
    }

    private fun aesGcmDecrypt(aesKey: ByteArray, iv: ByteArray, ciphertext: ByteArray, aad: String?): ByteArray {
        val cipher = Cipher.getInstance(AES_MODE)
        val spec = GCMParameterSpec(GCM_TAG_BITS, iv)
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(aesKey, "AES"), spec)
        if (!aad.isNullOrEmpty()) {
            cipher.updateAAD(aad.toByteArray(Charsets.UTF_8))
        }
        return cipher.doFinal(ciphertext)
    }

    private fun hkdfSha256(
        inputKeyMaterial: ByteArray,
        salt: ByteArray?,
        info: ByteArray,
        outputLength: Int,
    ): ByteArray {
        val effectiveSalt = salt ?: ByteArray(32)
        val pseudorandomKey = hmacSha256(effectiveSalt, inputKeyMaterial)
        val output = ByteArrayOutputStream()
        var block = ByteArray(0)
        var counter = 1

        while (output.size() < outputLength) {
            val mac = Mac.getInstance(HKDF_ALGORITHM)
            mac.init(SecretKeySpec(pseudorandomKey, HKDF_ALGORITHM))
            mac.update(block)
            mac.update(info)
            mac.update(counter.toByte())
            block = mac.doFinal()
            output.write(block)
            counter += 1
        }

        return output.toByteArray().copyOf(outputLength)
    }

    private fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance(HKDF_ALGORITHM)
        mac.init(SecretKeySpec(key, HKDF_ALGORITHM))
        return mac.doFinal(data)
    }

    private fun encodeBase64(value: ByteArray): String {
        return Base64.encodeToString(value, Base64.NO_WRAP)
    }

    private fun decodeBase64(value: String): ByteArray {
        return Base64.decode(value, Base64.DEFAULT)
    }
}
