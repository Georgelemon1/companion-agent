# companion-agent · 安卓 APK（自带运行时，不需要 Termux / root / 浏览器）

产物：`dist/android/companion-agent.apk`（arm64，约 106 MB，minSdk 26 / targetSdk 28）

装到手机上点开图标，它自己解包运行时（PRoot + Ubuntu 24.04 aarch64 + 官方 Node 24 + 应用依赖）→
在里面跑 `node app/launcher.mjs` → WebView 打开 `http://127.0.0.1:4180/`（就是本应用的前端页面）。
前台服务常驻保活，开机自启。

---

## 1. 怎么构建

### 前置条件

| 需要 | 说明 |
|---|---|
| Windows + **WSL1**（Ubuntu 24.04） | rootfs 必须在 Linux 文件系统语义下组装：要保留 unix 权限位和**符号链接**（Ubuntu 24.04 是 usrmerge，`/bin` 本身就是软链）。Windows 的 NTFS 建不了这些链接，硬解会得到一个跑不起来的 rootfs。<br>本机实测：`Ubuntu-24.04-w1`，里面 `/opt/nodebin/node` 是 v24.13.0，`python3` 3.12。 |
| Node ≥ 20（Windows 侧） | 跑下载器、图标生成、打包、校验脚本 |
| **不需要**：管理员权限、Android Studio、Gradle、Android SDK、java（JDK 由脚本自己下） | |

> ⚠️ WSL1 上跑 npm 有两个坑，脚本里已经绕开（不要"修回去"）：
> ① `node_modules/npm/bin/npm` 这个 shell 包装脚本写死了 `WSL 1 is not supported` → 一律用
> `node <npm-cli.js>` 直呼；② `bash -lc` 会把 Windows 的 PATH 混进来，可能命中
> `/mnt/c/.../AppData/Roaming/npm/npm` → 脚本自己把 `/opt/nodebin` 放 PATH 最前。

### 一条命令

```powershell
cd projects\companion-agent
pwsh -File deploy\android\build.ps1
# 可选：把凭据内嵌进 APK（不内嵌也能用，首启界面上可以直接填）
pwsh -File deploy\android\build.ps1 -EmbedCredentials state\companion.env
```

### 五步在做什么、每步的依赖从哪来

| 步 | 脚本 | 依赖 / 来源 |
|---|---|---|
| 1 下载 | `01-download-deps.mjs` | 见下表，全部落到 `E:\android-build\dl`（**别写 C 盘**，本机 C 盘只剩 ~1.4 GB） |
| 2 组装 rootfs | `02-prepare-rootfs.sh`（在 WSL 里跑） | ubuntu-base arm64 + 官方 Node 24 arm64 + `npm install --os=linux --cpu=arm64 --libc=glibc --ignore-scripts` + 瘦身 |
| 3 打载荷 | `03-pack-payload.py`（在 WSL 里跑） | 把 rootfs 打成 `payload.zip` + `payload.manifest`，带完整性自检 |
| 4 出 APK | `04-build-apk.ps1`（Windows） | aapt2 / javac / d8 / 自写 zip 打包 / apksigner |
| 5 校验 | `05-verify-apk.mjs` + `06-verify-payload.sh` | 静态校验；可选地用 qemu-aarch64 真跑载荷里的 arm64 程序 |

**下载清单（`01-download-deps.mjs`）与实测可达性**

| 件 | 来源 | 大小 |
|---|---|---|
| 便携 JDK 17（Windows x64） | `cdn.azul.com/zulu/.../zulu17.46.19-ca-jdk17.0.9-win_x64.zip` | 186 MB |
| Android build-tools r34 | `dl.google.com/android/repository/build-tools_r34-windows.zip` | 55 MB（aapt2.exe / d8.jar / apksigner.jar / zipalign.exe） |
| Android platform 28 | `dl.google.com/android/repository/platform-28_r06.zip` | 69 MB（android.jar） |
| Ubuntu base 24.04.5 arm64 | `mirrors.tuna.tsinghua.edu.cn/ubuntu-cdimage/ubuntu-base/releases/24.04/release/` | 29 MB |
| 官方 Node 24.13.0 linux-arm64 | `nodejs.org/dist/v24.13.0/node-v24.13.0-linux-arm64.tar.xz` | 30 MB |
| npm 依赖（336 包） | `registry.npmjs.org`，清单 = `deploy/phone-package.json` | — |

