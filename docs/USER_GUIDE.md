# 免费大模型链路 · 操作手册

> 适用环境：本机 macOS，WorkBuddy 自定义模型 → 本地桥(11435) → 独立服务(18900) → 各免费渠道
> 最后更新：2026-11-14

---

## 一、日常怎么用（先结论）

**你平时只选一个模型：`⓪ 总入口（轮询双通道·抗 429）`。**

它内部会自动挑当前最有额度、响应最快的免费模型；某个模型没额度、被卡死、超时、返回空，都会**自动跳到下一个**，通常不需要你手动干预。

专项场景才用别的入口（见下表），普通聊天/写东西/分析一律走 ⓪。

---

## 二、入口一览（WorkBuddy 模型选择列表）

| 入口名称 | 内部 id | 策略 | 模型数 | 用途 | 何时用 |
|---|---|---|---|---|---|
| **⓪ 总入口** | `combo:auto` | round-robin 双通道轮询 | 14 | 通用主力；通道熔断 + 外部救援，整池耗尽也能出字 | **平时就选这个** |
| ① 日常主力 | `combo:daily` | fallback 顺序降级 | 5 | 含视觉/推理的均衡链 | 想固定走一条稳妥链 |
| ② 快速响应 | `combo:fast` | fallback | 4 | 轻量快速 | 简单问答、要快 |
| ③ 深度推理 | `combo:deep` | smart 智能择优 | 4 | 推理型任务 | 复杂分析、长文 |
| ④ 看图识图 | `combo:vision` | fallback | 4 | 多模态视觉 | 上传图片/截图时 |
| ⑤ 代码专用 | `combo:code` | fallback | 3 | 代码补全/解释 | 写代码 |

> 列表里其余 `★` 开头是常用单模型、`备01…` 是备用、`外01…` 是直连第三方，一般不用管，出问题时才看。

---

## 三、为什么 ⓪ 总入口能彻底兜住"未知错误"

链路的失败判定已覆盖以下**全部**成因，任一发生都会自动跳到链下一个模型：

| 失败类型 | 触发 | 处理 |
|---|---|---|
| 额度耗尽 | 429 / `resource_exhausted` | 自动跳下一环 |
| 过载/服务端错 | 5xx / `overloaded` | 自动跳下一环 |
| 超时卡死 | 请求发出但 25 秒内不出正文（静默看门狗） | 判失败跳下一环 |
| 断流/断连 | `stream_cut` / `transport` | 自动跳下一环 |
| 空响应 | `empty_response` | 自动跳下一环 |
| **模型被下线** | **404 / `model not found`** | **自动跳下一环 + 拉黑该 id**（v5 新增，详见十.1） |

**关键区别**：直接选单模型（如 `★ DeepSeek V4.1 Flash`）没有降级层，死了就死，WorkBuddy 只会报"未知错误暂无响应"，需要你手动切到别的模型才有回复。所以**不要用单模型当日常入口**。

> ⚠️ **重要更正（2026-11-14 实测发现）**：上面这张表的降级是 dsh-our-free-model **combo 在"单模型级"** 的兜底——某模型临时 429/5xx/超时，combo 会跳到链里下一个**同通道**模型。但它**不会跨上游通道重试**：当某个上游通道（如 OpenCode）整体日额度被刷满时，该通道所有模型一起 429，combo 内部的降级救不回来，总入口整体失败，WorkBuddy 界面上只显示"未知错误暂无响应"。
>
> 这种情况由**桥层兜底**解决——`ofm-bridge/ollama-bridge.mjs` 识别到"通道级 429"会自动切换到独立的 kilo 通道重发。详见 **第十一节**。
>
> 📌 **口径说明**：链路自动化只做一件事——在同一条免费池里换模型、换通道、换救援，尽量自己把字吐出来；一旦彻底无解，就明确报错，不会在用户不知情的情况下换成别的模型。

---

## 四、主动巡检（healthcheck）

脚本 `ofm-bridge/healthcheck.sh` 每 2 分钟检查一次：
- 桥(11435)、独立服务(18900) 端口是否在、HTTP 是否通；
- **额外探活 `combo:auto` 总入口**（发 1 token 请求确认能出字）；
- 掉线就自动 `kickstart` 拉起，并把状态写入 `~/.our-free-model/health.json`。

