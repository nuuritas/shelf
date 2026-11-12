package com.shelf.share;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Invisible share target: no window, no card. It posts the first link in the
 * shared text and shows one short toast, then finishes. The launcher entry
 * lives in MainActivity.
 */
public class ShareActivity extends Activity {
    private static final Pattern LINK = Pattern.compile("https?://\\S+", Pattern.CASE_INSENSITIVE);
    private static final Pattern ERROR_FIELD = Pattern.compile("\"error\"\\s*:\\s*\"([^\"]*)\"");

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        final String link = extractLink(sharedText(getIntent()));
        if (link == null) {
            toast("Share a post link", 1800);
            return;
        }

        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    Result result = post(expandShortLink(link));
                    if (result.code == 200 || result.code == 201) {
                        toast("Saved to Shelf", 1200);
                    } else if (result.code == 401) {
                        toast("Share token rejected", 2000);
                    } else {
                        toast(result.message.isEmpty() ? "Not saved (" + result.code + ")" : result.message, 2200);
                    }
                } catch (Exception error) {
                    toast("Not saved: network error", 2000);
                }
            }
        }).start();
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

    private static final class Result {
        final int code;
        final String message;

        Result(int code, String message) {
            this.code = code;
            this.message = message;
        }
    }

    private static Result post(String url) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(Config.ENDPOINT).openConnection();
        try {
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(30_000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Authorization", "Bearer " + Config.TOKEN);
            connection.setRequestProperty("User-Agent", "Shelf/1.0");

            String body = "{\"url\":\"" + escapeJson(url) + "\"}";
            OutputStream output = connection.getOutputStream();
            try {
                output.write(body.getBytes(StandardCharsets.UTF_8));
            } finally {
                output.close();
            }

            int code = connection.getResponseCode();
            InputStream stream = code >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String text = stream == null ? "" : read(stream);
            Matcher match = ERROR_FIELD.matcher(text);
            return new Result(code, match.find() ? match.group(1) : text.trim());
        } finally {
            connection.disconnect();
        }
    }

    /** t.co links come from X's share sheet now and then; resolve them first. */
    private static String expandShortLink(String url) {
        if (!url.contains("t.co/")) return url;
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setInstanceFollowRedirects(true);
            connection.setConnectTimeout(10_000);
            connection.setReadTimeout(10_000);
            connection.setRequestProperty("User-Agent", "Shelf/1.0");
            connection.connect();
            String resolved = connection.getURL().toString();
            return resolved == null || resolved.isEmpty() ? url : resolved;
        } catch (Exception ignored) {
            return url;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static String read(InputStream stream) throws Exception {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[4096];
        int read;
        while ((read = stream.read(chunk)) != -1) {
            buffer.write(chunk, 0, read);
        }
        return new String(buffer.toByteArray(), StandardCharsets.UTF_8);
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

    private static String escapeJson(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
