package com.ieatfood314.exosphere;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;

import java.io.File;
import java.io.IOException;

/** Keeps the Shelf current. Only runs on an unmetered network, which in practice means Wi-Fi. */
public class SyncJob extends JobService {
    private static final int HOURLY = 1, SOON = 2;
    private static final long HOUR_MS = 60L * 60 * 1000;
    /** Leaving the app asks for a sync each time, and switching apps shouldn't mean a sync each time. */
    private static final long SOON_GAP_MS = 10L * 60 * 1000;

    private volatile boolean stopped;

    private static JobInfo.Builder job(Context context, int id) {
        return new JobInfo.Builder(id, new ComponentName(context, SyncJob.class))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_UNMETERED)
            .setRequiresBatteryNotLow(true);
    }

    /** Scheduling again would restart the hour, so leave one that's already waiting. */
    static void keepHourly(Context context) {
        JobScheduler jobs = context.getSystemService(JobScheduler.class);
        if (jobs.getPendingJob(HOURLY) == null) jobs.schedule(job(context, HOURLY).setPeriodic(HOUR_MS).setPersisted(true).build());
    }

    static void soon(Context context) {
        context.getSystemService(JobScheduler.class).schedule(job(context, SOON).build());
    }

    static File shelfDir(Context context) {
        return new File(context.getFilesDir(), "offline");
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        SharedPreferences prefs = getSharedPreferences("exosphere", MODE_PRIVATE);
        String server = prefs.getString("server", null);
        long now = System.currentTimeMillis();
        boolean tooSoon = params.getJobId() == SOON && now - prefs.getLong("synced", 0) < SOON_GAP_MS;
        // Tailscale is a VPN, so check the network that's really in use as well as the job's rule.
        if (server == null || tooSoon || getSystemService(ConnectivityManager.class).isActiveNetworkMetered()) return false;
        stopped = false;
        new Thread(() -> {
            try {
                new Syncer(new Shelf(shelfDir(this)), server, () -> stopped).run();
                if (!stopped) prefs.edit().putLong("synced", System.currentTimeMillis()).apply();
            } catch (IOException | RuntimeException unreachable) {
                // Tailscale may be off. The next run tries again, and what's saved stays saved.
            }
            jobFinished(params, false);
        }).start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        stopped = true; // the Wi-Fi went away, so it waits for the next run
        return false;
    }
}
