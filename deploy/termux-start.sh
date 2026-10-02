#!/data/data/com.termux/files/usr/bin/bash
# companion-agent · Termux 启动脚本（Android）
#
# 与桌面版的 start-companion.ps1 等价：注入 state/companion.env 里的凭据，然后前台跑 launcher。
# 前台跑是有意的：Android 会杀后台进程，让 Termux 会话持有它更稳；
# 配合 termux-wake-lock 防止 CPU 休眠掐断连接。
#
# 用法：
#   bash termux-start.sh            # 前台（Ctrl+C 停止）
#   nohup bash termux-start.sh > state/nohup.log 2>&1 &   # 后台（自行斟酌，容易被系统回收）

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="$ROOT/state"
ENV_FILE="$STATE/companion.env"
LAUNCHER="$ROOT/app/launcher.mjs"

# ── 1. 注入应用专用凭据 ─────────────────────────────────────────────────────
if [ -f "$ENV_FILE" ]; then
  while IFS= read -r line; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    key="${line%%=*}"
    val="${line#*=}"
    # 去首尾空白与可能的外层引号
    key="$(echo "$key" | tr -d '[:space:]')"
    val="$(echo "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//')"
    [ -n "$key" ] && export "$key=$val"
    if [ -n "$val" ]; then
      echo "已注入凭据：$key=${val:0:8}…${val: -4}"
    fi
  done < "$ENV_FILE"
fi

if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
  echo "⚠️  DEEPSEEK_API_KEY 为空：她会连不上模型。请编辑 $ENV_FILE"
fi

# ── 2. 防休眠 ──────────────────────────────────────────────────────────────
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock && echo "已申请 wake-lock（防 CPU 休眠）"
else
  echo "（没有 termux-wake-lock，跳过。建议 pkg install termux-tools）"
fi

# ── 3. 会话锁（flock）可用性探测 ────────────────────────────────────────────
# 为什么需要这一步：Android 的 process.platform 是 "android"，而
#   node-addon-system/lib/flock.js 只在 linux/darwin 上加载原生 flock；
#   于是 dsh-session-persistence-jsonl 写会话时拿租约会抛
#   ERR_FLOCK_UNSUPPORTED_PLATFORM —— 症状是"能回话，但存不下会话"。
# 这里有两条路，**能用原生就用原生**，只在真的用不了时降级：
#   ① node-addon-system 如今在 linux 上也能加载（Termux 的 Node 有时仍报 linux）；
#   ② 报 android 时就走降级桩（单进程空实现，上游注释 :637 说浏览器 worker 就这么干）。
# 探测方式是真的去拿一把锁（不只是看 platform）：失败才降级。
FLOCK_PROBE="$ROOT/deploy/flock-probe-flock.mjs"
NODE_IMPORT_ARGS=()
if [ -f "$FLOCK_PROBE" ]; then
  if (cd "$ROOT/app" && node "$FLOCK_PROBE" >/dev/null 2>&1); then
    echo "会话锁：原生 flock 可用（继续用内核锁）"
  else
    # 路径用脚本自身目录推导（BASH_SOURCE），不写死。
    SHIM="$ROOT/deploy/flock-shim.mjs"
    if [ -f "$SHIM" ]; then
      NODE_IMPORT_ARGS+=(--import "$SHIM")
      echo "⚠️  会话锁已降级为单进程空实现（原生 flock 不可用：$ROOT/deploy/flock-shim.mjs）"
      echo "    单进程下安全（与上游浏览器 worker 的做法一致）；但**不要再起第二个实例**写同一个 state/sessions。"
    else
      echo "⚠️  原生 flock 不可用，且找不到降级桩 $SHIM —— 会话很可能存不下来。"
    fi
  fi
else
  echo "（没有 flock 探测脚本，跳过；会话锁按原生行为走）"
fi

# ── 4. 前台跑 ──────────────────────────────────────────────────────────────
cd "$ROOT"
echo "启动 companion-agent … 打开 http://127.0.0.1:4180"
# node:sqlite 在 23.4 之前需要实验开关；低版本 Node 自动补上
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 24 ] && ! node -e "require('node:sqlite')" >/dev/null 2>&1; then
  exec node --experimental-sqlite "${NODE_IMPORT_ARGS[@]}" "$LAUNCHER"
fi
exec node "${NODE_IMPORT_ARGS[@]}" "$LAUNCHER"
