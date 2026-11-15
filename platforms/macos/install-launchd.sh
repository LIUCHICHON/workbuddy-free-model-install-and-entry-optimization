#!/bin/bash
# 把 launchd 模板渲染成实际路径并安装到 ~/Library/LaunchAgents（仅 macOS）
# 用法：bash platforms/macos/install-launchd.sh [--unload]
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TPL_DIR="$REPO_ROOT/platforms/macos/launchd"
DEST="$HOME/Library/LaunchAgents"
mkdir -p "$DEST" "$HOME/.our-free-model/logs"

for tpl in "$TPL_DIR"/*.plist.example; do
  label="$(basename "$tpl" .plist.example)"
  out="$DEST/$label.plist"
  if [ "${1:-}" = "--unload" ]; then
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    rm -f "$out"
    echo "[✓] 已卸载 $label"
    continue
  fi
  sed -e "s|__REPO_ROOT__|$REPO_ROOT|g" -e "s|__HOME__|$HOME|g" "$tpl" > "$out"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$out"
  echo "[✓] 已加载 $label -> $out"
done
