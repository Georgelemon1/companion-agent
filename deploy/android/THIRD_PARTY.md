# 第三方组件与许可

本 APK 里打的每一件外部东西都记在这里。**Apache-2.0 / MIT 之外的内容只有 PRoot（GPL）。**

## 1. 复用了 dsh-android 的什么（MIT）

参考实现：[`itiswdwa/dsh-android`](https://github.com/itiswdwa/dsh-android)（MIT License，
Copyright (c) 2026 itiswdwa），我们读了它的 `docs/ARCHITECTURE.md`、`docs/FINDINGS.md`、
`docs/BUILD.md`、`scripts/build_apk.sh`、`scripts/prepare_rootfs.sh`、`app/AndroidManifest.xml`、
`app/java/dev/dsh/android/{Proot,Payload,DshService,MainActivity}.java`、
`patches/require-builtin-stub.js`、`payload/opt/dsh/android/linkfix.c`。

| 复用的东西 | 形态 | 说明 |
|---|---|---|
| **架构路线与结论** | 文档/思路 | PRoot 承载、payload 用 zip+manifest、低 targetSdk 换 legacy SELinux 域、不加 `--link2symlink`、不设 `PROOT_NO_SECCOMP`、v2+v3 签名、aapt2+javac+d8 免 Gradle 流水线 |
| **`precache/liblinkfix.so`** | 二进制（原样拷贝） | 由该仓库的 `payload/opt/dsh/android/linkfix.c`（MIT）编译而来；该仓库以构建产物形式一并发布 |
| **`precache/libproot.so`** | 二进制（从该仓库发布的 APK 里取出） | 见下面第 2 节，本体是 GPL 的 PRoot |

**代码是自写的**：`apk/java/dev/companion/agent/*.java`、`lib/*.mjs`、各步骤脚本均为本次
自行实现，没有逐行照搬；复用的是"哪些坑存在"与"哪条路走得通"这两类信息，以及上面两个二进制。
按 MIT 的要求，本文件即版权与许可声明的保留位置。原始 MIT 文本见
<https://github.com/itiswdwa/dsh-android/blob/HEAD/LICENSE>。

## 2. PRoot（GPL-2.0-or-later）

`lib/arm64-v8a/libproot.so` = PRoot 的 aarch64 Android（bionic）构建，266 152 字节，
从 dsh-android v1.1.5 的 slim APK 里取出（该仓库构建时不带 Gradle，二进制与源码分开发布）。

- 上游：<https://github.com/termux/proot>（Termux 维护的 PRoot 分支），PRoot 本体
  <https://proot-me.github.io/>，许可 **GPL-2.0-or-later**。
- 它以**独立可执行文件**的形式被应用 `execve()` 调用（不是链接进应用的库），
  因此不与 MIT 部分构成衍生作品。但 GPL 仍要求：**分发本 APK 的人必须能拿到 PRoot 的源码**。
  自己去 `github.com/termux/proot` 取对应版本源码即可；只自用不分发则无额外义务。
- 若你要对外发布，请把上面这条写进你的发布说明。

## 3. 打进载荷的运行时

| 组件 | 版本 | 来源 | 许可 |
|---|---|---|---|
| Ubuntu base rootfs | 24.04.5（arm64） | 清华镜像 `mirrors.tuna.tsinghua.edu.cn/ubuntu-cdimage/ubuntu-base/`（上游 `cdimage.ubuntu.com`） | 各包各自（以 GPL/LGPL/MIT 为主）的集合 |
| Node.js | v24.13.0（linux-arm64） | `nodejs.org/dist/`（官方） | MIT |
| npm 依赖闭包 | 见 `deploy/phone-package.json` | `registry.npmjs.org` | 各包各自，以 MIT/Apache-2.0/ISC 为主 |

## 4. 构建期工具（不进 APK）

| 工具 | 版本 | 来源 | 许可 |
|---|---|---|---|
| Azul Zulu JDK（Windows x64） | 17.0.9 | `cdn.azul.com` | GPL-2.0 WITH Classpath Exception |
| Android build-tools | 34.0.0 | `dl.google.com/android/repository/` | Apache-2.0 |
| Android platform（android.jar） | 28 | `dl.google.com/android/repository/` | Apache-2.0 |

## 5. 应用自身

`app/**`（含 `public/` 立绘素材）来自本项目 `projects/companion-agent`，未作修改。
