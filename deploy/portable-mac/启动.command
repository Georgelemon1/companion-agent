#!/bin/bash
# companion-agent 便携版 · macOS 启动器
#
# 双击我即可（首次可能需要：右键 → 打开，或在终端里 bash 启动.command）。
#
# 设计原则与 Windows 版一致：**不改动对方系统的任何东西**。
#   · node 用包里自带的 ./node（Mach-O arm64），不要求对方装 Node
#   · DSH_HOME 指向包内 ./dsh-home，不碰对方的 ~/.dsh
#   · 首次运行才创建 state/companion.env 并要求填自己的 API key（包里不含任何人的凭据）
#
# 兼容性：macOS 自带的是 bash 3.2，别用 bash 4+ 的语法（关联数组、${var,,} 之类）。

set -u
cd "$(dirname "$0")" || exit 1
ROOT="$PWD"

NODE="$ROOT/node"
LAUNCHER="$ROOT/app/launcher.mjs"
STATE="$ROOT/state"
ENV_FILE="$STATE/companion.env"
DSH_HOME_DIR="$ROOT/dsh-home"

echo ""
echo "  =============================================="
echo "   companion-agent 便携版（macOS）"
echo "  =============================================="
echo ""

if [ ! -x "$NODE" ]; then
  echo "  ⚠️  ./node 不存在或没有执行权限。"
  echo "      先执行一次：  chmod +x \"$ROOT/node\" \"$ROOT/启动.command\""
  echo "      然后再双击（或 bash 启动.command）。"
  exit 1
fi
if [ ! -f "$LAUNCHER" ]; then
  echo "  ⚠️  缺少 app/launcher.mjs —— 包没解压完整？"
  exit 1
fi

mkdir -p "$STATE/sessions" "$DSH_HOME_DIR"

# ── 首次运行：引导填自己的 API key ─────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  echo "  第一次运行，需要填入你自己的 DeepSeek API key。"
  echo "  （她靠这个 key 调用模型说话；key 只存在本目录 state/companion.env 里，不会外传）"
  echo "  申请地址：https://platform.deepseek.com/"
  echo ""
  printf "  请粘贴 API key（sk- 开头，回车确认）: "
  read -r KEY
  KEY="$(printf '%s' "$KEY" | tr -d '[:space:]')"
  if [ -z "$KEY" ]; then
    echo "  没有填 key，先退出。下次运行会再问一次。"
    exit 1
  fi
  {
    echo "# companion-agent 便携版凭据（自己填的那把 key）"
    echo "# 由启动器注入进程环境变量；明文文件，别外传。"
    echo "DEEPSEEK_API_KEY=$KEY"
  } > "$ENV_FILE"
  echo "  已保存到 state/companion.env"
  echo ""
fi

# ── 注入凭据 + 便携 DSH_HOME ───────────────────────────────────────────────
while IFS= read -r line; do
  case "$line" in
    ''|\#*) continue ;;
  esac
  key="${line%%=*}"
  val="${line#*=}"
  key="$(printf '%s' "$key" | tr -d '[:space:]')"
  case "$key" in
    ''|*[!A-Za-z0-9_]*) continue ;;
  esac
  export "$key=$val"
done < "$ENV_FILE"
export DSH_HOME="$DSH_HOME_DIR"

echo "  界面地址： http://127.0.0.1:4180"
echo "  停止：     Ctrl+C，或直接关掉这个终端窗口"
echo ""

# ── 等服务起来再开浏览器（避免白页）────────────────────────────────────────
(
  i=0
  while [ "$i" -lt 60 ]; do
    sleep 1
    if curl -fsS -o /dev/null "http://127.0.0.1:4180/companion/health" 2>/dev/null; then
      open "http://127.0.0.1:4180"
      break
    fi
    i=$((i + 1))
  done
) &

# ── 前台跑（窗口关掉 = 她下班）─────────────────────────────────────────────
exec "$NODE" "$LAUNCHER"
