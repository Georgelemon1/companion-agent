#!/bin/sh
# companion-agent 在 guest（PRoot 里的 Ubuntu 24.04 aarch64 + 官方 Node 24）内的启动入口。
#
# 由 Android 侧这样调起：
#   proot --kill-on-exit -0 -r <rootfs> -b /dev -b /proc -b /sys \
#         -b <filesDir>/home:/root -b <filesDir>/state:/opt/companion/state \
#         -w /root /bin/sh -lc 'exec /opt/companion/start.sh'
#
# 它只做三件事：定好环境变量、挂上 link() 兼容层、exec node。
set -eu

export HOME=/root
export DSH_HOME=/root/.dsh
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export LANG=C.UTF-8
export LC_ALL=C.UTF-8
export TERM=xterm-256color
# node:sqlite 在 Node 24 上已不是实验特性，但 @deepseek-ai 的加载链会打实验性告警；
# 保留告警（诊断价值 > 日志整洁），不做静音。

mkdir -p /root/.dsh /opt/companion/state /opt/companion/logs

# ── 凭据 ────────────────────────────────────────────────────────────────────
# DSH 的凭据层次（见项目《凭据与启动.md》）：继承的进程环境变量 > $DSH_HOME/.credentials.yaml
# > 调用目录/.env > $DSH_HOME/.env。这里用"环境变量"这一最高优先级的那一层：
# 把 /root/.dsh/companion.env 里的 KEY=VALUE 导出，于是它稳定压过任何兜底文件。
if [ -f /root/.dsh/companion.env ]; then
  set -a
  . /root/.dsh/companion.env
  set +a
fi

# ── link() 兼容层 ───────────────────────────────────────────────────────────
# Android 的 SELinux 不给应用进程硬链接权限：guest 里任何真实的 link() 都返回 EACCES。
# 而 DSH 的原子写（fs 落盘、会话 jsonl、附件）正是用 link() 实现"已存在则失败"的发布语义。
# liblinkfix.so 在 libc 层把 link()/linkat() 降级为"复制 + 目标已存在则失败"，
# 不需要改上游任何一行 JS。
#
# 用 LD_PRELOAD（只作用于本进程树）而不是 rootfs 的 /etc/ld.so.preload（全局）：
# 万一这个预载库在某个机型上加载失败，爆炸半径仅限本应用，而且 Java 侧会在 20 秒内
# 发现进程早退、自动以 COMPANION_NO_LINKFIX=1 重启一次。
if [ "${COMPANION_NO_LINKFIX:-0}" != "1" ] && [ -f /opt/companion/liblinkfix.so ]; then
  LD_PRELOAD=/opt/companion/liblinkfix.so
  export LD_PRELOAD
  echo "[start.sh] link() 兼容层已挂载"
else
  echo "[start.sh] 未挂 link() 兼容层（COMPANION_NO_LINKFIX=${COMPANION_NO_LINKFIX:-0}）"
fi

echo "[start.sh] node=$(node -v 2>/dev/null || echo 缺失) cwd=/opt/companion/app pid=$$"

cd /opt/companion/app
# 用 exec 让 node 接管这个 PID：PRoot 的 --kill-on-exit 才能干净地收掉整棵树。
exec node launcher.mjs
