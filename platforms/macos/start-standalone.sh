#!/bin/bash
# 由 LaunchAgent 调用：启动 dsh-our-free-model standalone（OpenAI 兼容网关，默认 18900）
# 设备无关：standalone 源码目录由 OFM_STANDALONE_DIR 指定，其余一律由 $HOME 推导。
set -e
HOME="${HOME:-$(cd ~ && pwd)}"
ROOT="${OFM_STANDALONE_DIR:?请设置 OFM_STANDALONE_DIR 指向 dsh-our-free-model 目录}"
PORT="${OFM_STANDALONE_PORT:-18900}"
NODE_BINS="$HOME/.workbuddy/binaries/node/versions"

NODE="$HOME/.local/node/bin/node"
[ -x "$NODE" ] || NODE="$(ls -1t "$NODE_BINS"/*/bin/node 2>/dev/null | head -1 || true)"
[ -x "$NODE" ] || NODE="$(command -v node || true)"
if [ ! -x "$NODE" ]; then echo "[x] 找不到 node（需要 >= 18）" >&2; exit 1; fi
BUN="$HOME/.local/bin/bun"
[ -x "$BUN" ] || BUN="$(ls -1t "$NODE_BINS"/*/bin/bun 2>/dev/null | head -1 || true)"
[ -n "$BUN" ] && export OUR_FREE_MODEL_BUN="$BUN"
export PATH="$(dirname "$NODE"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# macOS 不回收强杀后残留的 service.lock：仅在锁里 pid 已死时清理，避免误删真实实例
DATA_DIR="${OFM_HOME:-$HOME/.our-free-model}"
LOCK="$DATA_DIR/service.lock"
if [ -f "$LOCK" ]; then
  LOCK_PID=$(python3 -c "import json
try:
    d=json.load(open('$LOCK')); print(d.get('pid',''))
except Exception:
    print('')" 2>/dev/null)
  if [ -n "$LOCK_PID" ] && ps -p "$LOCK_PID" >/dev/null 2>&1; then
    echo "[start-standalone] service.lock 的 pid=$LOCK_PID 仍存活，跳过清理" >> "$DATA_DIR/health.log"
  else
    echo "[start-standalone] 清理陈旧 service.lock (pid=$LOCK_PID)" >> "$DATA_DIR/health.log"
    rm -f "$LOCK"
  fi
fi

cd "$ROOT"
exec "$NODE" packages/standalone/cli.mjs --port "$PORT"
