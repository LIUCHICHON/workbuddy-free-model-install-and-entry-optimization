---
name: free-model-entry-builder
description: 一键生成免费大模型"总入口"combo:auto 的技能。为 dsh-our-free-model standalone 创建/更新一条 combo:auto（默认 round-robin 双通道负载分散，抗 429），成员为 OpenCode + kilo 双通道自动择优，并可选接入 WorkBuddy models.json 置顶。脚本设备无关，靠环境变量 + 自动探测，可搬到其它 Mac/设备直接运行。当用户要"建总入口""生成总入口""一键接入 WorkBuddy 免费模型""换设备重装总入口""复制这套免费模型链路"时使用。
version: 1.0.0
agent_created: true
---

# 免费大模型总入口生成器（Free Model Entry Builder）

## 概述

用一条命令，为 dsh-our-free-model standalone 生成/更新 **`combo:auto` 总入口**：
- 策略默认 `round-robin`（双通道轮询，负载分散，抗 429）
- 成员**双通道**：OpenCode 通道优质模型 + kilo 通道模型（catalog 自动挑，排除已知不稳定项 `ling-3.2`/`lfm-3-1.7b`）
- 可选 `--strategy`：可指定 `fallback`/`round-robin`/`smart`/`usage`/`pace`
- 可选 `--wb`：**合并同步** WorkBuddy `models.json`（⓪ 总入口置顶 + 双通道单模型 + 保留外部直连，自动备份）
- 配套桥层（`ofm-bridge`）：**通道熔断 + 成员级直连 + 外部救援降级**，整池耗尽时也不会把 429 甩给用户

**设备无关**是核心设计：不写死任何绝对路径/端口/密钥，全部靠自动探测 + 环境变量，换一台 Mac 直接能跑。

> **为什么默认 round-robin 而非 smart？** `smart` 在没有配额读数时退化成"永远先打第一个模型"，连续请求会把单一通道（如 OpenCode）额度刷爆而频发 429。round-robin 每次请求从不同模型起步，把负载摊到双通道，显著降低单通道被打满的概率。standalone 链内仍会在单次请求内自动换下一个模型兜底；桥层（`ofm-bridge`）再对 429/5xx 做跨通道退避重试（见下方"稳定性设计"）。

## 脚本位置

`src/setup-auto-entry.mjs`（Node 脚本，无第三方依赖）

## 用法

```bash
# 进入脚本目录（或直接用绝对路径）
cd <本 skill 目录>/scripts

node setup-auto-entry.mjs --dry              # 只探测、打印计划，不改动（先跑这个确认路径对）
node setup-auto-entry.mjs                    # 创建/更新 combo:auto（默认 round-robin，不碰 WorkBuddy）
node setup-auto-entry.mjs --wb               # 额外插入 WorkBuddy models.json 置顶（会先备份）
node setup-auto-entry.mjs --strategy smart   # 指定策略（fallback/round-robin/smart/usage/pace）
```

## 环境变量（都可选，换设备时按需设）

| 变量 | 作用 | 默认 |
|---|---|---|
| `OFM_HOME` / `OFM_DATA_DIR` | standalone 数据目录 | `~/.our-free-model` |
| `OFM_BRIDGE_PORT` | 桥端口 | `11435` |
| `OFM_UPSTREAM` | 桥的上游 standalone 地址 | `http://127.0.0.1:18900/v1` |
| `OFM_WORKBUDDY_MODELS` | WorkBuddy models.json 路径 | `~/.workbuddy/models.json` |
| `OFM_RESCUE_CONFIG` | 桥的外部救援通道配置（`--wb` 自动生成） | `~/.our-free-model/rescue-providers.json` |
| `OFM_LANE_STATE` | 桥的通道熔断状态（时间戳，重启后仍生效） | `~/.our-free-model/bridge-lanes.json` |

> standalone 的数据目录与 `OFM_HOME` 一致（见 `packages/standalone/service.mjs` 的 `resolveStandaloneDataDir`）；端口在 `settings.json` 的 `standalonePort`，脚本会自动读取。

## 换设备运行步骤

1. 目标设备先装好 **Node.js ≥ 18**（脚本用内置 `fetch` / `AbortSignal.timeout`；低于 18 会直接给出升级提示并退出），再装 dsh-our-free-model standalone + ofm-bridge 并跑起来。
2. 拷贝本 skill 的 `src/setup-auto-entry.mjs` 到目标设备（或把整个 skill 目录拷过去）。
3. 若目标设备路径/端口非默认，用环境变量指定，例如：
   ```bash
   OFM_HOME=~/ofm-data OFM_BRIDGE_PORT=12000 node setup-auto-entry.mjs --dry
   ```
