# 手机端部署（Android / Termux）

> ## ⛔ 这条路线已停放（2026-10-01，用户决定）
>
> **改用 APK 路线**：见 [android/README-安卓APK.md](android/README-安卓APK.md)（自带 PRoot + glibc Node 24 + WebView，
> 不需要 Termux、不需要浏览器、不需要 root，还能开机自启）。
>
> 停它的直接理由：APK 路线**自带官方 glibc Node**，PRoot 里原生 flock 可用（已实测 `RESOLVED`）
> —— 本文下面那一整套 flock 降级/shim 的复杂度在那条路上**根本不需要**。
>
> **本文件保留作历史与知识存档**（flock 的实测结论、`.zstd` 多帧坑、下载绕行等仍有效，
> 也仍是那套 13 MB 包的说明书）。若哪天想回到"零安装、不占 400 MB"的轻量路线，从这里接着走。
> 相关产物：`companion-phone.tgz`（13.2 MB，含 flock shim 与记忆快照）、`termux-install.sh`、`termux-start.sh`。

> **状态：脚本已就绪，但尚未在真机上跑过。** 我在 PC 上无法验证 Android 侧，
> 所以下面每一步都标了"预期"与"验收信号"；第一次跑大概率要来回一次。
> 已验证的部分：依赖闭包可移植性审计、npm 公网可取、她的记忆资产形态、
> **会话落盘 flock 的降级方案（本机把 platform 伪装成 android 实测通过）**（见文末"哪些已实测"）。

## 这条路线是什么

**后端（Node + DSH + 她的记忆）跑在手机里**，界面还是那个网页。
因为页面是从 `127.0.0.1` 打开的，**本机就是安全上下文** —— 所以：

- 不需要 HTTPS 证书
- 麦克风/语音识别不会被拒（桌面走局域网 http 时会被拒）
- 浏览器可以把页面"添加到主屏幕"，成为一个真正的应用图标

代价：手机要装 100+ 个 npm 包（约 200–400 MB），首次安装慢；Android 会杀后台，需要 wake-lock。

## 前置

| 项 | 要求 |
|---|---|
| Termux | 从 **F-Droid 或 GitHub** 装（Play 商店那版已废弃，会有奇怪问题） |
| 存储 | 至少 1 GB 空闲 |
| 网络 | 能访问 `registry.npmjs.org`（首次安装要下包） |
| Node | 脚本会 `pkg install nodejs`（要 current 版：应用用内置 `node:sqlite`） |

## 一、把项目拷到手机

在**电脑**上打包——**用脚本，别手敲 tar**：

```powershell
cd "E:\deepseek harness workspace1\projects\companion-agent"
pwsh -File deploy\make-phone-package.ps1
```

它做三件事：① 用 `VACUUM INTO` 给记忆库做**在线快照**（应用运行中也能安全打包，见下）；
② 打包并**排除** node_modules / `app/npm` junction / 素材母本 / 截图日志；
③ 自检体积与关键文件，打印 `✅ 可以拷到手机了`。产出 `companion-phone.tgz`（约 13 MB）。

> **两个坑（实测踩过，脚本已处理）**
> - `--exclude "app/node_modules"` 在 bsdtar 下**不生效**，必须写 `*/node_modules`；否则包会变成 136 MB。
> - `app/npm/@deepseek-ai` 是指向本机 DSH 安装的 **junction**，`Get-ChildItem` 看不见它的大小，
>   **但 tar 会跟进去**（7505 个条目）。必须显式排除。
> - 应用运行时 `state/companion.db` 被 SQLite 占用，直接打包会 `Permission denied`；
>   脚本改用 `VACUUM INTO` 生成一致的快照（`state/companion.db.snap`），手机首次安装时自动就位。

传到手机（任选一种）：

- **adb**：`adb push companion-phone.tgz /sdcard/Download/`
- **数据线/文件管理器**：直接拷到手机存储
- **云盘**：13 MB，随意

## 二、在手机上解包并安装

```bash
# Termux 里
pkg install -y tar
termux-setup-storage            # 授权访问共享存储（会弹权限框）
mkdir -p ~/companion-agent && cd ~/companion-agent
tar -xzf ~/storage/downloads/companion-phone.tgz

bash deploy/termux-install.sh   # 装 Node + 装依赖（最慢的一步）
```

**预期信号**：最后打印"完成"，并且 `app/node_modules/@deepseek-ai/dsh-base` 存在。
**可能的坑**：`npm install` 里若有包尝试原生编译会失败 —— 脚本已加 `--ignore-scripts` 规避；
若仍失败，把报错原文发我。

## 三、填 key 并启动

```bash
vi state/companion.env          # 填 DEEPSEEK_API_KEY=sk-...
bash deploy/termux-start.sh
```

**预期信号**：日志出现 `companion 前端已就绪：http://127.0.0.1:4180`。

