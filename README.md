# WorkBuddy 免费大模型安装及入口优化

> 把一堆免费大模型，收敛成**一个稳定、能自动兜底的总入口**。
> 本仓库由原先的 **macOS 工程版** + **Windows 一键安装包** 合并而来，统一为跨平台、平台无关的 GitHub 通用格式。

[English](README.en.md) · [操作手册](docs/USER_GUIDE.md) · [架构](docs/ARCHITECTURE.md) · [安全说明](docs/SECURITY.md)

## 一句话结论

核心逻辑只保留**一份**（`src/`，Node.js 零第三方依赖），macOS 用 bash + launchd、Windows 用 PowerShell + 计划任务，两边共用同一套桥代码。所有真实密钥、用户名、绝对路径已清除，配置改为模板，开箱即克隆即用。

## 它能解决什么

| 痛点 | 本仓库的做法 |
|---|---|
| 20+ 免费模型挑花眼 | 自动生成 `combo:auto` 总入口，置顶导入 WorkBuddy 模型表 |
| 总入口报「未知错误 / 没额度 / 卡死」 | combo 链内降级 → 双通道 round-robin → 桥层熔断换道 → 外部救援 |
| 通道级 429 把回复截断 | 桥层识别通道限流，同步换道重发，输出不再半截 |
| 服务掉线没人管 | macOS launchd KeepAlive + 健康检查自愈；Windows 计划任务崩溃每分钟重启 |
| 换一台设备就跑不起来 | 路径全部由脚本自身位置 + `$HOME` / `%USERPROFILE%` 推导，环境变量可覆盖 |

上游 `dsh-our-free-model` standalone 需单独部署，本仓库不含其源码。

## 快速开始

前置：**Node.js ≥ 18**；已部署 standalone（默认 `http://127.0.0.1:18900`）；可选 WorkBuddy。

| 平台 | 一条命令 / 一个动作 | 详细文档 |
|---|---|---|
| Windows | 双击 `platforms/windows/start.bat` | [docs/WINDOWS.md](docs/WINDOWS.md) |
| macOS | `bash platforms/macos/start-bridge.sh` | [docs/MACOS.md](docs/MACOS.md) |

首次运行会在 `~/.our-free-model`（Windows 为 `%USERPROFILE%\.our-free-model`）生成 `settings.json` 并提示填写 `forwardKey`；填好再启动一次，即自动搜索免费模型、生成总入口并导入 WorkBuddy。

健康检查：`http://127.0.0.1:11435/health`，指标：`/metrics`。

## 目录结构

```
.
├── src/                       # 平台无关核心（Mac / Windows 共用）
│   ├── ollama-bridge.mjs      #   桥：熔断、救援、截断换道、指标
│   ├── setup-auto-entry.mjs   #   自动搜模型 + 生成 combo:auto + 导入 WorkBuddy
│   ├── ofm-combos.mjs         #   combo 增删改查
│   ├── healthcheck.mjs        #   模型逐个探活 / 链路自检
│   ├── verify.mjs             #   端到端验证
│   └── patch-lms-plugin.mjs   #   LM Studio 插件同步
├── platforms/
│   ├── macos/                 #   .sh + launchd 模板 + 一键安装 launchd
│   └── windows/               #   .bat（CRLF）+ .ps1（UTF-8 BOM）
├── examples/                  #   配置模板（密钥均为占位符）
├── docs/                      #   中文手册、架构、双平台部署、安全
├── skills/                    #   两个 WorkBuddy 用户级 Skill
└── tests/run-regression.mjs   #   17 项回归
```

## 与旧版的文件对应

| 旧（Mac 工程 / Windows 安装包） | 新（本仓库） |
|---|---|
| `ollama-bridge.mjs`（两份重复） | `src/ollama-bridge.mjs`（单一来源） |
| `scripts/setup-auto-entry.mjs` | `src/setup-auto-entry.mjs` |
| `settings.example.json` / `rescue-providers.example.json` | `examples/` |
| `一键启动.bat` | `platforms/windows/start.bat` |
| `安装后台服务.bat` / `卸载后台服务.bat` | `platforms/windows/install-service.bat` / `uninstall-service.bat` |
| `README-Windows.txt` | `docs/WINDOWS.md` |
| `免费大模型链路-操作手册.md` | `docs/USER_GUIDE.md` |
| `命令速查.md` | `skills/free-model-link-ops/references/COMMANDS.md` |
| `com.ofm.*.plist`（写死本机路径） | `platforms/macos/launchd/*.plist.example` + `install-launchd.sh` |
| `models.json`（真实配置） | **不上传**，见 `.gitignore` |

## 验证

```bash
for f in src/*.mjs tests/*.mjs; do node --check "$f"; done
for f in platforms/macos/*.sh; do bash -n "$f"; done
node tests/run-regression.mjs
```

## 安全

- **不含任何真实密钥**：桥 key 为 `REPLACE_WITH_YOUR_FORWARD_KEY`，救援 apiKey 为 `sk-REPLACE-ME`。
- `settings.json` / `rescue-providers.json` / `models.json` / `logs/` 全部被 `.gitignore` 排除。
- 桥只监听 `127.0.0.1`，请勿直接暴露公网。详见 [docs/SECURITY.md](docs/SECURITY.md)。

## 许可

MIT，见 [LICENSE](LICENSE)。欢迎 Issue / PR，见 [CONTRIBUTING.md](CONTRIBUTING.md)。