### 看当前健康状态
```bash
cat ~/.our-free-model/health.json
# overall: healthy / critical / recovered
# services: bridge_11435 / standalone_18900 / combo_auto 各自状态
```

### 启用定时巡检（二选一）
- **立即生效**（在 Mac 终端跑）：
  ```bash
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ofm.healthcheck.plist
  # 验证：
  launchctl print gui/$(id -u)/com.ofm.healthcheck   # 应显示 state = running
  tail -f ~/.our-free-model/health.log               # 每 2 分钟一条记录
  ```
- **不跑也行**：plist 已在 `~/Library/LaunchAgents/`，Mac 下次登录/重启会自动加载。

---

## 五、排查清单（出问题怎么办）

| 现象 | 最可能原因 | 怎么处理 |
|---|---|---|
| WorkBuddy 报"未知错误暂无响应" | 你选了**单模型**（无降级层），或免费池整段耗尽 | 改选 `⓪ 总入口`；不要长期用 `★` 单模型 |
| 所有模型都没响应 / 一直转圈 | 桥或独立服务挂了 | 看 `health.json`；手动拉起见下方"速查" |
| 桥返回 502（上游不可达） | 独立服务(18900)被强杀后残留**陈旧锁** `service.lock` 导致起不来 | 启动脚本已硬化会自动清"死 pid 锁"；仍异常就手动删锁后 kickstart（见速查） |
| 重启 Mac 后模型集体掉线 | LaunchAgent 未生效或你没在真实 Mac 注册过 | 确认下面 3 个 agent 状态；healthcheck 那条需手动 bootstrap（见第四节） |
| 想临时看哪个免费模型还能用 | — | `node ofm-combos.mjs get` 看链；或直接试 `combo:auto` |

---

## 六、关键文件路径

| 文件 | 路径 | 说明 |
|---|---|---|
| WorkBuddy 模型配置 | `~/.workbuddy/models.json` | 35 条，⓪ 总入口置顶 |
| 独立服务设置 | `~/.our-free-model/settings.json` | 含 combo 定义、forwardKey |
| 健康状态 | `~/.our-free-model/health.json` | 每 2 分钟更新 |
| 健康日志 | `~/.our-free-model/health.log` | 巡检明细 |
| 服务锁 | `~/.our-free-model/service.lock` | 独立服务运行锁（**活进程时存在属正常**，别乱删） |
| 巡检脚本 | `ofm-bridge/healthcheck.sh` | 主动自愈 |
| 启动脚本 | `ofm-bridge/start-standalone.sh` | 已硬化：启动前清死 pid 锁 |
| combo 管理 | `ofm-bridge/ofm-combos.mjs` | 增删改 combo（`get`/`save`/`batch`/`remove`） |
| 3 个 LaunchAgent | `~/Library/LaunchAgents/com.ofm.{ollama-bridge,standalone,healthcheck}.plist` | 开机自启/保活 |

---

## 七、重启 / 拉起速查命令

```bash
# 看 3 个守护是否在跑
for l in com.ofm.ollama-bridge com.ofm.standalone com.ofm.healthcheck; do
  launchctl print gui/$(id -u)/$l 2>/dev/null | grep -E "^\s*(state|pid)" | head -2 | sed "s/^/  $l /"
done

# 手动拉起（任一掉了）
launchctl kickstart -k gui/$(id -u)/com.ofm.ollama-bridge
launchctl kickstart -k gui/$(id -u)/com.ofm.standalone
launchctl kickstart -k gui/$(id -u)/com.ofm.healthcheck

# 独立服务陈旧锁清理（仅当 kickstart standalone 反复失败、且确认无进程占用 18900 时）
# 先确认无进程：lsof -nP -iTCP:18900 -sTCP:LISTEN
rm -f ~/.our-free-model/service.lock
launchctl kickstart -k gui/$(id -u)/com.ofm.standalone

# 立即跑一次巡检验证
bash ~/WorkBuddy/2026-11-13-17-40-11/ofm-bridge/healthcheck.sh
```

---

## 八、已知限制（重要）

