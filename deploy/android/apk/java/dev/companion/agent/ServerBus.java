package dev.companion.agent;

import android.content.Context;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * 运行时的生命周期：解包 → 起 PRoot → 等 HTTP 就绪 → 常驻。
 *
 * 单例静态状态，因为它属于"这台机器上的那一个运行时"，不属于某个 Activity 或 Service。
 */
public final class ServerBus {

    public enum State { STOPPED, PREPARING, STARTING, RUNNING, ERROR }

    public interface Listener {
        void onServerState(State state, String detail);
    }

    /** 就绪等待上限：首次解包 + node 起服务在低端机上也可能要几分钟。 */
    private static final long READY_TIMEOUT_MS = 8 * 60 * 1000L;

    /** 判定"运行时刚起来就死了"的窗口 —— 用来触发 link() 兼容层的自愈重试。 */
    private static final long EARLY_EXIT_MS = 30 * 1000L;

    private static final List<Listener> LISTENERS = new CopyOnWriteArrayList<>();

    private static volatile State state = State.STOPPED;
    private static volatile String detail = "";
    private static volatile Process process;
    private static volatile Thread starter;
    private static volatile boolean noLinkfixTried;

    private ServerBus() {
    }

    public static State state() {
        return state;
    }

    public static String detail() {
        return detail;
    }

    public static boolean running() {
        Process current = process;
        return current != null && current.isAlive();
    }

    public static void addListener(Listener listener) {
        LISTENERS.add(listener);
        listener.onServerState(state, detail);
    }

    public static void removeListener(Listener listener) {
        LISTENERS.remove(listener);
    }

    private static void set(State next, String text) {
        state = next;
        detail = text == null ? "" : text;
        App.log("状态 -> " + next + (detail.isEmpty() ? "" : " · " + detail));
        for (Listener listener : LISTENERS) {
            try {
                listener.onServerState(next, detail);
            } catch (Throwable error) {
                App.log("监听器异常: " + error);
            }
        }
    }

