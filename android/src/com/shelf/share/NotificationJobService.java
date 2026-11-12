package com.shelf.share;

import android.app.job.JobParameters;
import android.app.job.JobService;
import android.content.Context;
import android.webkit.CookieManager;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Polls the Worker for the next finished-summary notification using the same
 * session cookie the WebView holds. The platform's minimum periodic interval
 * is 15 minutes; a one-off job after a share checks sooner.
 */
public class NotificationJobService extends JobService {
    @Override
    public boolean onStartJob(final JobParameters params) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    poll(getApplicationContext());
                } catch (Exception ignored) {
                    // A failed check is not worth a notification; try again later.
                } finally {
                    jobFinished(params, false);
                }
            }
        }).start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return false;
    }

    private static void poll(Context context) throws Exception {
        String cookie = CookieManager.getInstance().getCookie(Config.SITE_URL);
        if (cookie == null || cookie.isEmpty()) return;

        HttpURLConnection connection = (HttpURLConnection) new URL(
            Config.SITE_URL + "/api/notifications/next"
        ).openConnection();
        try {
            connection.setRequestMethod("GET");
            connection.setRequestProperty("Cookie", cookie);
            connection.setRequestProperty("Accept", "application/json");
            connection.setConnectTimeout(10_000);
            connection.setReadTimeout(10_000);

            if (connection.getResponseCode() != 200) return;

            JSONObject payload = new JSONObject(read(connection.getInputStream()));
            JSONObject note = payload.optJSONObject("notification");
            if (note == null) return;

            Notifications.show(
                context,
                note.optString("title", "Shelf"),
                note.optString("body", ""),
                note.optString("url", "/")
            );
        } finally {
            connection.disconnect();
        }
    }

    private static String read(InputStream input) throws Exception {
        if (input == null) return "";
        StringBuilder text = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(
            new InputStreamReader(input, StandardCharsets.UTF_8)
        )) {
            String line;
            while ((line = reader.readLine()) != null) text.append(line);
        }
        return text.toString();
    }
}
