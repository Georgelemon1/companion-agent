#!/bin/sh
# 步骤 2/5：组装 guest 运行时（必须在 WSL 里跑，因为要保留 unix 权限位与符号链接）。
#
# 产出：$BUILD/rootfs/
#   ├─ Ubuntu 24.04 arm64 基础系统（ubuntu-base 官方 tarball）
#   ├─ /usr/local/…  官方 Node 24 arm64（nodejs.org）
#   └─ /opt/companion/app/…  应用代码 + 按 linux-arm64 解析的依赖
#
# 各依赖从哪来（全部为公开镜像，实测可达）：
#   ubuntu-base   mirrors.tuna.tsinghua.edu.cn/ubuntu-cdimage/ubuntu-base/releases/24.04/release/
#                 （清华镜像；官方源是 cdimage.ubuntu.com，此处只换下载点，内容同一份）
#   Node 24       nodejs.org/dist/v<版本>/node-v<版本>-linux-arm64.tar.xz（官方）
#   npm 依赖      registry.npmjs.org
#
# 用法（在 Windows 侧由 build.ps1 调起）：
#   wsl -u root -- bash "/mnt/e/.../deploy/android/02-prepare-rootfs.sh"
set -eu

# ── 可覆盖的路径与版本 ──────────────────────────────────────────────────────
SRC="${SRC:-/mnt/e/deepseek harness workspace1/projects/companion-agent}"
BUILD="${BUILD:-/mnt/e/android-build/work}"
DL="${DL:-/mnt/e/android-build/dl}"
NODE_VERSION="${NODE_VERSION:-24.13.0}"
UBUNTU_BASE="${UBUNTU_BASE:-ubuntu-base-24.04.5-base-arm64.tar.gz}"

ROOTFS="$BUILD/rootfs"
APPDIR="$ROOTFS/opt/companion/app"

if [ ! -d "$DL" ]; then echo "缺少下载目录 $DL（先跑 01-download-deps.mjs）" >&2; exit 1; fi

# ── 让本脚本自己找得到 node/npm（不依赖登录 shell 的 profile） ──────────────
# 本机 WSL 的 node 装在 /opt/node，但 PATH 里只有登录 shell（/root/.profile）才会加上
# /opt/nodebin。而 /opt/node/bin/node 不能直接执行（它需要自带的那套 glibc：
# /opt/nodebin/node 是个 wrapper，用 /lib64/ld-linux-x86-64.so.2 --library-path /opt/node/lib 起它），
# 所以这里必须把 /opt/nodebin 放前面。
export PATH="/opt/nodebin:/opt/node/bin:$PATH"
NODE_BIN=""
for cand in /opt/nodebin/node /usr/local/bin/node /usr/bin/node; do
  if [ -x "$cand" ]; then NODE_BIN="$cand"; break; fi
done
if [ -z "$NODE_BIN" ]; then NODE_BIN="$(command -v node 2>/dev/null || true)"; fi
if [ -z "$NODE_BIN" ]; then echo "WSL 里找不到 node（PATH=$PATH）" >&2; exit 1; fi

echo "== 2.1 解出 Ubuntu base（arm64） =="
if [ ! -x "$ROOTFS/bin/sh" ] && [ ! -L "$ROOTFS/bin/sh" ]; then
  rm -rf "$ROOTFS"
  mkdir -p "$ROOTFS"
  gzip -t "$DL/$UBUNTU_BASE"          # 截断的下载是静默的，先验一遍
  # -p 保留权限位；以 root 解包才能建出设备节点/保留属主
  tar --numeric-owner -xzf "$DL/$UBUNTU_BASE" -C "$ROOTFS"
fi
echo "   $(du -sh "$ROOTFS" | cut -f1)  $ROOTFS"

echo "== 2.2 装入官方 Node $NODE_VERSION（linux-arm64） =="
if [ ! -x "$ROOTFS/usr/local/bin/node" ]; then
  mkdir -p "$ROOTFS/usr/local"
  xz -t "$DL/node-v$NODE_VERSION-linux-arm64.tar.xz"
  # --strip-components=1 把 node-vX-linux-arm64/ 这层去掉，于是得到
  # /usr/local/bin/node、/usr/local/lib/node_modules/npm —— 与官方布局一致
  tar --numeric-owner -xJf "$DL/node-v$NODE_VERSION-linux-arm64.tar.xz" \
      -C "$ROOTFS/usr/local" --strip-components=1
