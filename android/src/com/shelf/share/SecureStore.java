package com.shelf.share;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Encrypts the saved password with an AES/GCM key that lives in the Android
 * Keystore. The preferences file only ever sees an IV and ciphertext; there is
 * no plaintext fallback. If the Keystore cannot provide a key (a broken or
 * downgraded device), encryption and decryption fail closed with an error the
 * setup screen can show, instead of quietly writing the password in the clear.
 */
final class SecureStore {
    /** A failure the setup screen can show without leaking crypto details. */
    static final class SecureStoreException extends Exception {
        SecureStoreException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "shelf_secret_v1";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final int TAG_BITS = 128;
    private static final int KEY_BITS = 256;
    private static final String PREFIX = "v1:";

    private SecureStore() {
    }

    /** Returns "v1:<base64 iv>:<base64 ciphertext>" for the given plaintext. */
    static String encrypt(String plaintext) throws SecureStoreException {
        String value = plaintext == null ? "" : plaintext;
        try {
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = cipher.getIV();
            byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            return PREFIX
                + Base64.encodeToString(iv, Base64.NO_WRAP)
                + ":"
                + Base64.encodeToString(encrypted, Base64.NO_WRAP);
        } catch (Exception error) {
            throw new SecureStoreException(
                "Could not encrypt the password on this device.",
                error
            );
        }
    }

    /** Reverses {@link #encrypt(String)}; an empty value stays empty. */
    static String decrypt(String stored) throws SecureStoreException {
        if (stored == null || stored.isEmpty()) return "";
        if (!stored.startsWith(PREFIX)) {
            throw new SecureStoreException(
                "The saved password has an unknown format.",
                null
            );
        }
        try {
            String[] parts = stored.substring(PREFIX.length()).split(":", -1);
            if (parts.length != 2 || parts[0].isEmpty() || parts[1].isEmpty()) {
                throw new IllegalStateException("malformed payload");
            }
            byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
            byte[] encrypted = Base64.decode(parts[1], Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(
                Cipher.DECRYPT_MODE,
                key(),
                new GCMParameterSpec(TAG_BITS, iv)
            );
            return new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
        } catch (Exception error) {
            throw new SecureStoreException(
                "Could not read the saved password on this device.",
                error
            );
        }
    }

    private static SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance(KEYSTORE);
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) {
            KeyStore.Entry entry = store.getEntry(KEY_ALIAS, null);
            if (entry instanceof KeyStore.SecretKeyEntry) {
                return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
            }
            throw new IllegalStateException("keystore entry is not an AES key");
        }

        KeyGenerator generator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            KEYSTORE
        );
        generator.init(
            new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(KEY_BITS)
                .build()
        );
        return generator.generateKey();
    }
}
