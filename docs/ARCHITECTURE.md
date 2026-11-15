# 架构说明

## 链路

```
WorkBuddy / LM Studio / 任意 Ollama 客户端
        │  http://127.0.0.1:11435  (Ollama + OpenAI 兼容)
        ▼
src/ollama-bridge.mjs  ← 本仓库核心
        │  组合降级 combo:auto（round-robin 双通道，抗 429）
        │  通道级熔断 / 截断换道 / 外部救援 / /metrics 可观测
        ▼
dsh-our-free-model standalone (:18900)  ← 需单独部署，不在本仓库
        │
        ▼
免费大模型上游池（OpenCode / kilo / 第三方直连）
```

## 五层兜底

| 层 | 机制 | 位置 |
|---|---|---|
| 1 | combo 链内换模型 | standalone combos（`src/ofm-combos.mjs` 管理） |
| 2 | round-robin 双通道分散，抗单通道 429 | `src/setup-auto-entry.mjs` 生成 `combo:auto` |
| 3 | 桥层跨通道同步重试、熔断降权 | `src/ollama-bridge.mjs` |
| 4 | 外部救援通道（独立配额） | `examples/rescue-providers.example.json` |
| 5 | 服务掉线自愈 | `platforms/macos/healthcheck.sh` / Windows 计划任务 |

## 设备无关设计

- **核心逻辑全在 `src/`**，只用 Node 内置模块，零第三方依赖，Mac/Windows 共用同一份代码。
- **平台差异只在 `platforms/`**：macOS 用 bash + launchd，Windows 用 PowerShell + 计划任务。
- 路径一律由「脚本自身位置 → 仓库根」或 `$HOME` / `%USERPROFILE%` 推导，**不写死用户名、机型、绝对路径**。
- 所有可覆盖项都有环境变量：`OFM_HOME`、`OFM_DATA_DIR`、`OFM_BRIDGE_PORT`、`OFM_UPSTREAM`、`OFM_WORKBUDDY_MODELS`、`OFM_RESCUE_CONFIG`、`OFM_FORWARD_KEY`、`OFM_STANDALONE_DIR`。
- 换行符由 `.gitattributes` 约束：`.sh` = LF，`.bat`/`.ps1` = CRLF（PowerShell 文件带 UTF-8 BOM）。

## WorkBuddy Skill

`skills/` 下两个用户级 Skill 是这套方案的运维知识沉淀，可直接复制到 `~/.workbuddy/skills/`：

- `free-model-link-ops`：总入口不出字 / 429 / 掉线 / 挑花眼的排障流程
- `free-model-entry-builder`：一键生成 `combo:auto` 并导入 WorkBuddy（脚本与 `src/setup-auto-entry.mjs` 同源）