fi
# 自检：必须真是 aarch64（这是"按目标平台取包"的第一道闸）
NODE_ARCH=$(od -An -tx1 -j18 -N2 "$ROOTFS/usr/local/bin/node" | tr -d ' \n')
[ "$NODE_ARCH" = "b700" ] || { echo "node 不是 aarch64 ELF（e_machine=$NODE_ARCH）" >&2; exit 1; }
echo "   node e_machine=0x${NODE_ARCH%00} ✓（aarch64）"
# 不带 C 头文件：node-gyp 需要时自己会下（省 ~60 MB）
rm -rf "$ROOTFS/usr/local/include"

echo "== 2.3 拷入应用代码（排除桌面版 node_modules / npm junction） =="
rm -rf "$APPDIR"
mkdir -p "$APPDIR"
for item in launcher.mjs cordis.yml cordis.patch.yml public companion; do
  cp -a "$SRC/app/$item" "$APPDIR/"
done

# package.json 用"应用自己的 dsh.profile 清单 + phone-package.json 的依赖清单"合成：
#   * launcher.mjs 读 app/package.json 的 dsh.profile.bundles，这一半不能丢；
#   * 依赖清单来自 deploy/phone-package.json（手机端专用 profile），这一半不能少。
python3 - "$SRC/app/package.json" "$SRC/deploy/phone-package.json" "$APPDIR/package.json" <<'PY'
import json, sys
app = json.load(open(sys.argv[1], encoding='utf-8'))
phone = json.load(open(sys.argv[2], encoding='utf-8'))
app['dependencies'] = phone['dependencies']
app['description'] = phone.get('description', app.get('description', ''))
with open(sys.argv[3], 'w', encoding='utf-8') as fh:
    json.dump(app, fh, ensure_ascii=False, indent=2)
    fh.write('\n')
print('   package.json: bundles=%s deps=%d' % (app['dsh']['profile']['bundles'], len(app['dependencies'])))
PY

echo "== 2.4 按目标平台解析依赖（--os=linux --cpu=arm64 --libc=glibc） =="
# 这一步是整个构建最容易翻车的地方：npm 默认按**宿主**平台挑 optionalDependencies，
# 在 Windows/musl 上会选出 win32-x64 或 linux-arm64-musl 的预编译件，装进 arm64 glibc 的
# 运行时里就是"文件在、加载就炸"。必须显式声明目标三元组。
# --ignore-scripts：不跑任何 postinstall（本项目闭包里的原生件都是预编译 .node，无需编译）。
cd "$APPDIR"
# ⚠️ 必须绕开 npm 的 shell 包装脚本，直接用 node 跑 npm-cli.js：
#   * `node_modules/npm/bin/npm` 这个包装脚本里写死了
#       if [ "$IS_WSL" == "true" ]; then echo "WSL 1 is not supported…"; exit 1
#   * 而 `bash -lc` 会把 Windows 侧 PATH 混进来，于是可能命中
#     /mnt/c/Users/PC/AppData/Roaming/npm/npm（Windows 的 git-bash 版 shim），
#     只报一句 "Could not determine Node.js install directory"。
NPM_CLI=""
for cand in /opt/node/lib/node_modules/npm/bin/npm-cli.js \
            "$(dirname "$(dirname "$NODE_BIN")")/lib/node_modules/npm/bin/npm-cli.js"; do
  if [ -f "$cand" ]; then NPM_CLI="$cand"; break; fi
done
if [ -z "$NPM_CLI" ]; then echo "找不到 npm-cli.js（node=$NODE_BIN）" >&2; exit 1; fi
echo "   node=$NODE_BIN ($("$NODE_BIN" -v))  npm-cli=$NPM_CLI"
# npm 的缓存默认落在 $HOME/.npm —— WSL 的 / 在 C 盘上，而 C 盘只剩 1 GB 多。
# 显式把缓存挪到 E 盘，别把系统盘写满。
export HOME="${TMPDIR:-/tmp}/npmhome"
export npm_config_cache="$BUILD/npm-cache"
mkdir -p "$HOME" "$npm_config_cache"
"$NODE_BIN" "$NPM_CLI" install --no-audit --no-fund --no-progress \
  --os=linux --cpu=arm64 --libc=glibc \
  --ignore-scripts
echo "   node_modules: $(du -sh "$APPDIR/node_modules" | cut -f1)  包数=$(ls "$APPDIR/node_modules" | wc -l)"

echo "== 2.5 瘦身：删掉已 disabled 插件带的包 =="
# 清单直接镜像本项目已出货的桌面版：deploy/make-portable-mac.ps1 的 $unused。
# 参考点：那份 macOS 便携包里的 node_modules 是 58.7 MB，而 npm 原样装出来是 205 MB ——
# 说明这份清单是被实际出货验证过的，不是猜的。
# 平台相关的那两条按 linux 改写：mac 版删 'koffi-win32-x64'/'ripgrep-win32-x64'，
# 我们反过来保留 linux-arm64 的那两个，删掉 win32 独占的包。
TRIM="@img sharp node-pty @opentelemetry @google @anthropic-ai @mistralai @aws-sdk
      @aws-crypto @huggingface @xenova openai web-streams-polyfill
      onnxruntime-node onnxruntime-common onnx-proto
      @deepseek-ai/dsh-win32-process @deepseek-ai/dsh-sandbox-windows-acl"