- **沙箱局限**：WorkBuddy 内置 Bash 有独立 PID 命名空间，碰不到你真实 Mac 的 launchd，所以 `launchctl bootstrap` / `crontab` 这类操作需在**真实 Mac 终端**执行（本手册第四节的命令）。桥与独立服务本身已在真实 Mac 的 LaunchAgent 里保活。
- **bash 版本**：macOS 自带 bash 3.2，不支持关联数组，脚本均用标量变量，勿在 Linux 高版本之外改写法。
- **免费额度**：所有上游为免费渠道，单模型有日额度上限；这正是 `combo:auto` 用 10 模型轮转的意义——单个耗尽会自动换下一个。
- **上游会下线模型（v5 已处理）**：上游把模型 id 从清单里撤掉时，请求回 404。桥现在会跳过该成员继续试下一个，并把它写进黑名单（24h 后自动放行探测）。**代价**：该模型在本窗口内不再参与轮询，池子变小但不影响出字。若上游长期不下线新模型，24 小时后会自动重新纳入。
- **combos 快照不自动更新**：`settings.json` 的 `combos` 是历史快照，上游下线模型后它仍留着旧 id。桥靠实时清单 + 黑名单双保险兜住，但如果你想保持干净，可手工删掉已下线的 id（删完无需重启，桥按 mtime 热加载）。
- **数据目录变量口径已统一（v5）**：`OFM_HOME` / `OFM_DATA_DIR` 现在桥与 `setup-auto-entry.mjs` **都认**（此前只有导入脚本认，桥不认会导致"配了 OFM_HOME 但桥仍读默认路径"的错位）。

---

## 九、一键自查工具（查疑补缺用）

`ofm-bridge/selfcheck.sh`（配合 `probe.sh`）会**并发扫描全部非 combo 单模型**的存活状态，自动找出当前废掉的模型，并临时构造"废链头 combo"实拍降级是否生效，最后自动清理测试链。这是日常查疑补缺的趁手工具。

```bash
bash ~/WorkBuddy/2026-11-13-17-40-11/ofm-bridge/selfcheck.sh
```

输出会列出每个模型的 HTTP 状态（`.`=200，`X`=非 200 即可能废），发现废模型时会自动复验降级。建议**免费额度波动大时偶尔跑一次**，及时发现并标注废模型，避免挑花眼误选。

---

## 十、当前已知不可用单模型（动态，截至 2026-11-22）

### 已被上游下线（404 model not found · 永久性）

上游把模型下线时，模型 id 会**从上游 `/v1/models` 清单里消失**，直接请求回 `404 model "xxx" not found`。

| 模型 id | 原本所属 | 状态 | 处理 |
|---|---|---|---|
| `glm-5.3-flash-free` | combo:auto / daily / deep | 404 已下线 | 已从 combos 移除 + 桥自动拉黑 |
| `dots-studio/dots-3-note-preview:free` | combo:auto / 跨通道池 | 404 已下线 | 已从 combos 与跨通道池移除 |
| `cohere/north-mini-code:free` | combo:auto / code / 跨通道池 | 404 已下线 | 同上 |
| `minimax-m3.1-flash-free` | combo:fast | 404 已下线 | 已从 combos 移除 |
| `inkling-2-small-free` | combo:fast | 404 已下线 | 已从 combos 移除 |

### 临时不可用（额度/限流 · 会恢复）

| 模型 | 状态 | 是否已标注 | 影响 |
|---|---|---|---|
| `inclusionai/ling-3.2-flash:free`（备12） | 429 额度耗尽 | 名称已加 `[暂不可用]` | 不在任何 combo，走总入口不受影响；勿直接单选 |
| `liquid/lfm-3-1.7b:free`（备14） | 连接超时/失败 | 名称已加 `[暂不可用]` | 同上 |

> 免费额度按日恢复，明天可能复活。若想精简列表，可直接从 `models.json` 删除这两个条目；恢复时再加回。改完 `models.json` 后无需重启，WorkBuddy 下次打开模型列表即生效。

---

## 十.1、模型被上游下线导致「总入口无故中断」（v5 · 2026-11-22 已修）

### 现象
WorkBuddy 用 `⓪ 总入口` 时，界面弹出红色错误条：
```
404 model "dots-studio/dots-3-note-preview:free" not found
```
并且回复显示"未知错误暂无响应"。**同样的问题会随机冒出来**（取决于轮询游标停在哪）。