然后手机浏览器打开 **http://127.0.0.1:4180** → 应该看到她站在那儿、眨眼、能聊天。
浏览器菜单里"添加到主屏幕"，就有了应用图标。

## 四、开机自启（可选）

装 **Termux:Boot**（F-Droid），然后：

```bash
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/companion.sh <<'EOF'
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
cd ~/companion-agent && exec bash deploy/termux-start.sh
EOF
chmod +x ~/.termux/boot/companion.sh
```

再在系统设置里把 Termux 的电池优化设为"不优化"，否则亮屏待机也会被杀。

## 五、一个容易搞混的点：手机端**不要**改 host

桌面版如果要让手机从局域网访问，得把 `app/cordis.patch.yml` 的 `host: 127.0.0.1` 改成 `0.0.0.0`。
**手机端不需要、也不该改**：后端和浏览器在同一台设备上，`127.0.0.1:4180` 就够了，
而且保持只监听本机更安全（同一 Wi-Fi 下的别人连不上她的记忆库）。

## 哪些已实测、哪些没有

| 项 | 状态 |
|---|---|
| 插件裁剪（45 条 `disabled`，每条都验过 health + 真实回合） | ✅ 实测（见 [手机移植-裁剪清单.md](../手机移植-裁剪清单.md)） |
| 依赖闭包（裁剪后 **72 包**；`app/audit-portability.mjs` 的 ROOTS 已换成裁剪后的实际集合） | ✅ 实测 |
| `@deepseek-ai/dsh-base` / `dsh-app-boot` 等可从公网 npm 取到 0.1.7-alpha.2 | ✅ 实测（`npm view`） |
| 她的记忆 = 180 KB SQLite（`node:sqlite`，零原生依赖）+ 1.3 MB 会话语料 | ✅ 实测（`app/inspect-memory.mjs`） |
| **整条部署链在 Linux/glibc 上跑通**（`node:sqlite` 可用 / `npm install --ignore-scripts` 336 包 2m13s / health 200 / 真实回合 / **会话真落盘 5950 B**） | ✅ 实测（WSL1 Ubuntu 24.04 + Node 24.13.0） |
| **会话能否落盘（POSIX flock）** | 🟡 降级方案已实施；**在本机伪装 platform、以及在真 Linux 内核 + 真 Bionic 用户态（QEMU+Alpine）里都验过**（详见下面「已知硬风险」） |
| **真 Bionic 用户态（Termux）** | ✅ **已跑通**（2026-10-01，QEMU TCG + Alpine 6.6.142 内核 + 自制 initramfs，单次启动 ~25 s）：Bionic 下 `node -v` → v24.18.0、`bash --version` → `x86_64-pc-linux-android`。<br>⚠️ 早前"WSL1 内核 ABI 缺口导致 Bionic 跑不起来"的结论**已被推翻**：真正的坑是**不能直接 execve `linker64`**（内核给 `AT_BASE=0`，Bionic 在判断"我是不是主程序"之前就 `mov 0x20(%r14),%r12` → 必崩 0x20），换任何内核都一样；把 linker 当解释器用即可。另有一个 QEMU 噪声：默认 `-cpu qemu64` 无 SSSE3，会让 Bionic 的 SSE `strcmp` 触发 SIGILL，需 `-cpu max` |
| Termux 上 flock 的**具体失败码** | ✅ **实测（推翻早前推断）**：Termux 自建 node 的 `process.platform` 是 **`android`**（不是 `linux`），`flock.js` 在 platform 检查处就抛 **`ERR_FLOCK_UNSUPPORTED_PLATFORM`**，**根本走不到** `bin/musl/system.node` 那一支 —— 早前"预期 `ERR_DLOPEN_FAILED`"的说法不成立。`termux-start.sh` 的探测闸门据此判 PROBE_FAIL → 挂 shim，行为与设计一致 |
| 手机端 npm install 能把 100+ 包装到 arm64 | ❌ 未验证（第 2 可能的失败点） |
| Termux 里 Node 的 `node:sqlite` 可用 | 🔶 Linux/glibc 下实测可用；Termux 未验证（启动脚本会自检并打印） |
| 应用在手机里启动、浏览器能打开、能回话 | ❌ 未验证 |
| 省电/后台存活的实际表现 | ❌ 未验证 |

> 早前版本这里写过「最小 61 包、唯一原生依赖是 koffi」——**那是旧口径且不完整**：61 是改审计脚本前的数字（现已 72），
> 而"唯一原生风险是 koffi"是错的：koffi 只在 win32 分支惰性 import，本身安全；真正会炸的是下面的 flock。
>
> **真机验收请照 [真机验收清单.md](真机验收清单.md) 走**（含两个会误导排查的坑：① 漏注入凭据时症状是"能连上但回空话"，与 flock 无关；② `.zstd` 是多帧拼接，必须逐帧解码，否则会误判成"空的/corrupt"）。

