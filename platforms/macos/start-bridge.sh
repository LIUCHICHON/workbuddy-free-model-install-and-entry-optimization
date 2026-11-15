#!/bin/bash
# 由 LaunchAgent 调用：启动 Ollama 协议桥（默认端口 11435）。
# 设备无关：路径全部由脚本自身位置 + $HOME 推导，不写死任何用户名/机型目录。
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SELF_DIR/../.." && pwd)"
HOME="${HOME:-$(cd ~ && pwd)}"

# 找 Node：先 PATH，再 WorkBuddy 自带，最后常见安装位置
NODE="$(command -v node 2>/dev/null || true)"
if [ ! -x "$NODE" ]; then
  NODE="$(ls -1t "${HOME}/.workbuddy/binaries/node/versions"/*/bin/node 2>/dev/null | head -1 || true)"
fi
if [ ! -x "$NODE" ]; then
  for c in "${HOME}/.local/node/bin/node" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [ -x "$c" ] && NODE="$c" && break
  done
fi
if [ ! -x "$NODE" ]; then
  echo "[x] 找不到 node。请安装 Node.js >= 18（brew install node 或 https://nodejs.org）。" >&2
  exit 1
fi

# Node >= 18 才有内置 fetch / ReadableStream，低于此版本桥会启动即崩
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "[x] Node 版本过低：$("$NODE" -v)（需要 >= 18）。升级后再启动桥。" >&2
  exit 1
fi

export PATH="$(dirname "$NODE"):${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
exec "$NODE" "$REPO_ROOT/src/ollama-bridge.mjs"
