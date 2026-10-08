#!/usr/bin/env bash
# 重启 DeepSeek Harness
#
# 为什么需要这个：dsh-link 的 host 侧代码（src/host/*.ts → dist/host/*.js）只在
# 进程启动时加载，改完不重启就不会生效。H5（src/public/*）是实时服务的，不用重启。
#
# 用法：
#   scripts/restart-dsh.sh              # 优雅退出 → 重新打开 → 等端口就绪
#   scripts/restart-dsh.sh --force      # 卡住时强杀（SIGKILL）
#   DSH_LINK_PORT=19388 scripts/restart-dsh.sh
set -uo pipefail

APP="/Applications/DeepSeek Harness.app"
NAME="DeepSeek Harness"
PORT="${DSH_LINK_PORT:-19388}"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

say() { printf '\033[36m[restart]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[restart]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[restart]\033[0m %s\n' "$*" >&2; exit 1; }

[ -d "$APP" ] || die "找不到 $APP"

# 进程判定：用 AppleScript 问 App 自己（pgrep 只能匹配到 Helper 进程，匹配不到主进程）
is_running() {
  [ "$(osascript -e "application \"$NAME\" is running" 2>/dev/null)" = "true" ]
}

if is_running; then
  say "正在退出…"
  # 优雅退出，让 App 自己刷盘
  osascript -e "tell application \"$NAME\" to quit" >/dev/null 2>&1 || true

  for _ in $(seq 1 30); do          # 最多等 15s
    is_running || break
    sleep 0.5
  done

  if is_running; then
    if [ "$FORCE" = "1" ]; then
      warn "优雅退出超时，强制结束（--force）"
      pkill -9 -f "$APP" 2>/dev/null || true
    else
      warn "优雅退出超时，发 SIGTERM 再等 5s（卡住可用 --force）"
      pkill -f "$APP" 2>/dev/null || true
      for _ in $(seq 1 10); do
        is_running || break
        sleep 0.5
      done
    fi
  fi

  if is_running; then
    die "进程还没退出，请手动处理：pkill -9 -f \"$APP\""
  fi
  say "已退出"
else
  say "当前没有运行中的实例"
fi

say "正在打开 $NAME …"
open "$APP" || die "打开失败"

# 等 dsh-link 端口就绪（默认 19388）。起不来也不报错退出，只提示。
say "等待 dsh-link 端口 $PORT 就绪 …"
for i in $(seq 1 60); do               # 最多等 60s
  if nc -z 127.0.0.1 "$PORT" >/dev/null 2>&1; then
    say "端口 $PORT 已就绪（约 ${i}s）✓"
    printf '\033[32m[restart]\033[0m 重启完成\n'
    exit 0
  fi
  sleep 1
done

warn "端口 $PORT 在 60s 内没就绪：可能 dsh-link 插件未启用，或端口不是 $PORT"
warn "App 已打开，请到插件设置里确认 dsh-link 状态"
exit 0