## 已知硬风险：会话落盘的 flock（**已实施降级方案 + 本机验证通过；真机仍未验证**）

`dsh-session-persistence-jsonl` 写会话时要拿一把文件租约，走原生 `flock`：

- `node-addon-system/lib/flock.js` 在 **platform 非 linux/darwin 时直接抛 `ERR_FLOCK_UNSUPPORTED_PLATFORM`**；
- 调用方 `SessionWriteLease.acquire` **只把 EAGAIN 当"别人在写"，其它异常一律上抛**
  （`dsh-session-persistence-jsonl/lib/index.js:687-695`）。

**症状**：能回话，但**存不下会话**（下次打开是空的）。

**实测结论（2026-10-01，真 Linux 内核 + 真 Bionic 用户态）**：Termux 自建 node 的 `process.platform`
是 **`android`**，因此 `flock.js` 在 platform 检查处**直接抛 `ERR_FLOCK_UNSUPPORTED_PLATFORM`** ——
这就是真机上会遇到的那条，**走不到** `bin/musl/system.node` 分支。
（早前按"官方包报 `linux`、于是去加载 musl 预编译件、报 `ERR_DLOPEN_FAILED`"的推断**已被推翻**；
那条分支只在"报 `linux` 的构建"上才可能发生。无论哪条，`optionalDependencies` 里都**没有 android 件**。）

### 已实施的缓解：启动时按需挂"单进程空实现"

**做法**（文件都在 `deploy/`，随手机包一起走）：

| 文件 | 作用 |
|---|---|
| `flock-probe-flock.mjs` | 真的去拿一把锁，判断**原生 flock 到底能不能用**（不靠猜 platform） |
| `flock-shim.mjs` | `--import` 入口：用 `module.register` + `module.registerHooks` 注册钩子，只把 `@deepseek-ai/node-addon-system/flock` 这一个子路径改道 |
| `flock-shim-stub.cjs` | 改道目标：锁操作**立即成功**的空实现；未实现的导出显式抛错 |

`termux-start.sh` 的启动顺序变成：先探测 → **探测成功就照旧用内核锁**（不降级）→
探测失败才 `--import` 挂 shim，并打印
`⚠️ 会话锁已降级为单进程空实现（原生 flock 不可用：…）`。

**为什么可以这样降级**：上游自己的注释（`index.js:637`，已读原文）写着浏览器 worker 场景
"stubs the native flock entry to immediate success: it is single-process, so the in-process
write claim already excludes every writer"。手机端同构（一个 Termux 里的单进程）。
**代价**：失去**跨进程**写保护 —— 别对同一个 `state/sessions` 起第二个实例。

### 本机验证结果（Windows 上把 platform 伪装成 android，实测）

| 项 | 结果 |
|---|---|
| 真实 flock 原生入口 + platform=android | ✅ 实测抛 `ERR_FLOCK_UNSUPPORTED_PLATFORM: flock is not supported on android-x64` |
| **不加 shim**，走真实会话写入路径 | ✅ 实测**存不下**：`create+flush` 直接以同一个平台错失败，目录里只剩一个拿不到锁的 `session.lock`，**没有任何会话文件** |
| **加 shim**，走同一条写入路径 | ✅ 实测**存得下**：`session.v4.jsonl.zstd` 落盘，字节数 169 → 292，逐帧解 zstd 后能读出 `header + 事件` 两行，事件内容就是探针发的那句话 |
| 钩子作用域 | ✅ 实测只改道这一个子路径；同包 `package.json`、其它模块不受影响；未实现导出显式抛错 |
| `termux-start.sh` 分支 | ✅ 实测（WSL 真 bash + 假 node 收集 argv）：探测成功 → 不加参数；探测失败 → `--import …/flock-shim.mjs` |

复现命令见 `flock-android-probe.mjs` / `flock-shim-selftest.mjs` 的文件头注释。

> **诚实标注：以上全部是"在 Windows 上伪装 platform"的实测，真机（Termux/Android）未验证。**
> 具体没验证的是：① Android 上 `process.platform` 到底报 `android` 还是 `linux`（两种都已被本方案覆盖，
> 但没在真机上看到过）；② Termux 的 Node 里 `node:fs/promises` 对目录 `fsync` 的行为；
> ③ `module.registerHooks` 在手机 Node 版本上是否存在（不存在时 shim 只挂 ESM 钩子那一半，
> 而当前唯一调用方用的正是 `import`，所以仍然有效 —— 但这也是推断，不是实测）。

## 与"包装成 APK"的关系

本路线**不产出安装包**（根目录、`deploy/`、`dist/` 下都没有 `.apk`/`.aab`）。
若之后想要真 APK，最短路径是：这条路跑通后，
再加 `manifest.json` + 图标（此时 localhost 已是安全上下文，PWA 可安装），
用 PWABuilder 之类的工具把 PWA 打成包；但那一步只是"套壳"，内核仍是本文件描述的进程。