### 根因（两层）
1. **上游下线了模型 id**：`glm-5.3-flash-free`、`dots-studio/...`、`cohere/...`、`minimax-m3.1-flash-free`、`inkling-2-small-free` 这 5 个 id 已从上游 `/v1/models` 清单消失，请求直接回 404。
2. **桥把 404 当成"成功返回"**：旧逻辑里 `isRetryableStatus()` 只认 429/502/503/504，404 落到 `retryable=false`，于是桥**直接把上游的 404 原样甩回 WorkBuddy**，整个 combo 请求在第一个死成员处就中断——后面十几个正常成员根本没轮到。

> 实测复现率：修复前连续 20 次请求 **6 次直接 404 失败（30%）**，且每次失败的 id 都不同（轮询游标随机命中）。

### v5 修复（三道防线）
1. **实时清单过滤**：候选成员先与上游 `/v1/models` 比对，上游已不在清单里的直接不试（零浪费请求）；
2. **404 识别为"成员级失效"**：识别 `not found / does not exist / unknown model / deprecated` 等报文，标记为成员级问题 → **跳过该成员继续试下一个**，同时**不关通道**（404 与 429 性质完全不同）；
3. **持久化黑名单**：确认下线的 id 写进 `~/.our-free-model/bridge-dead-members.json`，进程重启也不忘，24 小时后自动放行一次探测（上游可能把模型加回来）。

### 修复效果（实测）
| 场景 | 修复前 | 修复后 |
|---|---|---|
| 生产桥连打 20 次 | 14 成功 / **6 次 404 中断（30%）** | — |
| 生产桥连打 30 次 | — | **30/30 全部 200，零失败**，平均 1.4–1.6s |
| 假上游（清单过期 + 前两成员 404） | 直接 404 失败 | 自动跳过，落到第三个成员出字，HTTP 200 |

### 运维
```bash
# 看当前被拉黑的模型
curl -s http://127.0.0.1:11435/metrics | python3 -m json.tool | grep -A3 deadMembers

# 手动清空黑名单（上游可能把模型加回来了）
curl -s -X POST http://127.0.0.1:11435/admin/reset-dead-members

# 连同通道熔断一起重置
curl -s -X POST http://127.0.0.1:11435/admin/reset-lanes
```

> **注意**：`settings.json` 里的 `combos` 是**历史快照**，上游下线模型后它不会自动更新。桥现在会自己过滤，所以即使快照里还留着死 id 也不会打它；但如果你手动整理 combos，删掉已下线的 id 会更清爽。

---

## 十一、桥跨通道自愈（核心兜底 · 防"总入口整池 429 无字可出"）

### 问题根因
免费模型分多个独立限额的上游通道（OpenCode / kilo / extension）。当 **OpenCode 通道日额度被刷满**，dsh-our-free-model 返回 429，文案含 `Free usage limit reached ... Kilo and extension channels are unaffected`。它的 combo **只在同一通道内跳模型，不会跨通道重试**——OpenCode 全限额时，总入口整体 429，WorkBuddy 界面只显示"未知错误暂无响应"。

### 解决（桥层 v3 已实现）
`ofm-bridge/ollama-bridge.mjs` 在转发 `POST /v1/chat/completions` 时：
1. **只按状态码**判定可恢复（429/502/503/504），不再靠文案正则；
2. 从 429 报文里解析 `retry after <ISO>` 并识别通道（`OpenCode free quota` / `Sign up for free`），把整条通道**熔断**到恢复时间点，关闸期间直接跳过 → 不再白试、不再拖 8 秒；
3. `combo:*` 请求改为**桥自己按成员清单轮询直连**，只打「开闸」通道的成员；一条通道判死后本轮剩余同通道成员一并跳过；
4. 免费池整段不可用时，降级到**外部救援通道**（见十二节），而不是把 429 甩给用户；
5. 全部失败时才报错，且返回中文可读原因 + 各通道恢复时间。

> 2026-11-14 实测：OpenCode 给出 `retry after 次日 08:08`，同一时刻 Kilo 也返回 `Sign up for free…`，免费池 0 可用。v3 上线后 10 次连续请求 **10/10 出字**（0.4–1.6s），不再出现 429。

