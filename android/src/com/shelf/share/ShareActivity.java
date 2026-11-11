package com.shelf.share;

import android.app.Activity;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Share target. Posts the first link in the shared text to the Worker and shows
 * what happened: a small card with the result, the server's own error text when
 * it refuses the link, and a retry button. It never opens the library window.
 */
public class ShareActivity extends Activity {
    private static final Pattern LINK = Pattern.compile("https?://\\S+", Pattern.CASE_INSENSITIVE);
    private static final Pattern ERROR_FIELD = Pattern.compile("\"error\"\\s*:\\s*\"([^\"]*)\"");

    private TextView title;
    private TextView detail;
    private ProgressBar spinner;
    private Button retry;
    private Button close;
    private String link;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        boolean night = (getResources().getConfiguration().uiMode
            & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        buildUi(night);

        link = extractLink(sharedText(getIntent()));
        if (link == null) {
            fail("No link in the shared text. Share a post from X or LinkedIn, not just text.");
            return;
        }
        save();
    }

    private void buildUi(boolean night) {
        int ink = night ? Color.parseColor("#f3ede3") : Color.parseColor("#1c1a17");
        int muted = night ? Color.parseColor("#b6ac9f") : Color.parseColor("#726b61");
        int card = night ? Color.parseColor("#1d1b18") : Color.parseColor("#fffdf8");
        int line = night ? Color.parseColor("#332f29") : Color.parseColor("#e3dbcf");

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#99000000"));

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(24), dp(22), dp(24), dp(16));

        GradientDrawable shape = new GradientDrawable();
        shape.setColor(card);
        shape.setCornerRadius(dp(22));
        shape.setStroke(Math.max(1, dp(1)), line);
        box.setBackground(shape);

        title = new TextView(this);
        title.setTextColor(ink);
        title.setTextSize(18);
        title.setText("Saving to Shelf");
        box.addView(title);

        detail = new TextView(this);
        detail.setTextColor(muted);
        detail.setTextSize(13);
        detail.setPadding(0, dp(8), 0, dp(14));
        box.addView(detail);

        spinner = new ProgressBar(this);
        box.addView(spinner, new LinearLayout.LayoutParams(dp(28), dp(28)));

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.END);
        actions.setPadding(0, dp(8), 0, 0);

        int accent = night ? Color.parseColor("#e77a4f") : Color.parseColor("#c24a22");

        retry = new Button(this);
        retry.setText("Retry");
        retry.setTextColor(accent);
        retry.setBackground(null);
        retry.setVisibility(View.GONE);
        retry.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                if (link != null) {
                    save();
                }
            }
        });
        actions.addView(retry);

        close = new Button(this);
        close.setText("Close");
        close.setTextColor(accent);
        close.setBackground(null);
        close.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                finish();
            }
        });
        actions.addView(close);

        box.addView(actions);

        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        params.gravity = Gravity.CENTER;
        int margin = dp(28);
        params.setMargins(margin, margin, margin, margin);
        root.addView(box, params);
        setContentView(root);
    }

    private void save() {
        title.setText("Saving to Shelf");
        detail.setText(link);
        spinner.setVisibility(View.VISIBLE);
        retry.setVisibility(View.GONE);

        final String target = link;
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    String expanded = expandShortLink(target);
                    Result result = post(expanded);
                    if (result.code == 200 || result.code == 201) {
                        succeed();
                    } else if (result.code == 401) {
                        fail("The share token was rejected. Rebuild the APK with the current SHARE_TOKEN.");
                    } else {
                        fail("HTTP " + result.code + (result.message.isEmpty() ? "" : ": " + result.message));
                    }
                } catch (Exception error) {
                    String message = error.getMessage();
                    fail("Network error" + (message == null || message.isEmpty() ? "." : ": " + message));
                }
            }
        }).start();
    }

    private void succeed() {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                spinner.setVisibility(View.GONE);
                title.setText("Saved to Shelf");
                retry.setVisibility(View.GONE);
                new Handler(Looper.getMainLooper()).postDelayed(new Runnable() {
                    @Override
                    public void run() {
                        finish();
                    }
                }, 1100);
            }
        });
    }

    private void fail(final String message) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                spinner.setVisibility(View.GONE);
                title.setText("Could not save");
                detail.setText(message);
                retry.setVisibility(View.VISIBLE);
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

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics()));
    }
}
