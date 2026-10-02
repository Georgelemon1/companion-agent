package dev.companion.agent;

import android.content.Context;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * PRoot 的调用方式。
 *
 * 二进制以 lib/arm64-v8a/libproot.so 发货：应用的原生库目录是 Android 稳定允许
 * execve 的位置，而它要启动的整套载荷（rootfs + node）在应用私有数据目录里。
 * 两者能同时成立，靠的是 targetSdk 28（legacy SELinux 域）—— 见 AndroidManifest.xml。
 *
 * 参数：
 *   -0               guest 里伪装成 root（uid 0 视角，不是真权限）
 *   --kill-on-exit   proot 一死，guest 全死 —— "停服务"才真的停掉 node 而不是留孤儿
 *   -r <rootfs>      根文件系统
 *   -b /dev /proc /sys  宿主内核接口透进去
 *   -b <home>:/root  guest 的 HOME 落在应用私有目录，跨重装存活
 *
 * 故意**不传** --link2symlink：它把 link() 换成指向隐藏临时文件的相对软链，
 * 而原子写随后会删掉那个临时文件 —— 每个新文件都变成悬空软链，工具却报成功。
 * 应用私有存储支持真硬链接，诚实地用真系统调用是严格更好的选择。
 */
public final class Proot {

    public static final String LIB_NAME = "libproot.so";

    private static final String DEFAULT_PATH =
            "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

    private Proot() {
    }

    public static File binary(Context ctx) {
        return new File(ctx.getApplicationInfo().nativeLibraryDir, LIB_NAME);
    }

    /**
     * PRoot 自己的暂存目录。Android 没有应用可写的 /tmp，不设这个它会先报
     * "can't create temporary directory"，紧跟着给一个**误导性的**
     * "execve: Function not implemented"。
     */
    public static File hostTmpDir() {
        File dir = new File(App.i().tmpDir, "proot");
        App.mkdirs(dir);
        return dir;
    }

    public static List<String> argv(Context ctx, String guestCommand) {
        App app = App.i();
        List<String> cmd = new ArrayList<>();
        cmd.add(binary(ctx).getAbsolutePath());
        cmd.add("--kill-on-exit");
        cmd.add("-0");
        cmd.add("-r");
        cmd.add(app.rootfsDir.getAbsolutePath());
        for (String bind : new String[]{"/dev", "/proc", "/sys"}) {
            cmd.add("-b");
            cmd.add(bind);
        }
        cmd.add("-b");
        cmd.add(app.homeDir.getAbsolutePath() + ":/root");
        cmd.add("-b");
        cmd.add(app.stateDir.getAbsolutePath() + ":/opt/companion/state");
        // guest 侧日志目录也映射过去，方便用文件管理器/adb 直接看
        cmd.add("-b");
        cmd.add(app.logsDir.getAbsolutePath() + ":/opt/companion/logs");
        cmd.add("-w");
        cmd.add("/root");
        cmd.add("/bin/sh");
        cmd.add("-lc");
        cmd.add("exec " + guestCommand);
        return cmd;
    }

    /**
     * 宿主侧环境变量。
     *
     * 只设 PROOT_TMP_DIR（外加几个基本项）。**不要**设 PROOT_NO_SECCOMP=1：那会让 PRoot
     * 退回纯 ptrace 慢路径，连普通 chdir 都返回 ENOSYS（Function not implemented）。
     *
     * PRoot 会把宿主环境变量透传进 guest，所以这个 COMPANION_NO_LINKFIX 就是
     * start.sh 里读到的那一个 —— 它是 link() 兼容层的关闭开关（自愈重试用）。
     */
    public static void applyHostEnvironment(Map<String, String> env, boolean withoutLinkfix) {
        env.put("PROOT_TMP_DIR", hostTmpDir().getAbsolutePath());
        env.put("PATH", DEFAULT_PATH);
        env.put("HOME", "/root");
        env.put("LANG", "C.UTF-8");
        env.put("TERM", "xterm-256color");
        // 注意：绝不能把 LD_PRELOAD 放在宿主环境里 —— proot 自己是 bionic 二进制，
        // 预载一个 glibc 的 .so 会让它当场崩掉。兼容层只在 guest 侧由 start.sh 挂。
        env.remove("LD_PRELOAD");
        if (withoutLinkfix) {
            env.put("COMPANION_NO_LINKFIX", "1");
        } else {
            env.remove("COMPANION_NO_LINKFIX");
        }
    }
}
