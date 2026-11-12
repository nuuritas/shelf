package com.shelf.share;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

/**
 * Job scheduling and the system notification for finished summaries. The
 * WebView cannot receive Web Push, so the app asks the Worker for the next
 * pending notification instead. No Firebase, no Google services dependency.
 */
final class Notifications {
    static final String CHANNEL_ID = "shelf-summaries";
    private static final int PERIODIC_JOB = 7401;
    private static final int SOON_JOB = 7402;
    private static final int NOTIFICATION_ID = 7403;

    private Notifications() {
    }

    /** Create the channel and make sure the periodic check exists. */
    static void prepare(Context context) {
        ensureChannel(context);
        JobScheduler scheduler = scheduler(context);
        if (scheduler == null) return;

        JobInfo periodic = new JobInfo.Builder(
            PERIODIC_JOB,
            new ComponentName(context, NotificationJobService.class)
        )
            .setPeriodic(15 * 60 * 1000L)
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setPersisted(true)
            .build();
        try {
            scheduler.schedule(periodic);
        } catch (RuntimeException ignored) {
            // Some OEM builds restrict JobScheduler; the app still works.
        }
    }

    /** After a share or a launch: look again in half a minute, then five. */
    static void checkSoon(Context context) {
        JobScheduler scheduler = scheduler(context);
        if (scheduler == null) return;

        JobInfo soon = new JobInfo.Builder(
            SOON_JOB,
            new ComponentName(context, NotificationJobService.class)
        )
            .setMinimumLatency(30_000L)
            .setOverrideDeadline(5 * 60 * 1000L)
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .build();
        try {
            scheduler.schedule(soon);
        } catch (RuntimeException ignored) {
            // A missed check only delays the notification.
        }
    }

    static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) context.getSystemService(
            Context.NOTIFICATION_SERVICE
        );
        if (manager == null) return;

        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Finished summaries",
            NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setDescription("A saved post is summarized and ready to read.");
        manager.createNotificationChannel(channel);
    }

    /** Android 13+ needs the runtime permission before anything is shown. */
    static void requestPermission(Activity activity) {
        if (Build.VERSION.SDK_INT < 33) return;
        if (activity.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
            == PackageManager.PERMISSION_GRANTED) {
            return;
        }
        activity.requestPermissions(
            new String[]{android.Manifest.permission.POST_NOTIFICATIONS},
            7400
        );
    }

    static void show(Context context, String title, String body, String path) {
        NotificationManager manager = (NotificationManager) context.getSystemService(
            Context.NOTIFICATION_SERVICE
        );
        if (manager == null) return;
        if (Build.VERSION.SDK_INT >= 33
            && context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED) {
            return;
        }

        Intent open = new Intent(context, MainActivity.class)
            .putExtra(MainActivity.EXTRA_OPEN_URL, path)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pending = PendingIntent.getActivity(
            context,
            0,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(context, CHANNEL_ID)
            : new Notification.Builder(context);
        builder
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new Notification.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(pending);

        manager.notify(NOTIFICATION_ID, builder.build());
    }

    private static JobScheduler scheduler(Context context) {
        return (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
    }
}
