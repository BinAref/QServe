package com.qserve.terminal;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * What keeps a station working while nobody is looking at it.
 *
 * A kitchen tablet spends a service face-up on a shelf with its screen off. A
 * waiter's phone spends it in an apron pocket, locked. Android treats both as
 * idle and will suspend the process, drop the Wi-Fi radio into a power-saving
 * mode that delays packets by seconds, and eventually kill the app to save
 * battery — none of which is wrong in general, and all of which means a ticket
 * that never arrives.
 *
 * This is the answer, and it is the only answer Android accepts: a foreground
 * service, which is a promise to the user that something is running and a
 * notification they can see it by. Three things are held for as long as it
 * runs:
 *
 *   the process        a foreground service is not killed to reclaim memory
 *   the CPU            a partial wake lock, so the socket is serviced with the
 *                      screen off. It does not light the screen.
 *   the Wi-Fi radio    a high-performance lock, so the radio is not parked
 *                      between packets
 *
 * None of it survives the phone being switched off, and none of it is meant to:
 * this covers a device that is asleep or locked, which is what a device in a
 * restaurant is for most of the day.
 */
public class TerminalService extends Service {

    private static final String CHANNEL = "qserve.station";
    private static final int NOTIFICATION_ID = 1;

    /** Sent by the notification's own button, and by the activity on the way out. */
    public static final String ACTION_STOP = "com.qserve.terminal.STOP";
    /** The address being served, so the notification says which station this is. */
    public static final String EXTRA_ADDRESS = "address";

    private PowerManager.WakeLock cpu;
    private WifiManager.WifiLock radio;

    static void start(Context context, String address) {
        Intent intent = new Intent(context, TerminalService.class);
        intent.putExtra(EXTRA_ADDRESS, address);
        // A foreground service has to be started as one, or Android 8+ throws
        // rather than quietly running it in the background.
        context.startForegroundService(intent);
    }

    static void stop(Context context) {
        context.stopService(new Intent(context, TerminalService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }

        String address = intent == null ? null : intent.getStringExtra(EXTRA_ADDRESS);
        startForeground(NOTIFICATION_ID, notification(address));
        hold();

        // Restarted if Android kills the process anyway — a station that went
        // quiet at 2am should be answering again by breakfast without somebody
        // walking over to it.
        return START_STICKY;
    }

    /** Take the CPU and the radio. Both are released in {@link #onDestroy()}. */
    private void hold() {
        if (cpu == null) {
            PowerManager power = getSystemService(PowerManager.class);
            if (power != null) {
                cpu = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "QServe:station");
                cpu.setReferenceCounted(false);
                cpu.acquire();
            }
        }
        if (radio == null) {
            // The application context: a WifiManager from an activity context
            // leaks the activity, and this one is held for the whole service.
            WifiManager wifi = (WifiManager) getApplicationContext()
                .getSystemService(Context.WIFI_SERVICE);
            if (wifi != null) {
                radio = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "QServe:station");
                radio.setReferenceCounted(false);
                radio.acquire();
            }
        }
    }

    /**
     * The notification Android requires, written to be worth reading.
     *
     * It says which restaurant this device is pointed at and that stopping is
     * one tap — because the alternative, a permanent unexplained icon, is how
     * staff learn to swipe an app away mid-service.
     */
    private Notification notification(String address) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null && manager.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL, getString(R.string.service_channel), NotificationManager.IMPORTANCE_LOW);
            channel.setDescription(getString(R.string.service_channel_description));
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }

        Intent open = new Intent(this, TerminalActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent tap = PendingIntent.getActivity(
            this, 0, open, PendingIntent.FLAG_IMMUTABLE);

        Intent stop = new Intent(this, TerminalService.class).setAction(ACTION_STOP);
        PendingIntent stopping = PendingIntent.getService(
            this, 1, stop, PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder builder = new Notification.Builder(this, CHANNEL)
            .setContentTitle(getString(R.string.service_title))
            .setContentText(address == null ? getString(R.string.service_body) : address)
            .setSmallIcon(R.drawable.ic_station)
            .setContentIntent(tap)
            .setOngoing(true)
            .addAction(new Notification.Action.Builder(
                null, getString(R.string.service_stop), stopping).build());

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Android 12+ can otherwise hold a foreground notification back for
            // ten seconds, which on a slow tablet looks like nothing happened.
            builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        }
        return builder.build();
    }

    @Override
    public void onDestroy() {
        if (cpu != null && cpu.isHeld()) cpu.release();
        if (radio != null && radio.isHeld()) radio.release();
        cpu = null;
        radio = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        // Nothing binds to this. It runs or it does not.
        return null;
    }
}