4. 确认 `--dry` 输出的路径/端口/成员都对，再正式跑（需要时加 `--wb` 接入 WorkBuddy）。
5. 验证：`curl -s http://127.0.0.1:<桥端口>/health` 返回 200；WorkBuddy 模型列表选「⓪ 总入口」。

### 跨设备兼容性（已实测）

| 检查项 | 结果 |
|---|---|
| 架构（Intel x64 / Apple Silicon arm64） | 代码里**零** `process.arch` / `uname` / `/opt/homebrew` 分支，不区分机型 |
| macOS 版本 | 零 `sw_vers` / `sysctl` 依赖；`launchctl` 仅用于重启，任何 macOS 都有 |
| 用户目录 | 全部走 `os.homedir()` 或 `OFM_HOME`，无写死用户名 |
| 数据目录 / 端口 / 上游地址 | 全部可被 `OFM_*` 环境变量覆盖（合成设备实测：换成 `/tmp/sim-device` + 34567 端口仍正常） |
| 模型清单 | 有 catalog 时**取交集**，不会把本机不存在的模型塞进组合 |
| Node 版本 | 脚本与桥都有 `>=18` 护栏，低版本给出明确升级指引而不是崩栈 |
| 启动脚本 | `start-bridge.sh` 由脚本自身位置 + `$HOME` 推导路径，可整目录搬到任意机器 |

> 换设备最容易踩的不是脚本，而是 **shell**：本机是 zsh（`for m in $var` 不分词），写循环要用数组；以及 **Agent 沙箱**（`ps`/`launchctl list` 为空、`launchctl load` 被拒），巡检类脚本要到真实终端跑。

## 它做了什么（原理）

1. 读 `settings.json` 拿 `managementKey`/`forwardKey`/`standalonePort`。
2. 读 `catalog.json`：`kiloRows` 是 kilo 通道模型、`entries` 是 OpenCode 通道模型；排除不稳定项（`inclusionai/ling-3.2-flash:free`、`liquid/lfm-3-1.7b:free`）。
3. 组装成员：OpenCode 优质 6 个 + kilo 8 个。
4. 登录 standalone 管理接口 `/api/management/session`（用 managementKey），`GET /routing` 判断是否已存在 `combo:auto`，`POST /routing/save`（body 为 `{ combo: {...} }`）upsert。
5. `--wb` 时：**探测上游 `/v1/models` 真实清单**，重建 WorkBuddy 桥内条目（⓪ 总入口 + ①..⑤ 专项 combo + 单模型按双通道分组，排除不稳定项），**保留外部直连条目**（非桥地址，如 sensenova/glm/agnes），备份后整表写回。名称尽量沿用已有条目，新条目自动编号，重复运行幂等。
6. `--wb` 时同时**刷新桥的外部救援通道配置** `~/.our-free-model/rescue-providers.json`（取 models.json 里带 apiKey 的外部直连条目，按 `RESCUE_RANK` 排序：`agnes` → `sensenova` → `glm-4-flash`），免费池整段限流时桥会自动降级到这里。

## 稳定性设计（抗 429 五层）

免费模型有严格的每分钟/每日配额，连续请求容易触发上游 HTTP 429；更糟的是**整条通道会同时打满**（实测 2026-11-14：OpenCode 给出 `retry after 次日 08:08`，同一时刻 Kilo 也返回 `Sign up for free…`，免费池 0 可用）。链路做了五层防护：

1. **combo 链内兜底（standalone）**：`classifyFailure({status:429})` 判为 `RATE_LIMIT / retryable`，`shouldAdvance=true`，单次请求内自动换下一个模型。
2. **总入口轮询（本 skill 默认 round-robin）**：每次请求从不同模型起步，把负载摊到 OpenCode/kilo 双通道，避免单一通道被打满。
3. **桥层通道熔断 + 成员级直连（`ofm-bridge` 的 `chatWithFallback`）**：
   - 从 429 报文里解析 `retry after <ISO>` 与通道特征（`OpenCode free quota` / `Sign up for free`），把**整条通道按恢复时间关闸**；关闸期间直接跳过，到期自动开闸，无需人工。
   - 无明确恢复时间的通道（Kilo）用指数退避：1min → 2 → 4 → 8 → 10min 封顶，成功后清零。
   - `combo:*` 请求由桥自己**按成员清单轮询直连**，只打「开闸」通道的成员，绕开上游内部的盲轮询；一条通道判死后**本轮剩余同通道成员一并跳过**（冷启动由 14 次尝试降到 2 次）。
   - **只有 429 关整条通道**；空正文/超时/5xx 属成员级问题，只冷却该成员 45s，不影响同通道其它成员。
   - 每次尝试 35s 超时，慢模型/挂死上游不会拖垮整条链。
