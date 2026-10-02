package dev.companion.agent;

import android.app.Application;
import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 进程级单例：路径、偏好、日志。
 *
 * 所有可变数据都落在 filesDir（应用私有）下，因为整套运行时必须在私有目录里
 * 才能被 execve —— 见 AndroidManifest.xml 里关于 targetSdk 28 的说明。
 *
 *   filesDir/runtime/rootfs/   Ubuntu 24.04 arm64 根文件系统（解包产物）
 *   filesDir/runtime/.payload 载荷内容哈希（版本戳，变了就重新解包）
 *   filesDir/home/             guest 的 /root（bind 挂进去，所以能跨重装存活）
 *   filesDir/state/            guest 的 /opt/companion/state（记忆库 + 会话 + 日志）
 *   filesDir/logs/             应用侧日志
 *   cacheDir/tmp/proot/        PRoot 的 PROOT_TMP_DIR（Android 没有可写的 /tmp）
 */
public final class App extends Application {

    public static final String TAG = "CompanionAgent";

    /** 应用监听端口。唯一来源是 app/cordis.patch.yml 的 port: 4180。 */
    public static final int PORT = 4180;

    private static volatile App INSTANCE;

    public File runtimeDir;
    public File rootfsDir;
    public File homeDir;
    public File stateDir;
    public File logsDir;
    public File tmpDir;
    public SharedPreferences prefs;

    private final Object logLock = new Object();

    @Override
    public void onCreate() {
        super.onCreate();
        INSTANCE = this;

        File files = getFilesDir();
        runtimeDir = new File(files, "runtime");
        rootfsDir = new File(runtimeDir, "rootfs");
        homeDir = new File(files, "home");
        stateDir = new File(files, "state");
        logsDir = new File(files, "logs");
        tmpDir = new File(getCacheDir(), "tmp");
        mkdirs(runtimeDir, homeDir, stateDir, logsDir, tmpDir);
        prefs = getSharedPreferences("companion", Context.MODE_PRIVATE);
        log("app onCreate · 外壳 " + BuildInfo.APP_VERSION + " · 载荷 " + BuildInfo.PAYLOAD_VERSION);
    }

    public static App i() {
        return INSTANCE;
    }

    public static File mkdirs(File... dirs) {
        for (File dir : dirs) {
            if (dir != null && !dir.isDirectory() && !dir.mkdirs() && !dir.isDirectory()) {
                Log.w(TAG, "无法创建目录 " + dir);
            }
        }
        return dirs.length > 0 ? dirs[0] : null;
    }

    /** 应用日志：logcat + filesDir/logs/companion.log（超过 512 KB 滚一份 .1）。 */
    public static void log(String message) {
        Log.i(TAG, message);
        App app = INSTANCE;
        if (app == null) {
            return;
        }
        synchronized (app.logLock) {
            File file = new File(app.logsDir, "companion.log");
            try {
                if (file.length() > 512 * 1024) {
                    File old = new File(app.logsDir, "companion.log.1");
                    if (old.exists() && !old.delete()) {
                        Log.w(TAG, "无法滚动日志");
                    }
                    if (!file.renameTo(old)) {
                        Log.w(TAG, "无法重命名日志");
                    }
                }
                String stamp = new SimpleDateFormat("MM-dd HH:mm:ss", Locale.US).format(new Date());
                try (Writer writer = new OutputStreamWriter(
                        new FileOutputStream(file, true), StandardCharsets.UTF_8)) {
                    writer.write(stamp + " " + message + "\n");
                }
            } catch (IOException error) {
                Log.w(TAG, "写日志失败: " + error);
            }
        }
    }

    /** 追加一段多行文本到某个文件（进程输出落盘用）。 */
    public static void append(File file, String text) {
        try (Writer writer = new OutputStreamWriter(
                new FileOutputStream(file, true), StandardCharsets.UTF_8)) {
            writer.write(text);
        } catch (IOException error) {
            Log.w(TAG, "追加失败 " + file + ": " + error);
        }
    }
}
