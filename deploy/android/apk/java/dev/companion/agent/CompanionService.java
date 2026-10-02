package dev.companion.agent;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

/**
 * 前台服务：持有 PRoot 进程树 + WakeLock，让运行时在息屏/切后台后活着。
 *
 * 没有它，Android 会先冻结再回收进程，正在进行的对话回合会被打断。
 * 通知是常驻的，同时也是"回到界面"的入口，并带 停止/启动 两个动作。
 */
public final class CompanionService extends Service implements ServerBus.Listener {

    public static final String ACTION_ENSURE = "dev.companion.agent.ENSURE";
    public static final String ACTION_STOP = "dev.companion.agent.STOP";

    private static final String CHANNEL = "companion-runtime";
    private static final int NOTIFICATION_ID = 0x434F;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private PowerManager.WakeLock wakeLock;

    /** 看门狗：运行时意外死掉就自己拉起来（可在界面里关掉）。 */
    private final Runnable watchdog = new Runnable() {
        @Override
        public void run() {
            if (App.i().prefs.getBoolean("autoRestart", true)
                    && Payload.isReady()
                    && !ServerBus.running()) {
                App.log("看门狗：重新拉起运行时");
                ServerBus.start(CompanionService.this);
            }
            handler.postDelayed(this, 15000);
        }
    };

    public static void ensure(Context ctx) {
        Intent intent = new Intent(ctx, CompanionService.class).setAction(ACTION_ENSURE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ctx.startForegroundService(intent);
        } else {
            ctx.startService(intent);
        }
    }

    public static void stopRuntime(Context ctx) {
        Intent intent = new Intent(ctx, CompanionService.class).setAction(ACTION_STOP);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ctx.startForegroundService(intent);
        } else {
            ctx.startService(intent);
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        ServerBus.addListener(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // 5 秒内必须 startForeground，否则系统直接杀进程
        startForeground(NOTIFICATION_ID, buildNotification("正在准备…"));

        String action = intent == null ? ACTION_ENSURE : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            handler.removeCallbacks(watchdog);
            releaseWakeLock();
            ServerBus.stop();
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        // 首次运行时把内置的凭据种子落到 guest 的 HOME（bind 挂载点，跨重装存活）
        Payload.seedHome(this);
        acquireWakeLock();
        ServerBus.start(this);
        handler.removeCallbacks(watchdog);
        handler.postDelayed(watchdog, 15000);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(watchdog);
        releaseWakeLock();
        ServerBus.removeListener(this);
        super.onDestroy();
    }

    /**
     * 部分唤醒锁（不亮屏、不变亮度）。手机睡着会冻结 PRoot 进程树，
     * 正在进行的回合就断了；代价只是运行时真的开着时的待机耗电。
     */
    private void acquireWakeLock() {
        if (!App.i().prefs.getBoolean("keepAwake", true)) {
            return;
        }
        if (wakeLock != null && wakeLock.isHeld()) {
            return;
        }
        try {
            PowerManager manager = getSystemService(PowerManager.class);
            if (manager == null) {
                return;
            }
            wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "companion:runtime");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire(60 * 60 * 1000L);
        } catch (Throwable error) {
            App.log("WakeLock 失败: " + error);
        }
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
            }
        } catch (Throwable ignored) {
            // 释放失败无所谓，进程退出时系统会收回
        }
        wakeLock = null;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onServerState(ServerBus.State state, String detail) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            try {
                manager.notify(NOTIFICATION_ID, buildNotification(describe(state, detail)));
            } catch (Throwable error) {
                App.log("更新通知失败: " + error);
            }
        }
    }

    private String describe(ServerBus.State state, String detail) {
        switch (state) {
            case RUNNING:
                return "运行中 · 127.0.0.1:" + App.PORT;
            case PREPARING:
                return "首次准备：" + detail;
            case STARTING:
                return "启动中…";
            case ERROR:
                return "启动失败：" + detail;
            default:
                return "已停止";
        }
    }

    private Notification buildNotification(String text) {
        Intent open = new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            piFlags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent content = PendingIntent.getActivity(this, 0, open, piFlags);

        Intent toggleIntent = new Intent(this, CompanionService.class)
                .setAction(ServerBus.running() ? ACTION_STOP : ACTION_ENSURE);
        PendingIntent toggle = PendingIntent.getService(this, 1, toggleIntent, piFlags);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL)
                : new Notification.Builder(this);
        return builder
                .setContentTitle(getString(R.string.app_name))
                .setContentText(text)
                .setSmallIcon(R.drawable.ic_notify)
                .setOngoing(ServerBus.running() || ServerBus.state() == ServerBus.State.PREPARING
                        || ServerBus.state() == ServerBus.State.STARTING)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .addAction(new Notification.Action.Builder(
                        android.graphics.drawable.Icon.createWithResource(this,
                                ServerBus.running()
                                        ? android.R.drawable.ic_menu_close_clear_cancel
                                        : android.R.drawable.ic_media_play),
                        ServerBus.running() ? "停止" : "启动",
                        toggle).build())
                .setContentIntent(content)
                .build();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(CHANNEL,
                getString(R.string.channel_name), NotificationManager.IMPORTANCE_LOW);
        channel.setDescription(getString(R.string.channel_desc));
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }
}