    /** 幂等：已经在跑或正在起，就什么都不做。 */
    public static synchronized void start(final Context ctx) {
        if (running() || state == State.PREPARING || state == State.STARTING) {
            App.log("start() 忽略：当前 " + state);
            return;
        }
        final Context appCtx = ctx.getApplicationContext();
        starter = new Thread(() -> {
            Process spawned = null;
            try {
                set(State.PREPARING, "解包运行时…");
                Payload.ensure(appCtx, (phase, percent) ->
                        set(State.PREPARING, percent < 0 ? phase : phase + " " + percent + "%"));
                Payload.seedHome(appCtx);
                writeResolvConf(appCtx);

                long startedAt = System.currentTimeMillis();
                set(State.STARTING, "启动 PRoot…");
                spawned = launch(appCtx, false);
                process = spawned;

                set(State.STARTING, "等待 HTTP 就绪…");
                boolean ready = waitForHealth(READY_TIMEOUT_MS);

                // 自愈：link() 兼容层若在某个机型上加载失败，动态链接器会直接终止 node，
                // 表现就是"proot 刚起就退"。这里去掉 LD_PRELOAD 再试一次。
                long alive = System.currentTimeMillis() - startedAt;
                if (!ready && !spawned.isAlive() && alive < EARLY_EXIT_MS && !noLinkfixTried) {
                    noLinkfixTried = true;
                    App.log("运行时 " + alive + "ms 就退出了，去掉 link() 兼容层重试");
                    set(State.STARTING, "重试（不挂 link 兼容层）…");
                    spawned = launch(appCtx, true);
                    process = spawned;
                    ready = waitForHealth(READY_TIMEOUT_MS);
                }

                if (ready) {
                    set(State.RUNNING, "127.0.0.1:" + App.PORT);
                } else if (spawned.isAlive()) {
                    set(State.ERROR, "启动超时（进程还在，看 logs/runtime.log）");
                } else {
                    set(State.ERROR, "PRoot 退出码 " + spawned.exitValue());
                }

                int code = spawned.waitFor();
                process = null;
                if (state != State.ERROR) {
                    set(State.STOPPED, "运行时已退出（" + code + "）");
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                set(State.STOPPED, "已中断");
            } catch (Throwable error) {
                App.log("启动失败: " + error);
                set(State.ERROR, String.valueOf(error.getMessage()));
            }
        }, "companion-starter");
        starter.setDaemon(true);
        starter.start();
    }

    private static Process launch(Context ctx, boolean withoutLinkfix) throws IOException {
        List<String> argv = Proot.argv(ctx, "/opt/companion/start.sh");
        App.log("proot argv: " + argv + (withoutLinkfix ? "  [COMPANION_NO_LINKFIX=1]" : ""));
        ProcessBuilder builder = new ProcessBuilder(argv);
        Proot.applyHostEnvironment(builder.environment(), withoutLinkfix);
        builder.redirectErrorStream(true);
        Process spawned = builder.start();
        pump(spawned.getInputStream(), new File(App.i().stateDir, "runtime.log"));
        return spawned;
    }

    /** 停止 PRoot 进程树。--kill-on-exit 保证 node 一起走。 */
    public static synchronized void stop() {
        Process current = process;
        process = null;
        if (current != null) {
            App.log("停止 PRoot 进程");
            current.destroy();
        }
        set(State.STOPPED, "已停止");
    }

    public static void restart(Context ctx) {
        stop();
        try {
            Thread.sleep(800);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
        start(ctx);
    }

    /**
     * 把当前网络的 DNS 服务器写进 guest 的 /etc/resolv.conf。
     *
     * PRoot 不建网络命名空间（这是好事：沙箱里的服务对手机就是 127.0.0.1），但它也意味着
     * guest 走的是宿主内核的网络栈。Android 自己不用 /etc/resolv.conf（bionic 走 netd），
     * 而 guest 是 glibc —— **没有这个文件，guest 里解析不了任何域名**，应用连不上 API。
     * 所以每次启动时从 ConnectivityManager 现取，取不到再退回公共 DNS。
     */
    private static void writeResolvConf(Context ctx) {
        List<String> servers = new ArrayList<>();
        try {
            android.net.ConnectivityManager manager = (android.net.ConnectivityManager)
                    ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (manager != null) {
                android.net.Network network = manager.getActiveNetwork();
                android.net.LinkProperties properties = network == null ? null : manager.getLinkProperties(network);
                if (properties != null) {
                    for (java.net.InetAddress address : properties.getDnsServers()) {
                        if (address instanceof java.net.Inet4Address) {
                            servers.add(address.getHostAddress());
                        }
                    }
                }
            }
        } catch (Throwable error) {
            App.log("读 DNS 失败: " + error);
        }
        if (servers.isEmpty()) {
            servers.add("8.8.8.8");
            servers.add("1.1.1.1");
            servers.add("223.5.5.5");
            servers.add("119.29.29.29");
        }
        StringBuilder text = new StringBuilder();
        for (String server : servers) {
            text.append("nameserver ").append(server).append('\n');
        }
        File target = new File(App.i().rootfsDir, "etc/resolv.conf");
        App.mkdirs(target.getParentFile());
        try {
            java.nio.file.Files.write(target.toPath(),
                    text.toString().getBytes(StandardCharsets.UTF_8));
            App.log("写入 guest DNS: " + servers);
        } catch (IOException error) {
            App.log("写 resolv.conf 失败: " + error);
        }
    }

    /** 轮询 /companion/health，直到 200 或超时。 */
    private static boolean waitForHealth(long timeoutMs) throws InterruptedException {
        long deadline = System.currentTimeMillis() + timeoutMs;
        String url = "http://127.0.0.1:" + App.PORT + "/companion/health";
        while (System.currentTimeMillis() < deadline) {
            if (health(url)) {
                App.log("health 200: " + url);
                return true;
            }
            Process current = process;
            if (current == null || !current.isAlive()) {
                return false;
            }
            Thread.sleep(700);
        }
        return false;
    }

    private static boolean health(String url) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setConnectTimeout(1500);
            connection.setReadTimeout(1500);
            connection.setRequestMethod("GET");
            int code = connection.getResponseCode();
            return code >= 200 && code < 300;
        } catch (IOException error) {
            return false;
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    /** 把 guest 进程的输出同时写日志文件和 logcat。 */
    private static void pump(final InputStream stream, final File sink) {
        Thread thread = new Thread(() -> {
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(stream, StandardCharsets.UTF_8), 1 << 13)) {
                String line;
                while ((line = reader.readLine()) != null) {
                    App.log("[guest] " + line);
                    App.append(sink, line + "\n");
                }
            } catch (IOException error) {
                App.log("读取 guest 输出失败: " + error);
            }
        }, "guest-output");
        thread.setDaemon(true);
        thread.start();
    }
}
