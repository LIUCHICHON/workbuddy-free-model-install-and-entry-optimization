# Windows 部署指南

> 由原 `README-Windows.txt` 整理。目录结构已改为通用布局，**不要**把文件平铺到同一目录。

## 前置

- Windows 10/11，Node.js **≥ 18**（`winget install OpenJS.NodeJS.LTS` 或 https://nodejs.org ）
- 已部署 `dsh-our-free-model` standalone（上游 OpenAI 兼容网关，默认端口 18900）
- WorkBuddy（可选，用于自动导入模型列表）

## 最简 3 步

1. `git clone <本仓库>` 到任意位置（如 `C:\ofm-bridge`）。
2. 双击 `platforms\windows\start.bat`
   - 首次运行会在 `%USERPROFILE%\.our-free-model` 生成 `settings.json` 并打开记事本，填好 `forwardKey` / `standalonePort` 保存后**再次双击**。
   - 再次启动会自动：探测上游免费模型 → 生成/更新 `combo:auto` 双通道轮询总入口 → 合并写入 `%USERPROFILE%\.workbuddy\models.json`（幂等，自动备份）。
   - 健康检查：<http://127.0.0.1:11435/health>
3. 在 WorkBuddy 模型列表选择「⓪ 总入口（轮询双通道·抗 429）」。

可选：双击 `install-service.bat` 注册计划任务（登录自启 + 崩溃每分钟自愈），`uninstall-service.bat` 卸载。

## 文件说明

| 路径 | 作用 |
|---|---|
| `platforms/windows/start.bat` | 一键启动入口（CRLF + UTF-8） |
| `platforms/windows/install-service.bat` / `uninstall-service.bat` | 计划任务安装 / 卸载 |
| `platforms/windows/install-windows.ps1` | Node 检测 → 首次配置 → 自动导入 → 启动桥 |
| `platforms/windows/start-bridge.ps1` | 服务自愈用的桥启动脚本（自动找 node、版本护栏） |
| `platforms/windows/install-bridge-service.ps1` | 注册登录自启 + 崩溃重启 |
| `src/ollama-bridge.mjs` | 桥核心：熔断 / 救援 / 截断换道 / 指标 |
| `src/setup-auto-entry.mjs` | 自动搜索免费模型并同步 WorkBuddy models.json |
| `examples/settings.example.json` | 配置模板（首次自动复制到数据目录） |
| `examples/rescue-providers.example.json` | 外部救援通道模板（可选，apiKey 为占位符） |
| `tests/run-regression.mjs` | 回归测试（10 个场景 R1–R10） |

## 环境变量

`OFM_HOME` / `OFM_DATA_DIR` / `OFM_WORKBUDDY_MODELS` / `OFM_BRIDGE_PORT` / `OFM_UPSTREAM` / `OFM_RESCUE_CONFIG`。

## 常见问题

- **找不到 Node**：装 Node ≥ 18 后重开终端再双击。
- **上游探测失败**：standalone 未启动或端口/密钥不对；脚本会沿用本地缓存继续，不影响桥启动。
- **WorkBuddy 列表没变化**：确认 `%USERPROFILE%\.workbuddy\models.json` 已更新，重开模型面板。
- **端口占用**：设 `OFM_BRIDGE_PORT=11436` 后再启动。
- **密钥安全**：`settings.json` / `rescue-providers.json` 含密钥，已加入 `.gitignore`，勿提交、勿分享。

## 进阶

- 仅预览导入计划：`node src\setup-auto-entry.mjs --wb --dry`
- 回归测试：`node tests\run-regression.mjs`
- 健康与指标：`/health`、`/metrics`；一键解除熔断：`Invoke-RestMethod -Method POST http://127.0.0.1:11435/admin/reset-lanes`