### 改完桥源码后必须重启桥进程
桥由 LaunchAgent（`com.ofm.ollama-bridge`）的 `KeepAlive` 守护。改了 `ollama-bridge.mjs` 后**必须 kill 旧进程**让 KeepAlive 拉起新代码（之前实测 1 秒内自动重启）：
```bash
# 查桥 PID
lsof -nP -iTCP:11435 -sTCP:LISTEN -t
# kill 后 KeepAlive 自动重启加载新代码
kill -9 <PID>
# 验证
curl -s http://127.0.0.1:11435/health   # 应返回 HTTP 200
```
> 或在真实 Mac 终端：`launchctl kickstart -k gui/$(id -u)/com.ofm.ollama-bridge`

### 实测验证（OpenCode 限额场景）
2026-11-14 在 OpenCode 通道已被刷满（真实 429）时，stream 模式连发 3 轮 `combo:auto` 经桥，**全部 HTTP 200 正常出字**（桥自动切 kilo），首字延迟约 1.4–2.4s（比平时多一次重试，但完全可用）。证明修复生效。

## 十二、通道熔断与外部救援（v3 · 2026-11-14）

### 两条状态文件
| 文件 | 作用 | 想干预时怎么办 |
|---|---|---|
| `~/.our-free-model/bridge-lanes.json` | 通道熔断表（`until` 时间戳 + 原因） | 删掉它，或把各通道 `until` 改 0，再重启桥，立即解除熔断 |
| `~/.our-free-model/rescue-providers.json` | 外部救援通道（baseUrl/apiKey/model） | `enabled:false` 可整体关掉；`onlyForCombos:true` 可限制只救总入口 |

救援配置由 `free-model-entry-builder` 的 `setup-auto-entry.mjs --wb` **自动从 WorkBuddy models.json 的外部直连条目生成**，日常不用手改。

**当前救援顺序（用户指定，2026-11-14 更新）：**

```
① agnes-2.5-flash  →  ② sensenova-6.8-flash-lite  →  ③ glm-4-flash
```
- 桥**按该文件 `providers` 数组顺序依次尝试**，改顺序只需调数组顺序，**改完立即生效，不用重启桥**（桥按 mtime 热加载）。
- 重跑 `setup-auto-entry.mjs --wb` 会按脚本内 `RESCUE_RANK` 重新生成同一顺序（agnes=0 / sensenova=1 / glm=2），不会把顺序改回去。
- `glm-4-flash` 固定排最后：实测仅 ~18 tok/s、长请求会 500/截断，排前面会把长回复拖成"输出不完整"。

### 怎么一眼看出现在是什么状态
```bash
curl -s http://127.0.0.1:11435/health | python3 -m json.tool
```
- `lanes.opencode` / `lanes.kilo`：`state=closed` 表示该通道额度耗尽，`resumeAt` 是恢复时间，`secondsLeft` 是剩余秒数。
- `rescue.providers`：`cooling=true` 表示该救援通道刚失败过，正在冷却。

### 判读口径
| lanes 状态 | 含义 | 正确表现 |
|---|---|---|
| 两条都 closed | 免费池整段耗尽（上游硬限制，不是 bug） | 救援通道出字，**不该报错** |
| 仅 OpenCode closed | Kilo 还有额度 | Kilo 成员接住 |
| 都 open 却仍 429 | 桥没生效 / 跑的是旧代码 | 重启桥；仍不行就看代码是否含 `chatWithFallback` |

### 想彻底摆脱"整池耗尽"
1. 给 standalone 配**出口代理**（`settings.json` 的 `freeLane.proxyUrl` 或 UI 里的 egress）：换 egress IP ≈ 重置 OpenCode 免费窗口额度；
2. 或依赖已实现的救援降级：把"报错"变成"慢 1 秒但能出字"。

### 已知边界
- 救援通道也是免费额度，高频使用同样会 429。`agnes-2.5-flash` 现已排**第一**：若账号尚未在 agnes 平台实名认证，会立即返回 429（提示“请登录 platform 进行实名认证以获取更高 rpm”），耗时约 0.2 秒后自动跳到下一条，**不影响出字，只多花约 0.2 秒**；完成实名后它就是最快的首选救援。
- 流式请求的救援是**透传**的；若上游已开始吐 chunk 又中断，已发内容无法回收。
- 空正文守卫只对非流式生效（SSE 已发出的帧收不回来）。

### 十二.1 结果输出不完整（回复写到一半就停）

