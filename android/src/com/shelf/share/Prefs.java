package com.shelf.share;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * App-private settings for the share app. The password never leaves this class
 * in plaintext on disk: {@link SecureStore} encrypts it with an Android
 * Keystore key before it reaches SharedPreferences.
 */
final class Prefs {
    static final String MODE_SELF = "self";
    static final String MODE_CLOUD = "cloud";

    /** The hosted service offered by Shelf; users can point at another URL. */
    static final String DEFAULT_CLOUD_URL = "https://shelfcloud.nuritas.tr";

    private static final String FILE = "shelf_share";
    private static final String KEY_MODE = "mode";
    private static final String KEY_BASE_URL = "base_url";
    private static final String KEY_EMAIL = "email";
    private static final String KEY_DISPLAY_NAME = "display_name";
    private static final String KEY_SECRET = "secret";
    private static final String KEY_PASSWORD = "login_password";

    private final SharedPreferences store;

    Prefs(Context context) {
        store = context.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    String getMode() {
        String mode = store.getString(KEY_MODE, MODE_SELF);
        return MODE_CLOUD.equals(mode) ? MODE_CLOUD : MODE_SELF;
    }

    boolean isCloud() {
        return MODE_CLOUD.equals(getMode());
    }

    String getBaseUrl() {
        return clean(store.getString(KEY_BASE_URL, ""));
    }

    String getEmail() {
        return clean(store.getString(KEY_EMAIL, ""));
    }

    String getDisplayName() {
        String name = clean(store.getString(KEY_DISPLAY_NAME, ""));
        if (!name.isEmpty()) return name;
        String email = getEmail();
        int at = email.indexOf('@');
        return at > 0 ? email.substring(0, at) : "";
    }

    /** True when enough settings exist to try a sign-in. */
    boolean hasConfig() {
        return !getBaseUrl().isEmpty() && !clean(store.getString(KEY_SECRET, "")).isEmpty();
    }

    /**
     * Decrypts the saved password. Throws when the Keystore key is gone or the
     * ciphertext is damaged, so callers can send the user back to setup instead
     * of silently asking for the password again.
     */
    String getSecret() throws SecureStore.SecureStoreException {
        return SecureStore.decrypt(store.getString(KEY_SECRET, ""));
    }

    /**
     * The password used to sign in again. For a self-hosted Worker the API
     * secret is the password itself; for cloud the secret is a token and the
     * password is kept separately so an expired token can be renewed.
     */
    String getPassword() throws SecureStore.SecureStoreException {
        String encrypted = store.getString(KEY_PASSWORD, "");
        if (encrypted.isEmpty()) return getSecret();
        String password = SecureStore.decrypt(encrypted);
        return password.isEmpty() ? getSecret() : password;
    }

    /**
     * Writes the whole configuration at once. Secret and password are encrypted
     * before the write; if encryption fails nothing is saved.
     */
    void save(
        String mode,
        String baseUrl,
        String email,
        String displayName,
        String secret,
        String password
    ) throws SecureStore.SecureStoreException {
        String encryptedSecret = SecureStore.encrypt(secret == null ? "" : secret);
        String encryptedPassword = SecureStore.encrypt(password == null ? "" : password);
        boolean saved = store.edit()
            .putString(KEY_MODE, MODE_CLOUD.equals(mode) ? MODE_CLOUD : MODE_SELF)
            .putString(KEY_BASE_URL, clean(baseUrl))
            .putString(KEY_EMAIL, clean(email))
            .putString(KEY_DISPLAY_NAME, clean(displayName))
            .putString(KEY_SECRET, encryptedSecret)
            .putString(KEY_PASSWORD, encryptedPassword)
            .commit();
        if (!saved) {
            throw new SecureStore.SecureStoreException(
                "Could not write the settings on this device.",
                null
            );
        }
    }

    /** Replaces the API token after a cloud re-login, keeping the password. */
    void updateSecret(String secret) throws SecureStore.SecureStoreException {
        String encrypted = SecureStore.encrypt(secret == null ? "" : secret);
        if (!store.edit().putString(KEY_SECRET, encrypted).commit()) {
            throw new SecureStore.SecureStoreException(
                "Could not write the settings on this device.",
                null
            );
        }
    }

    void clear() {
        store.edit().clear().commit();
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }
}