> **JDK 为什么不用 Adoptium 的 binary 端点**：它会 302 到 `github.com`，而本机 `github.com` 超时
> （`api.github.com` 可达）。脚本把 Adoptium 留作最后一个候选，网络通的地方会自动用上。
> 同理 `curl` 在本机有 Schannel 问题，所有下载都走 Node 的 `fetch`。

### 实测耗时（本机，E 盘）

```
1 下载       ~6 分钟（约 370 MB）
2 组装 rootfs ~4 分钟（npm 冷缓存 6 分钟 / 热缓存 3 分钟）+ tar 解包 1 分钟
3 打载荷     ~3 分钟
4 出 APK     ~2 分钟
5 校验       ~1 分钟
```

### 重新构建

脚本是幂等的，可以随时重跑：`dl/` 里已下载且校验通过的归档会跳过，`tools/` 里的工具链解压一次就复用，
密钥复用 `deploy/android/keystore/companion.p12`。只改了 Windows 侧的 Java/资源时：

```powershell
pwsh -File deploy\android\build.ps1 -SkipDownload -SkipRootfs
```

---

## 2. 怎么装

```powershell
# 有 adb（推荐）
adb install -r projects\companion-agent\dist\android\companion-agent.apk
```

没有 adb：把 APK 拷进手机，用文件管理器点安装，允许"未知来源"。

- **只有 arm64-v8a**（`lib/arm64-v8a/libproot.so`）。armeabi-v7a / x86 手机装不上，模拟器也不行。
- 装完**必须手动点开一次**：Android 规定"安装后从未启动过的应用"收不到 `BOOT_COMPLETED`，
  开机自启才会生效。
- 首启会请求通知权限（Android 13+）和麦克风权限（立绘页有语音入口）。通知权限拒了也能跑，
  只是看不到常驻通知。

---

## 3. 首次启动要多久

**首次**：要把 105.9 MB 的 `assets/payload.zip` 解成 18,369 个条目（316 MB，含 204 个符号链接），
界面上有原生进度条，通知栏也显示进度。**推断**（未在真机测过）：中端机 1–3 分钟，低端机更久。

**之后**：载荷版本戳（`payload.zip` 的 sha256 前 16 位）没变就跳过解包，几秒内进页面。
重装 APK 时如果载荷变了，会重解一次。

存储占用：APK 106 MB + 运行时 316 MB ≈ 420 MB（都在应用私有目录，卸载即清）。

---

## 4. 跑起来之后长什么样

```
MainActivity(WebView) ──HTTP/WS──► 127.0.0.1:4180   companion-agent（guest 里的 node）
        │
        └─ 前台服务 CompanionService ──► libproot.so ──► Ubuntu 24.04 aarch64 rootfs
                                              └─ /opt/companion/app/launcher.mjs
```

| 位置（手机内） | 内容 |
|---|---|
| `filesDir/runtime/rootfs/` | 解包出来的 Ubuntu + Node + 应用 |
| `filesDir/home/` → guest `/root` | guest 的 HOME（`~/.dsh/companion.env` 凭据在这里，跨重装存活） |
| `filesDir/state/` → guest `/opt/companion/state` | 记忆库 `companion.db`、`sessions/`、`runtime.log` |
| `filesDir/logs/companion.log` | 应用侧日志（右上角 `⋯` → 查看日志尾部 也能看） |

- **端口 4180 的唯一来源**是 `app/cordis.patch.yml` 的 `port: 4180`。PRoot 不建网络命名空间，
  所以 guest 里监听的回环端口，WebView 直接就能访问。
