package com.ieatfood314.exosphere;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;

import java.io.File;
import java.io.IOException;

/**
 * Keeps the Shelf current, on Wi-Fi only. The app's network is Tailscale's VPN, and whether that
 * reads as metered depends on Tailscale, so the job's own network rule isn't enough on its own:
 * it also looks for a real unmetered Wi-Fi underneath, before it starts and all the way through.
 */
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
        if (server == null || tooSoon || !onWifi(this)) return false;
        stopped = false;
        new Thread(() -> {
            try {
                new Syncer(new Shelf(shelfDir(this)), server, () -> stopped || !onWifi(this)).run();
                if (!stopped) prefs.edit().putLong("synced", System.currentTimeMillis()).apply();
            } catch (IOException | RuntimeException unreachable) {
                // Tailscale may be off. The next run tries again, and what's saved stays saved.
            }
            jobFinished(params, false);
        }).start();
        return true;
    }

    /** Wi-Fi or Ethernet that is up, reaches the internet and isn't a hotspot. Android prefers it to
     * mobile data whenever it has one like that, so mobile data isn't what's carrying the sync. */
    @SuppressWarnings("deprecation") // getAllNetworks: the replacement is a callback, and this asks once
    static boolean onWifi(Context context) {
        ConnectivityManager connectivity = context.getSystemService(ConnectivityManager.class);
        for (Network network : connectivity.getAllNetworks()) {
            NetworkCapabilities caps = connectivity.getNetworkCapabilities(network);
            if (caps == null || caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) continue;
            boolean wifi = caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET);
            if (wifi && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
                && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) return true;
        }
        return false;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        stopped = true; // the Wi-Fi went away, so it waits for the next run
        return false;
    }
}