before=$(du -sm "$APPDIR/node_modules" | cut -f1)
for name in $TRIM; do
  if [ -e "$APPDIR/node_modules/$name" ]; then rm -rf "$APPDIR/node_modules/$name"; fi
done
# 兜底：平台专属的兄弟包只该留 linux-arm64 那份。这一步在正常构建里是空操作
# （05-verify-apk.mjs 会断言"没有任何 win32/darwin 平台包"），但万一有人在
# Windows/macOS 上跑成了、npm 按宿主挑错了件，这里会当场清掉并打出来。
WRONG=$(find "$APPDIR/node_modules" -maxdepth 3 -type d \
        \( -name '*-win32-*' -o -name '*-darwin-*' -o -name '*-android-*' \) 2>/dev/null || true)
if [ -n "$WRONG" ]; then
  echo "   ⚠️  清掉错误平台的兄弟包："
  echo "$WRONG" | sed 's/^/      /'
  echo "$WRONG" | xargs rm -rf
fi
echo "   node_modules $(du -sh "$APPDIR/node_modules" | cut -f1)（瘦身前 ${before} MB）"

echo "== 2.6 覆盖 guest 侧文件（start.sh / link 兼容层 / resolv.conf 占位） =="
cp -a "$SRC/deploy/android/payload/." "$ROOTFS/"
cp -a "$SRC/deploy/android/precache/liblinkfix.so" "$ROOTFS/opt/companion/liblinkfix.so"
chmod 0755 "$ROOTFS/opt/companion/start.sh"
mkdir -p "$ROOTFS/opt/companion/state" "$ROOTFS/opt/companion/logs"
# resolv.conf 的真实内容由 Android 侧在每次启动时按当前网络写入（见 ServerBus.writeResolvConf）
: > "$ROOTFS/etc/resolv.conf"

echo "== 2.7 自检 =="
[ -x "$ROOTFS/opt/companion/start.sh" ] || { echo "start.sh 缺失" >&2; exit 1; }
[ -f "$ROOTFS/opt/companion/liblinkfix.so" ] || { echo "liblinkfix.so 缺失" >&2; exit 1; }
[ -f "$APPDIR/launcher.mjs" ] || { echo "launcher.mjs 缺失" >&2; exit 1; }
[ -f "$APPDIR/public/index.html" ] || { echo "public/index.html 缺失" >&2; exit 1; }
for dep in dsh-base dsh-app-boot dsh-agent dsh-llm dsh-brand; do
  [ -d "$APPDIR/node_modules/@deepseek-ai/$dep" ] || { echo "瘦身误删了 @deepseek-ai/$dep" >&2; exit 1; }
done
[ -d "$APPDIR/node_modules/@deepseek-ai/schemastery" ] || [ -d "$APPDIR/node_modules/schemastery" ] \
  || { echo "schemastery 缺失" >&2; exit 1; }
[ -d "$APPDIR/node_modules/ws" ] || { echo "ws 缺失" >&2; exit 1; }
# 镜像 05-verify-apk.mjs §6 的架构检查，但放在更早的位置：瘦身/平台错件的信号要当场看见
NATIVE_BAD=0
for f in $(find "$APPDIR/node_modules" -name '*.node' \
           \( -path '*linux-arm64*' -o -path '*linux_arm64*' \) 2>/dev/null); do
  machine=$(od -An -tx1 -j18 -N2 "$f" | tr -d ' \n')
  if [ "$machine" != "b700" ]; then
    echo "   ❌ $f 不是 aarch64（e_machine=$machine）" >&2
    NATIVE_BAD=1
  fi
done
[ "$NATIVE_BAD" = "0" ] || exit 1
# flock 的关键件必须在（glibc 分支）
[ -f "$APPDIR/node_modules/@deepseek-ai/node-addon-system-linux-arm64/bin/glibc/system.node" ] \
  || { echo "缺少 glibc 版 system.node（flock 会落到 musl 分支）" >&2; exit 1; }
echo "   flock(glibc) ✅  schemastery ✅  ws ✅  平台原生件全是 aarch64 ✅"
echo "   rootfs 总大小 $(du -sh "$ROOTFS" | cut -f1)"
echo "== 2 完成 =="