- guest 的 `/dev`、`/proc`、`/sys` 是宿主的 bind 挂载。
- **DNS**：Android 自己不用 `/etc/resolv.conf`（bionic 走 netd），而 guest 是 glibc ——
  所以每次启动时由 Java 侧从 `ConnectivityManager` 取当前 DNS 写进 `rootfs/etc/resolv.conf`，
  取不到就退回 `8.8.8.8 / 1.1.1.1 / 223.5.5.5 / 119.29.29.29`。没有这一步 guest 里解析不了任何域名。
- 右上角半透明 `⋯` 是应用的逃生口：重新载入 / 重启运行时 / 停止运行时 / 填 API Key / 看日志 / 退出。

### 凭据

DSH 的凭据是分层的，最高优先级是**继承的进程环境变量**。`start.sh` 在 guest 里
`set -a; . /root/.dsh/companion.env`，所以：

- 首启在界面上填的 key → 写进 `filesDir/home/.dsh/companion.env`；
- 或构建时 `-EmbedCredentials state\companion.env` → 打进 `assets/seed/companion.env`，
  首次启动释放到同一个位置（已存在则**绝不覆盖**，用户填的优先）。

### 为什么 targetSdk 是 28（故意低）

Android 10 起，应用落进哪个 SELinux 域由 `targetSdkVersion` 决定，**只有 legacy 域允许
`execve()` 应用私有数据目录里的二进制**。整套运行时（rootfs + node）必须从 `filesDir` 里跑，
所以抬 targetSdk 只会换来"跑不起来"。`minSdk 26`（Android 8.0）是 PRoot/bionic/64 位 arm 的下限。

两个连带事实（都标注来源）：

- 这样的 APK **不能上 Google Play**（Play 要求更高的 targetSdk）；自己装/侧载没问题。
- Android 15 起会拒绝安装 targetSdk < 24 的包，28 仍然在允许范围内。

---

## 5. 已知限制

1. **只有 arm64。**
2. **`liblinkfix.so` 是 Android 特有的兼容层**，默认通过 `LD_PRELOAD` 挂在 node 进程树上
   （**不是** rootfs 的 `/etc/ld.so.preload`，那样爆炸半径太大）。原因：Android 的 SELinux 不给
   应用进程硬链接权限，guest 里真实的 `link()` 返回 EACCES，而 DSH 的原子写（fs 落盘、会话 jsonl）
   正是用 `link()` 实现"目标已存在则失败"的发布语义。这个 .so 在 libc 层把它降级成
   "复制 + 目标已存在则失败"。
   * 挂不上怎么办：node 会被动态链接器直接终止，Java 侧检测到"20–30 秒内早退"会自动去掉
     `LD_PRELOAD` 重启一次；也可以构建时删掉 `precache/liblinkfix.so`。
3. **厂商省电策略**会杀前台服务（MIUI/EMUI/ColorOS 尤其）。要么在系统设置里给"伴侣"开
   后台运行/自启动白名单，要么忍受偶尔重拉。
4. **首次解包**是最容易失败的一步（空间不足/被系统杀进程）。失败时进应用点"重试"，
   载荷版本戳没写成功就还会重解。
5. `zipalign`/签名用的是自己实现的 zip 打包器（`lib/zipwrite.mjs`）。`resources.arsc` 强制
   STORED + 4 字节对齐；**所有 STORED 条目**至少 4 字节对齐；`.so` 页对齐（4096）。
   这里踩过一次：早先只有 arsc 和 .so 显式对齐，`assets/payload.zip` 靠字节数凑巧对齐才过；
   载荷一小就错位、`zipalign -c` 报 `Verification FAILED`。
6. **签名密钥**：`deploy/android/keystore/companion.p12`（口令 `companion`）。这是应用身份，
   泄露 = 别人能签出系统认可的升级包。已加 `.gitignore`，**别提交、别外传**；自己发版请换成自己的密钥
   （换密钥 = 换应用身份，旧版本无法覆盖安装）。