2026-11-14 晚出现：长回复在 `_path": "/Users/yong` 处断掉，无报错。

**根因**：救援链首选 `glm-4-flash`。实测它只有 **~18 tok/s**（输出 800 行要 118 秒），单次上限小，长请求还会直接返回 HTTP 500。长回复还没写完就超过客户端等待上限，或被 `finish_reason=length` 截断。

**修复**：
1. 救援顺序调整：最初改为 **sensenova（~100 tok/s、可出 3.5k tokens）→ agnes → glm-4-flash**；**2026-11-14 晚按用户要求再调整为 agnes → sensenova → glm-4-flash**（详见本节开头"当前救援顺序"）。无论哪种排序，`glm-4-flash` 始终固定排最后。
2. 桥把 `finish_reason=length` 判定为"不完整"，**自动换下一条救援通道重试**；全都被截断才返回最长的一份，并加响应头 `X-OFM-Truncated: 1`。

**效果**：同一道 600 行长输出题，改造后 15.7 秒（非流式）/ 13.9 秒（流式）完整出字；改造前 36–118 秒且会被截断。

**自己怎么查**：见 `free-model-link-ops` 的「场景 F」与命令速查第 14 条（含逐条通道测速脚本、`OFM_DEBUG_CHAT=1` 诊断日志开关）。

### 十二.2 换一台 Mac 能不能直接用

桥与两个 skill 已做成设备无关：
- 启动脚本 `start-bridge.sh` 由**自身所在目录 + `$HOME`** 推导路径，不再写死用户名；
- 端口 / 上游地址 / 数据目录全部可被 `OFM_*` 环境变量覆盖；
- 脚本与桥都要求 **Node.js ≥ 18**，低版本会打印升级指引后退出（而不是崩栈）；
- 代码里没有任何 `uname` / `process.arch` / `/opt/homebrew` 分支，Intel 与 Apple Silicon 同款行为。

实测方式：把 `OFM_HOME` 指向一个**合成的空设备目录**（自带 settings/catalog/models），换端口跑 `--dry`，成员、改名、外部直连、救援配置全部按新环境正确生成。

## 十三、可观测性、Windows 与安全（v4 · 2026-11-14）

### 13.1 指标与运维端点
| 端点 | 作用 |
|---|---|
| `GET /metrics` | 累计指标：requests / successes / successRatePct / avgLatencyMs / sources（谁出的字）/ emptyReplies / truncations / **deadMembers** / laneCloses；另附当前黑名单 |
| `POST /admin/reset-lanes` | 一键解除全部通道熔断 + 成员/救援冷却 + 轮询游标归零 |
| `POST /admin/reset-dead-members` | 清空「上游已下线模型」黑名单（上游可能把模型加回来） |
| `node tests/run-regression.mjs` | 一键回归 **21 项**（受控假上游 + 真实冒烟），退出码 0 = 全过 |

指标落盘 `~/.our-free-model/bridge-metrics.json`，重启不丢；桥退出时（SIGTERM/SIGINT）同步落盘熔断、指标与黑名单。
黑名单落盘 `~/.our-free-model/bridge-dead-members.json`（权限 600）。

**长期判读**：rescue 占比持续升高 → 免费池紧张，配出口代理；emptyReplies 频繁 → 有推理型成员烧预算；**deadMembers 增长 → 上游在持续下线模型，需要更新 combos 快照**；successRatePct < 95 → 按场景排障。

### 13.2 Windows 部署
1. `winget install OpenJS.NodeJS.LTS`（≥18）。
2. 拷贝 `ofm-bridge/` 整目录 + `settings.json`。
3. `powershell -ExecutionPolicy Bypass -File start-bridge.ps1` 启动。
4. `install-bridge-service.ps1` 注册计划任务（登录自启 + 每分钟自愈，对标 launchd KeepAlive）；`-Uninstall` 卸载。
5. ps1 均带 UTF-8 BOM，勿用 ANSI 编辑器保存。

### 13.3 密钥与配置安全
- 含密钥文件 600、`~/.our-free-model/` 目录 700；桥与导入脚本写盘自动 chmod 600。
- 脱敏示例：`rescue-providers.example.json`；真实配置禁止提交 git / 分享。
- 排障截图遮盖 apiKey。
