package dev.companion.agent;

import android.content.Context;
import android.system.ErrnoException;
import android.system.Os;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * 载荷解包：assets/payload.zip + assets/payload.manifest → filesDir/runtime/rootfs。
 *
 * 为什么是"zip + manifest"而不是 tar：
 *   Android 的 java.util.zip.ZipEntry **没有** getExternalAttributes()（那是 OpenJDK 扩展），
 *   所以 zip 只承载内容，unix 权限位和符号链接另存一份 manifest（`八进制mode\t路径[\t链接目标]`）。
 *   先按 zip 全解成普通文件，再按 manifest 设权限、把该是软链的换成软链。
 *
 * 两个必须绕开的坑（两个都会**静默**毁掉结果，来自 dsh-android 的实测记录）：
 *   ① 软链不能跟随 —— File.isDirectory() 会解引用，顺着 usrmerge 的 /bin → usr/bin
 *      会走出 rootfs 去动真实文件系统。这里一律用 NIO 的 walkFileTree（默认不跟软链）
 *      和 Files.isSymbolicLink()，删除时对软链只删链接本身。
 *   ② 打包时必须收「指向目录的软链」—— 否则 usrmerge 的整个 /bin 不进载荷，启动时
 *      找不到 /bin/sh。打包侧（03-pack-payload.mjs）有完整性自检兜底。
 */
public final class Payload {

    public interface Progress {
        /** percent < 0 表示"不确定进度"。 */
        void onProgress(String phase, int percent);
    }

    /** manifest 里的设备节点等无法在应用沙箱里重建的条目。 */
    private static volatile boolean extracting;

    public static File versionFile() {
        return new File(App.i().runtimeDir, ".payload");
    }

    public static File marker() {
        return new File(App.i().rootfsDir, "bin/sh");
    }

    public static boolean isReady() {
        return marker().exists() && BuildInfo.PAYLOAD_VERSION.equals(readVersion());
    }

    private static String readVersion() {
        try {
            byte[] bytes = Files.readAllBytes(versionFile().toPath());
            return new String(bytes, StandardCharsets.UTF_8).trim();
        } catch (IOException error) {
            return "";
        }
    }

    /** 确保 rootfs 就绪；需要时重新解包。会在调用线程上同步跑（调用方是后台线程）。 */
    public static void ensure(Context ctx, Progress progress) throws IOException {
        synchronized (Payload.class) {
            if (isReady()) {
                progress.onProgress("运行时已就绪", 100);
                return;
            }
            if (extracting) {
                throw new IOException("解包已在进行中");
            }
            extracting = true;
            try {
                App.log("开始解包载荷 " + BuildInfo.PAYLOAD_VERSION);
                progress.onProgress("清理旧的运行时…", 0);
                deleteTree(App.i().rootfsDir);
                App.mkdirs(App.i().rootfsDir);

                progress.onProgress("解包 zip…", 2);
                unzip(ctx, progress);

                progress.onProgress("恢复权限与符号链接…", 90);
                applyManifest(ctx, progress);

                if (!marker().exists()) {
                    throw new IOException("解包后找不到 " + marker() + "（载荷不完整）");
                }
                Files.write(versionFile().toPath(),
                        BuildInfo.PAYLOAD_VERSION.getBytes(StandardCharsets.UTF_8));
                progress.onProgress("运行时就绪", 100);
                App.log("载荷解包完成");
            } finally {
                extracting = false;
            }
        }
    }

    private static void unzip(Context ctx, Progress progress) throws IOException {
        File staging = new File(App.i().tmpDir, "payload.zip");
        long total;
        try (InputStream in = ctx.getAssets().open("payload.zip")) {
            try (OutputStream out = new FileOutputStream(staging)) {
                byte[] buffer = new byte[1 << 16];
                int read;
                long got = 0;
                while ((read = in.read(buffer)) > 0) {
                    out.write(buffer, 0, read);
                    got += read;
                }
                total = got;
            }
        }
        App.log("载荷 zip 已落盘: " + total + " 字节");

        long doneBytes = 0;
        int lastPercent = -1;
        try (ZipFile zip = new ZipFile(staging)) {
            List<? extends ZipEntry> entries = java.util.Collections.list(zip.entries());
            for (ZipEntry entry : entries) {
                if (entry.isDirectory()) {
                    App.mkdirs(new File(App.i().rootfsDir, entry.getName()));
                    continue;
                }
                File target = safeResolve(entry.getName());
                App.mkdirs(target.getParentFile());
                try (InputStream in = zip.getInputStream(entry);
                     OutputStream out = new FileOutputStream(target)) {
                    byte[] buffer = new byte[1 << 16];
                    int read;
                    while ((read = in.read(buffer)) > 0) {
                        out.write(buffer, 0, read);
                    }
                }
                doneBytes += Math.max(entry.getCompressedSize(), 0);
                // zip 里的压缩字节总量 ≈ 提取进度；映射到 2%..88%
                int percent = total <= 0 ? -1 : (int) Math.min(88, 2 + (doneBytes * 86 / total));
                if (percent != lastPercent) {
                    lastPercent = percent;
                    progress.onProgress("解包 zip…", percent);
                }
            }
        } finally {
            if (!staging.delete()) {
                staging.deleteOnExit();
            }
        }
    }