4. **空正文守卫（桥层）**：HTTP 200 但 `message.content` 为空 + `finish_reason=length`，说明推理型成员把 token 预算全烧在隐藏推理上（实测 `completion_tokens=512 / content=null`，客户端表现为"空白回复/像崩了"）。这类响应视为失败，立即换下一个成员。仅对非流式生效（SSE 已发出的 chunk 无法回收）。
5. **外部救援降级（桥层，最后一道）**：免费池整段不可用时，自动降级到**独立配额的外部直连**（`~/.our-free-model/rescue-providers.json`，由 `--wb` 从 models.json 的外部直连条目自动生成）。流式/非流式都支持，返回时把 `model` 字段改回客户端请求的名字。
   - **救援通道顺序（2026-11-14 用户指定）：`agnes-2.5-flash` → `sensenova-6.8-flash-lite` → `glm-4-flash`**。桥按配置文件 `providers` 数组顺序依次尝试（改顺序只改数组，热加载生效）；`--wb` 重跑时按脚本内 `RESCUE_RANK`（agnes=0 / sensenova=1 / glm=2）还原同一顺序。`glm-4-flash` 固定排最后：仅 ~18 tok/s、长请求还会 500/截断，排前面会导致**长回复还没写完就超时/被截断**，表现为"结果输出不完整"。
   - **截断检测**：救援返回 `finish_reason=length` 视为不完整，自动换下一个通道重试拿完整版；全部都被截断时才返回最长的一份，并带 `X-OFM-Truncated: 1` 响应头。
   - 救援也失败时返回**中文可读错误**（含各通道恢复时间），不再抛上游原始 JSON。

> 桥层可用环境变量微调：`OFM_ATTEMPT_TIMEOUT_MS`（单次尝试超时，默认 35000）、`OFM_LANE_STATE`（熔断状态文件，默认 `~/.our-free-model/bridge-lanes.json`）、`OFM_RESCUE_CONFIG`（救援配置路径）。
>
> 排查入口：`curl -s http://127.0.0.1:<桥端口>/health` 的 `lanes` / `rescue` 字段会直接告诉你哪条通道关闸、何时恢复、救援通道是否在冷却。

## 关键坑（已踩过，务必注意）

- `/routing/save` 的 body 必须是 **`{ combo: {...} }`**（包一层 combo），不是裸对象。
- `/routing` 返回的数组字段是 **`combos`**（不是 routing/groups/data）。
- 更新已存在的 combo：传 `id` 走更新；新建：不传 `id`（服务端用 `name` 生成 `combo:<name>`）。传了不存在的 id 会报"路由组不存在"；新建时传了已存在的 name 会报"已有同名路由组"。
- `models` 不能重复、不能引用自身、每个 id 长度 ≤ 300。
- 保存前脚本已自动 `GET /routing` 判断，所以新建/更新都能正确分流。

## 验证口诀（完成即验证）

- 一键回归（17 项，含熔断/空正文/截断/救援/指标 + 真实冒烟）：`node <ofm-bridge>/tests/run-regression.mjs`（`SKIP_REAL=1` 只跑受控部分）。
- `--dry` 探测的路径/端口/成员正确。
- 正式跑后：`node ofm-combos.mjs get`（或 `GET /routing`）确认 `combo:auto` 成员数符合预期、含双通道。
- 经桥实测出字：`curl -s http://127.0.0.1:<桥>/v1/chat/completions -H "Authorization: Bearer <key>" -d '{"model":"combo:auto",...}'` 返回 200 出字。
- 稳定性自检：`curl -s http://127.0.0.1:<桥>/health` 里 `lanes.opencode/kilo` 的 `state` 与 `resumeAt` 是否符合预期、`rescue.providers` 是否已列出且 `cooling:false`。
- **整池耗尽演练**：把 `lanes` 两条都置 `closed` 后请求 `combo:auto`，应在 1s 内返回救援通道的出字结果（而不是 429）。

## 何时使用（触发词）

"建总入口""生成总入口""一键接入 WorkBuddy""换设备重装""复制这套免费模型""combo:auto""双通道入口"等。