#!/data/data/com.termux/files/usr/bin/bash
# companion-agent · Termux 安装脚本（Android）
#
# 做什么：装 Node → 装应用依赖（--ignore-scripts，绕开 koffi 之类的原生编译）→ 准备 state 目录。
# 不做什么：不装 Android SDK、不打包 APK。这条路线是"后端跑在手机上"，
#          界面仍然是浏览器打开 http://127.0.0.1:4180 —— 在本机就是安全上下文，
#          所以 PWA"添加到主屏幕"和麦克风都能用，不需要 HTTPS 证书。
#
# 用法：
#   bash termux-install.sh              # 在应用目录里执行（本脚本所在目录的上一级 = 项目根）
#
# 前提：已把项目目录拷到手机上（见 README-手机.md），且 Node 允许从公网 npm 拉包。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/app"
STATE="$ROOT/state"

echo "=== companion-agent 手机端安装 ==="
echo "项目根：$ROOT"

# ── 1. Node ────────────────────────────────────────────────────────────────
# 为什么要 current 版而不是 LTS：应用用 Node 内置的 node:sqlite（状态库与记忆都走它）。
# Node 22 需要 --experimental-sqlite 开关，23.4+ 起才默认可用，所以直接装 current。
if ! command -v node >/dev/null 2>&1; then
  echo "[1/4] 安装 Node（pkg install nodejs）…"
  pkg update -y >/dev/null 2>&1 || true
  pkg install -y nodejs
else
  echo "[1/4] 已有 Node：$(node -v)"
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 23 ]; then
  echo "⚠️  Node 版本偏低（$NODE_MAJOR）：node:sqlite 可能仍需 --experimental-sqlite。"
  echo "    建议：pkg install nodejs（current 版），或手动加开关启动。"
fi

# 真正验一下 node:sqlite 能不能用（比看版本号可靠）
if node -e "require('node:sqlite')" >/dev/null 2>&1; then
  echo "    ✅ node:sqlite 可用"
else
  echo "    ⚠️  node:sqlite 直接 require 失败；启动脚本会尝试加 --experimental-sqlite"
fi

# ── 2. 依赖 ────────────────────────────────────────────────────────────────
echo "[2/4] 安装依赖（这步最慢，要下 100+ 个包）…"
cp -f "$ROOT/deploy/phone-package.json" "$APP/package.json"

# --ignore-scripts 是必须的：koffi（FFI）等包会跑 node-gyp/cnoke 编译，Android 上没有对应预编译，
# 会直接失败。裁剪过的 profile 不会在运行时 require 它们（详见 手机移植-裁剪清单.md）。
cd "$APP"
npm install --ignore-scripts --no-audit --no-fund

# ── 3. 状态目录 ────────────────────────────────────────────────────────────
echo "[3/4] 准备 state 目录…"
mkdir -p "$STATE/sessions"

if [ ! -f "$STATE/companion.env" ]; then
  cat > "$STATE/companion.env" <<'ENVEOF'
# 应用专用凭据：由 termux-start.sh 注入进程环境变量。
# 依据：dsh-credentials-local 的分层是「继承的进程环境变量 > $DSH_HOME/.credentials.yaml」，
# 环境变量优先，所以这里配的 key 只影响本应用。
# 明文凭据，别提交、别入库。
DEEPSEEK_API_KEY=
ENVEOF
  echo "    已生成 state/companion.env —— 记得把 DEEPSEEK_API_KEY 填上"
fi

if [ ! -f "$STATE/companion.db" ]; then
  # 打包时应用在运行，SQLite 文件被占用，所以桌面上是用 VACUUM INTO 做的**在线快照**，
  # 落成 companion.db.snap 带过来。这里就位成正式库名。
  if [ -f "$STATE/companion.db.snap" ]; then
    mv "$STATE/companion.db.snap" "$STATE/companion.db"
    echo "    已把记忆库快照就位为 state/companion.db"
  else
    echo "    ⚠️  没找到 state/companion.db（她的记忆）。"
    echo "        从桌面机拷的话需要一起带：companion.db.snap（或 companion.db）/ sessions/ / companion.env"
  fi
fi

# ── 4. 完事 ────────────────────────────────────────────────────────────────
echo "[4/4] 完成。"
echo
echo "  启动： bash $ROOT/deploy/termux-start.sh"
echo "  打开： http://127.0.0.1:4180"
echo "  常驻： 见 README-手机.md 的「开机自启」一节（Termux:Boot）"