    /**
     * 把内置的凭据种子落到 guest 的 HOME 里。
     *
     * guest 的 /root 是 filesDir/home 的 bind 挂载点 —— rootfs 里那份 /root 会被完全遮住，
     * 所以种子只能写在**宿主侧**这个目录。已经存在就绝不覆盖：用户在应用里填的 key 优先。
     */
    public static void seedHome(Context ctx) {
        File dir = new File(App.i().homeDir, ".dsh");
        App.mkdirs(dir);
        File target = new File(dir, "companion.env");
        if (target.exists() && target.length() > 0) {
            return;
        }
        try (InputStream in = ctx.getAssets().open("seed/companion.env")) {
            try (OutputStream out = new FileOutputStream(target)) {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = in.read(buffer)) > 0) {
                    out.write(buffer, 0, read);
                }
            }
            App.log("已释放内置凭据种子 -> " + target);
        } catch (IOException missing) {
            // 没有种子是正常情况（构建时没内嵌凭据）
            App.log("没有内置凭据种子（正常）");
        }
    }

    /** 防目录穿越：载荷里的路径必须落在 rootfs 之内。 */
    private static File safeResolve(String name) throws IOException {
        File root = App.i().rootfsDir;
        File target = new File(root, name);
        String rootPath = root.getAbsolutePath();
        if (!target.getAbsolutePath().startsWith(rootPath + File.separator)) {
            throw new IOException("载荷条目越界: " + name);
        }
        return target;
    }

    private static void applyManifest(Context ctx, Progress progress) throws IOException {
        List<String[]> entries = new ArrayList<>();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                ctx.getAssets().open("payload.manifest"), StandardCharsets.UTF_8), 1 << 16)) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.isEmpty()) {
                    continue;
                }
                String[] parts = line.split("\t", -1);
                if (parts.length < 2) {
                    continue;
                }
                entries.add(parts);
            }
        }
        App.log("manifest 条目 " + entries.size());

        // ① 先建目录（浅的在前，父目录必须先存在）
        List<String[]> dirs = new ArrayList<>();
        for (String[] parts : entries) {
            if (isSymlink(parts[0])) {
                continue;
            }
            if ((parseMode(parts[0]) & 0xF000) == 0x4000) {
                dirs.add(parts);
            }
        }
        dirs.sort(Comparator.comparingInt((String[] parts) -> depth(parts[1])));
        for (String[] parts : dirs) {
            App.mkdirs(safeResolve(parts[1]));
        }

        // ② 再落符号链接与权限位（软链必须在 chmod 之前，因为 chmod 会跟随链接）
        int index = 0;
        int total = entries.size();
        for (String[] parts : entries) {
            String mode = parts[0];
            String path = parts[1];
            File target = safeResolve(path);
            if (isSymlink(mode)) {
                App.mkdirs(target.getParentFile());
                String linkTarget = parts.length > 2 ? parts[2] : "";
                if (linkTarget.isEmpty()) {
                    continue;
                }
                if (Files.isSymbolicLink(target.toPath()) || target.exists()) {
                    // 已被解包成一个普通文件/目录：先删掉，否则 symlink() 会失败
                    deleteTree(target);
                }
                try {
                    Os.symlink(linkTarget, target.getAbsolutePath());
                } catch (ErrnoException error) {
                    throw new IOException("建符号链接失败 " + path + " -> " + linkTarget, error);
                }
            } else {
                try {
                    Os.chmod(target.getAbsolutePath(), parseMode(mode) & 0xFFF);
                } catch (ErrnoException error) {
                    // 个别文件 chmod 失败不该毁掉整个运行时，记一笔继续
                    App.log("chmod 失败 " + path + ": " + error.getMessage());
                }
            }
            if ((++index & 0x3FF) == 0) {
                progress.onProgress("恢复权限与符号链接…", 90 + index * 9 / Math.max(total, 1));
            }
        }
    }

    private static int depth(String path) {
        int count = 0;
        for (int i = 0; i < path.length(); i++) {
            if (path.charAt(i) == '/') {
                count++;
            }
        }
        return count;
    }

    private static boolean isSymlink(String mode) {
        return (parseMode(mode) & 0xF000) == 0xA000;
    }

    private static int parseMode(String octal) {
        try {
            return (int) Long.parseLong(octal.trim(), 8);
        } catch (NumberFormatException error) {
            return 0;
        }
    }

    /**
     * 删除一棵树，**绝不跟随符号链接**。
     *
     * walkFileTree 默认不跟软链：软链会作为 visitFile 出现，Files.delete 删的是链接本身。
     * 手写 File.isDirectory() 递归在这里是危险的 —— isDirectory() 会解引用，
     * 顺着 usrmerge 的 /bin → usr/bin 或指向 /sdcard 的链接就会去删真实文件。
     */
    public static void deleteTree(File root) {
        if (root == null || (!root.exists() && !Files.isSymbolicLink(root.toPath()))) {
            return;
        }
        Path start = root.toPath();
        try {
            Files.walkFileTree(start, new SimpleFileVisitor<Path>() {
                @Override
                public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                    Files.deleteIfExists(file);
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult visitFileFailed(Path file, IOException error) {
                    try {
                        Files.deleteIfExists(file);
                    } catch (IOException ignored) {
                        App.log("删除失败 " + file + ": " + ignored.getMessage());
                    }
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult postVisitDirectory(Path dir, IOException error) throws IOException {
                    Files.deleteIfExists(dir);
                    return FileVisitResult.CONTINUE;
                }
            });
        } catch (IOException error) {
            App.log("删除树失败 " + root + ": " + error.getMessage());
        }
    }
}
