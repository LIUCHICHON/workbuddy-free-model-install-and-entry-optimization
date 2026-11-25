# macOS 部署指南

## 前置

- macOS（Apple Silicon / Intel 均可），Node.js **≥ 18**（`brew install node`，或 WorkBuddy 自带 node）
- 已部署 `dsh-our-free-model` standalone；其目录通过 `OFM_STANDALONE_DIR` 指定
- `python3`（健康检查脚本用它读配置）

## 启动桥

```bash
export REPO_ROOT="$(pwd)"          # 本仓库根目录
bash platforms/macos/start-bridge.sh
curl http://127.0.0.1:11435/health
```

脚本自动按 PATH → WorkBuddy 自带 node → 常见安装位置找 Node，并做版本护栏；不写死用户名或机型路径。

## 开机自启（launchd）

```bash
bash platforms/macos/install-launchd.sh            # 渲染模板并 bootstrap
bash platforms/macos/install-launchd.sh --unload  # 卸载
```

模板在 `platforms/macos/launchd/*.plist.example`，用 `__REPO_ROOT__` / `__HOME__` 占位，安装脚本负责替换。
`KeepAlive=true`：桥崩溃后由 launchd 自动拉起。

standalone 的自启同样由 `com.ofm.standalone.plist` 管理，需先设置：

```bash
export OFM_STANDALONE_DIR="/path/to/dsh-our-free-model"
```

`start-standalone.sh` 会在启动前清理 pid 已死的陈旧 `service.lock`（macOS 不自动回收，否则 KeepAlive 永远起不来）。

## 健康检查 / 自愈

```bash
export OFM_FORWARD_KEY="<你的桥 key>"     # 也可从 ~/.workbuddy/models.json 自动读取
bash platforms/macos/healthcheck.sh
```

每 2 分钟巡检桥(11435) 与 standalone(18900)，掉线自动拉起，状态写入 `~/.our-free-model/health.json`。
可配合 `com.ofm.healthcheck` LaunchAgent（StartInterval=120）定时调用。

## 巡检与回归

```bash
node src/healthcheck.mjs --models      # 逐个模型探活
bash platforms/macos/selfcheck.sh      # 并发扫描 + 降级复核（需 OFM_FORWARD_KEY）
node tests/run-regression.mjs          # 10 个场景（R1–R10）回归
```