---

## 6. 验过什么（本机实测）

- APK 结构：`AndroidManifest.xml` / `resources.arsc` / `classes.dex` / `lib/arm64-v8a/libproot.so` /
  `assets/payload.zip` / `assets/payload.manifest` 齐备；只有 arm64-v8a 一种 ABI；无 zip64。
- 对齐：`resources.arsc` STORED + 4 字节对齐、`libproot.so` STORED + 4096 对齐、
  `assets/payload.zip` STORED + 4 对齐；`zipalign -c -p -v 4` 通过（**签名之后**再验一次）。
- 清单：自写 AXML 解析器读出 `package=dev.companion.agent`、`minSdkVersion=26`、
  `targetSdkVersion=28`、6 项权限、`extractNativeLibs=true`、`usesCleartextTraffic=true`、
  1 个 activity / 1 个 service / 1 个 receiver。`aapt2 dump badging` 交叉验证一致。
- 签名：`apksigner verify` → v2 ✅ v3 ✅ v1 ❌（故意关掉：签 v1 会重写 zip、把对齐搞坏）。
- dex：magic `dex\n038`、头声明长度与实际一致、5 个应用类都在。
- 载荷：18,369 条目；`node` 是 **AArch64 ELF64** 且能读出 `v24.13.0` 版本串；
  `libproot.so` 是 AArch64 且**内嵌了 loader**（不需要额外文件）；
  `liblinkfix.so` 是 AArch64、**无 DT_NEEDED**（完全自包含）。
- 依赖树按目标平台解析：5 个 linux-arm64 原生扩展**全是 AArch64**；
  **没有任何 win32/darwin/android 平台专属包**；`@deepseek-ai/node-addon-system-linux-arm64/bin/glibc/system.node`
  （会话落盘的 flock 就是它）在位。
- 载荷重建（`06-verify-payload.sh`，在 WSL 里用 qemu-aarch64）：按 manifest 重建 rootfs 后
  **`/bin/sh` 真的能起来**（证明 usrmerge 软链 `/bin → usr/bin` 重建正确）、
  `dash -n start.sh` 语法通过、`LD_PRELOAD=liblinkfix.so` 在 aarch64 glibc 下**真的生效**。
- 脚本可复现：`build.ps1` 从下载到校验**完整跑通两遍**（第二遍含瘦身，APK 从 140.8 MB 降到 106.3 MB）。

## 7. 未验证（本机没有安卓设备、没有模拟器、WSL2 不可用 —— 以下**全部**未验证）

> 下面每一条都是"跑起来才知道"的事。没有"应该可以"。

1. **真机安装与启动**：APK 从未在任何 Android 设备/模拟器上安装或运行过。
2. **PRoot 在真 Android 上能否 `execve` 应用私有目录里的 node**：这是整个方案的支点，
   依据是参考实现的设备实测记录，本机无法验证。
3. **`liblinkfix.so` 在真机上的加载与行为**：本机只验了"它是一个自包含的 AArch64 ELF 且能被
   aarch64 glibc 预载"；"Android 确实拒绝 `link()`"这个前提同样来自参考实现的设备记录，未独立验证。
4. **首次解包在真机上的可行性与耗时**：18,369 个条目 + 204 个符号链接，在手机的 `filesDir`
   （f2fs/ext4）上要多久、会不会被系统在解包途中杀掉 —— 未验证。
5. **WebView**：页面渲染、WebSocket（`/companion/ws`）、立绘序列帧播放、
   `usesCleartextTraffic` 下访问 `http://127.0.0.1` 是否被拦 —— 未验证。
6. **麦克风/语音**：`WebChromeClient.onPermissionRequest` 的授权路径、`RECORD_AUDIO` 运行时授予 —— 未验证。
7. **前台服务存活**：息屏、切后台、内存压力、厂商省电策略下 `CompanionService` 是否还在、
   WakeLock 是否有效 —— 未验证。
