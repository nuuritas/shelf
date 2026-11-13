package com.shelf.share;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.widget.Toast;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Invisible share target: no window, no card. It reads the saved server at
 * runtime, posts the first link in the shared text, shows one short toast, then
 * finishes. If the app has not been set up yet the link is carried into setup
 * and saved right after the user connects.
 */
public class ShareActivity extends Activity {
    private static final Pattern LINK = Pattern.compile("https?://\\S+", Pattern.CASE_INSENSITIVE);

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        final Prefs prefs = new Prefs(this);
        final String link = extractLink(sharedText(getIntent()));
        if (link == null) {
            toast("Share a post link", 1800);
            return;
        }
        if (!prefs.hasConfig()) {
            promptSetup(link);
            return;
        }

        final String base = prefs.getBaseUrl();
        final String mode = prefs.getMode();
        final String email = prefs.getEmail();

        new Thread(new Runnable() {
            @Override
            public void run() {
                final boolean cloud = Prefs.MODE_CLOUD.equals(mode);
                String secret;
                String password;
                try {
                    secret = prefs.getSecret();
                    password = cloud ? prefs.getPassword() : secret;
                } catch (SecureStore.SecureStoreException failure) {
                    promptSetup(link);
                    return;
                }

                try {
                    String url = ApiClient.expandShortLink(link);
                    ApiClient.Result result = ApiClient.postBookmark(base, secret, url);
                    if (result.code == 401 && cloud) {
                        // The cloud token can expire; renew it once with the saved
                        // password before giving up.
                        ApiClient.LoginResult login = ApiClient.loginCloud(base, email, password);
                        if (!login.ok) {
                            reportLoginFailure(login.message);
                            return;
                        }
                        try {
                            prefs.updateSecret(login.token);
                        } catch (SecureStore.SecureStoreException ignored) {
                            // Retry this share with the fresh token anyway.
                        }
                        result = ApiClient.postBookmark(base, login.token, url);
                    }
                    report(result);
                } catch (ApiClient.ApiException failure) {
                    toast(failure.getMessage(), 2200);
                } catch (Exception failure) {
                    toast("Not saved: network error", 2000);
                }
            }
        }).start();
    }

    private void report(ApiClient.Result result) {
        if (result.code >= 200 && result.code < 300) {
            Notifications.checkSoon(getApplicationContext());
            toast("Saved to Shelf", 1200);
        } else if (result.code == 401) {
            toast("Password rejected", 2000);
        } else if (result.message.isEmpty()) {
            toast("Not saved (" + result.code + ")", 2200);
        } else {
            toast(result.message, 2200);
        }
    }

    /** Login errors happen before a POST, so map them like post errors. */
    private void reportLoginFailure(String message) {
        if ("Password rejected.".equals(message)) {
            toast("Password rejected", 2000);
        } else if (message != null && message.startsWith("Can't reach")) {
            toast("Not saved: network error", 2000);
        } else {
            toast(message, 2200);
        }
    }

    /** Explains the missing setup and resumes this share after it succeeds. */
    private void promptSetup(final String link) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                Toast.makeText(
                    getApplicationContext(),
                    "Set up Shelf first",
                    Toast.LENGTH_SHORT
                ).show();
                Intent setup = new Intent(ShareActivity.this, SetupActivity.class);
                setup.putExtra(SetupActivity.EXTRA_PENDING_SHARE, link);
                startActivity(setup);
                finish();
            }
        });
    }

    /** One toast, then finish; never a second window on top of the caller. */
    private void toast(final String message, final long holdMs) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                Toast.makeText(getApplicationContext(), message, Toast.LENGTH_SHORT).show();
                new Handler(Looper.getMainLooper()).postDelayed(new Runnable() {
                    @Override
                    public void run() {
                        finish();
                    }
                }, holdMs);
            }
        });
    }

    private static String sharedText(Intent intent) {
        if (intent == null) return "";
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        if (text == null || text.trim().isEmpty()) {
            text = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        }
        return text == null ? "" : text;
    }

    /** The first link in the shared text, whatever host it points at. */
    private static String extractLink(String text) {
        Matcher match = LINK.matcher(text);
        if (!match.find()) return null;
        return match.group().replaceAll("[),.;:!?]+$", "");
    }
}
