package com.bookmarkvault.share;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.widget.Toast;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Invisible share target. It receives text/plain from Android, posts the first
 * URL to the Cloudflare Worker, shows a toast, and finishes. No app UI.
 */
public class ShareActivity extends Activity {
    // Both values are injected by android/build.sh; never commit real ones.
    private static final String ENDPOINT = "__SHARE_ENDPOINT__";
    private static final String TOKEN = "__SHARE_TOKEN__";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        final String shared = sharedText(getIntent());

        new Thread(new Runnable() {
            @Override
            public void run() {
                String message;
                try {
                    String link = extractUrl(shared);
                    if (link == null) {
                        message = "No link found";
                    } else {
                        int code = post(link);
                        if (code == 200 || code == 201) {
                            message = "Saved to Bookmarks";
                        } else if (code == 401) {
                            message = "Share token rejected";
                        } else {
                            message = "Could not save (" + code + ")";
                        }
                    }
                } catch (Exception error) {
                    message = "Could not save";
                }

                final String toastMessage = message;
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        Toast.makeText(getApplicationContext(), toastMessage, Toast.LENGTH_SHORT).show();
                        new Handler(Looper.getMainLooper()).postDelayed(new Runnable() {
                            @Override
                            public void run() {
                                finish();
                            }
                        }, 1200);
                    }
                });
            }
        }).start();
    }

    private static String sharedText(Intent intent) {
        if (intent == null) return "";
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        if (text == null || text.trim().isEmpty()) {
            text = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        }
        return text == null ? "" : text;
    }

    private static String extractUrl(String text) {
        Matcher withScheme = Pattern.compile("https?://[^\\s]+").matcher(text);
        if (withScheme.find()) {
            return trimTrailing(withScheme.group());
        }

        Matcher bare = Pattern.compile("(?:x\\.com|twitter\\.com)/[^\\s]+").matcher(text);
        if (bare.find()) {
            return trimTrailing("https://" + bare.group());
        }

        return null;
    }

    private static String trimTrailing(String value) {
        return value.replaceAll("[),.;:!?]+$", "");
    }

    private static int post(String link) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(ENDPOINT).openConnection();
        try {
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(30_000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Authorization", "Bearer " + TOKEN);
            connection.setRequestProperty("User-Agent", "BookmarkShare/1.0");

            String body = "{\"url\":\"" + escapeJson(link) + "\"}";
            OutputStream output = connection.getOutputStream();
            try {
                output.write(body.getBytes(StandardCharsets.UTF_8));
            } finally {
                output.close();
            }

            return connection.getResponseCode();
        } finally {
            connection.disconnect();
        }
    }

    private static String escapeJson(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