8. **开机自启**：`BOOT_COMPLETED` / `MY_PACKAGE_REPLACED` 在 Android 12+ 后台启动前台服务的
   豁免路径 —— 未验证。
9. **SELinux 上下文**：targetSdk 28 换 legacy 域这个假设、`nativeLibraryDir` 的 exec 权限 —— 未验证。
10. **guest 的网络**：从 `ConnectivityManager` 写 `resolv.conf` 之后，glibc 在 PRoot 下能否真的解析
    域名、能否连上 DeepSeek API —— 未验证。
11. **`/dev` `/proc` `/sys` 的 bind 挂载**在真 Android 上的表现（Android 的 `/proc` 限制很多）—— 未验证。
12. **arm64 node 在 PRoot 下能否运行**：本机想用 `qemu-aarch64` 直接跑载荷里的 node 也没成功 ——
    WSL1 报的内核是 4.4，qemu-user 的 `probe_guest_base()` 依赖 `MAP_FIXED_NOREPLACE`（Linux 4.17+），
    显式 `-B` 又被判"地址空间已被占用"。小体积的 `dash` 能跑，93 MB 非 PIE 的 node 跑不了。
    这一条**只能上真机验**。
13. **中文输入法与软键盘**在 WebView 里的行为 —— 未验证。
14. **通知交互**（Android 13+ 拒绝通知权限时的表现、通知里的"停止/启动"动作）—— 未验证。

---

## 8. 排障

| 现象 | 去哪儿看 |
|---|---|
| 卡在进度页 | 右上角 `⋯` → 查看日志尾部；或 `adb shell run-as dev.companion.agent cat files/logs/companion.log` |
| 启动失败（状态 ERROR） | `filesDir/state/runtime.log`（guest 进程的 stdout/stderr）里有 `[start.sh]` 和 node 的报错 |
| guest 里发生了什么 | `adb shell run-as dev.companion.agent ls files/runtime/rootfs/opt/companion/` |
| 想改端口 | `app/cordis.patch.yml` 的 `port:` **和** `App.java` 的 `PORT` 要一致（两处） |
| WebView 调试 | 已经在 `MainActivity` 里开了 `setWebContentsDebuggingEnabled(true)`，用桌面 Chrome 的 `chrome://inspect` |

## 9. 目录

```
deploy/android/
  build.ps1                 一键（1→5 步）
  01-download-deps.mjs      下载全部外部依赖（含来源与镜像说明）
  02-prepare-rootfs.sh      WSL：组装 guest 运行时 + 瘦身 + 自检
  03-pack-payload.py        WSL：rootfs → payload.zip + payload.manifest（带完整性自检）
  04-build-apk.ps1          Windows：aapt2 + javac + d8 + 打包 + 签名
  05-verify-apk.mjs         静态校验（自写 AXML / zip / ELF 解析，不依赖 aapt2）
  06-verify-payload.sh      WSL：用 qemu-aarch64 真跑载荷里的 arm64 程序
  make-icons.mjs            手写 PNG 编码器生成启动图标（不依赖图像库）
  lib/zipwrite.mjs          APK zip 写入器（对齐控制，这是最关键的一段）
  lib/pack-apk.mjs          合成未签名 APK
  lib/gen-buildinfo.mjs     生成 BuildInfo.java（载荷哈希当版本戳）
  apk/                      Android 工程（manifest / res / java），无 Gradle
  payload/                  要塞进 guest 的文件（start.sh 等）
  precache/                 libproot.so（AArch64）、liblinkfix.so（AArch64）
  THIRD_PARTY.md            第三方组件与许可（PRoot 是 GPL，必须看）
  README-安卓APK.md         本文件
```

许可与出处见 [`THIRD_PARTY.md`](THIRD_PARTY.md)：代码复用自 MIT 的 `itiswdwa/dsh-android`
（保留声明），`libproot.so` 本体是 **GPL-2.0-or-later** 的 PRoot —— 只自用不分发则无额外义务，
要对外发布就得同时提供 PRoot 源码。
