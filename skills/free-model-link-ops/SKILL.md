---
name: free-model-link-ops
description: 免费大模型网关（dsh-our-free-model + ofm-bridge + WorkBuddy 自定义模型）的运维与排障技能。当用户遇到 WorkBuddy 里免费模型"未知错误/总入口不出字/没额度/卡死/挑花眼"，或要调整 combo 轮询链、模型列表排序、桥跨通道兜底、healthcheck 巡检、启动自愈时，加载本技能。核心认知：免费模型分多个独立限额的上游通道（OpenCode/kilo/extension），combo 只做同通道内单模型级跳转、不跨通道；通道级 429 必须由桥层同步重试兜底，否则总入口整体失败、界面只显示"未知错误暂无响应"。
version: 1.0.0
agent_created: true
---

# 免费大模型链路运维排障（Free Model Link Ops）

## 概述

本技能封装一条"免费大模型"本地链路的运维知识，适用环境：
`WorkBuddy 自定义模型` → `127.0.0.1:11435`（ofm-bridge，Ollama 协议桥）→ `127.0.0.1:18900`（dsh-our-free-model standalone）→ 各免费上游通道。

当用户抱怨 WorkBuddy 里免费模型"未知错误 / 总入口不出字 / 没额度 / 卡死 / 列表挑花眼"，或要改轮询链、排序、巡检时，按本技能定位与修复。

## 核心认知（务必先记住，这是踩坑换来的）

1. **免费模型分多个独立限额的上游通道**（OpenCode / kilo / extension）。每个通道有自己的日免费额度。
2. **dsh-our-free-model 的 combo 只做"同通道内单模型级"降级**：某模型 429/5xx/超时，combo 会跳到链里同通道下一个模型。
3. **combo 不会跨通道重试**（关键陷阱）：当某个通道（如 OpenCode）整体日额度被刷满时，该通道所有模型一起 429，combo 内部跳转救不回来 → 总入口整体失败，界面只显示"未知错误暂无响应"。
4. **通道级 429 必须由桥层兜底，且要"记得住"**：`ollama-bridge.mjs`（v3）只按状态码判定可恢复性，再从 429 报文解析 `retry-after` 把整条通道**熔断**（持久化）；关闸期间直接走其它通道或外部救援，到期自动开闸。整池耗尽时降级到独立配额的外部直连，而不是把 429 甩给用户。
5. 免费额度按日恢复；`inclusionai/ling-3.2-flash:free`、`liquid/lfm-3-1.7b:free` 已知不稳定，兜底池里要排除。

## 关键路径（在本机已落地）

- 桥源码与脚本：`<ofm-bridge 目录>/`（本机示例 `$REPO_ROOT/`；换设备用 `REPO_ROOT` 指向本仓库）
  - `ollama-bridge.mjs`（v3：通道熔断 + 成员直连 + 外部救援 + 错误透传，备份 `*.bak-*`）
  - `start-bridge.sh` / `start-standalone.sh`（后者硬化了"陈旧 service.lock 清理"）
  - `healthcheck.sh`（每 2 分钟巡检 + combo:auto 探活）
  - `ofm-combos.mjs`（读写 combo：`get` / `save`（新建，name 不带 id）/ `batch`（更新，带 id）/ `remove`）
- standalone 数据：`~/.our-free-model/settings.json`（forwardKey/managementKey/combos）、`catalog.json`（entries=OpenCode通道、kiloRows=kilo通道，每个模型带 channel）、`health.json`、`service.lock`
- 桥的两份状态/配置（v3 新增）：
  - `~/.our-free-model/bridge-lanes.json` —— 通道熔断表（`until` 时间戳 + 原因），桥重启后仍生效；想立刻解除熔断就删它或改 `until` 为 0。
  - `~/.our-free-model/rescue-providers.json` —— 外部救援通道（由 `setup-auto-entry.mjs --wb` 自动生成，含 baseUrl/apiKey/model；`enabled`/`onlyForCombos`/`timeoutMs` 可手工调）。
- WorkBuddy 模型列表：`~/.workbuddy/models.json`（桥 key 形如 `REPLACE_WITH_YOUR_FORWARD_KEY`，原样保留）
- 操作手册：`docs/USER_GUIDE.md`（11 节，含重启桥命令、排查清单、已知不可用模型）
- 自查脚本：`platforms/macos/selfcheck.sh` + `platforms/macos/probe.sh`（并发扫描全部单模型存活 + 自动构造废链头复验降级）

## 标准排障流程

### 场景 A：WorkBuddy 报"未知错误"或总入口不出字
1. **先判断是"单模型级"还是"通道级"**：
   - 直测一个单模型：`curl -s -m 30 http://127.0.0.1:11435/v1/chat/completions -H "Content-Type: application/json" -H "Authorization: Bearer REPLACE_WITH_YOUR_FORWARD_KEY" -d '{"model":"deepseek-v4.1-flash-free","messages":[{"role":"user","content":"hi"}],"max_tokens":5,"stream":false}'`
   - 返回 429 且文案含 `Free usage limit reached / OpenCode / Kilo and extension channels are unaffected` → **通道级限额**，是 combo 跨不过去的。
2. **确认桥是否是 v3 内核**（读 `ollama-bridge.mjs` 是否有 `chatWithFallback` / `laneState` / `tryRescue` / `relayError`）。只有 `isChannelLimit` 的文案匹配版、或只有 `chatWithChannelFallback` 的"盲试 9 候选 + 退避"版，说明没升到 v3，按下方"修复"补。
3. **看 `/health` 的 `lanes` 字段**：`closed` 说明该通道额度已耗尽（带 `resumeAt`），这是上游硬限制，只能等它恢复或走救援通道；`open` 但请求还失败，才是桥/代码问题。
4. **确认桥跑的是新代码**：改了桥源码必须 `launchctl kickstart -k gui/$(id -u)/com.ofm.ollama-bridge`（或 kill 旧进程让 KeepAlive 拉起）。

### 场景 B：服务掉线 / 502 / 进程不在
1. 查端口：`lsof -nP -iTCP:11435 -sTCP:LISTEN -t` 和 `18900`。
2. standalone 被 kill -9 后，macOS 不回收 `service.lock` → KeepAlive 反复失败 → 桥一直 502。**先清陈旧锁再拉起**：
   - 看锁里 pid 是否存活：`cat ~/.our-free-model/service.lock`；pid 已死则 `rm -f ~/.our-free-model/service.lock`，再 `launchctl kickstart -k gui/$(id -u)/com.ofm.standalone`。
   - `start-standalone.sh` 已内置"pid 已死则删锁"，正常重启不会踩。
3. 桥/standalone 的 LaunchAgent 有 KeepAlive，kill 后 1 秒内自动拉起（真实 Mac 上）。

### 场景 C：模型列表挑花眼
- `~/.workbuddy/models.json` 用中文数字前缀分组：`⓪ 总入口`、`①..⑤` 专项 combo、`★ 常用单模型`、`备01..` 备用、`外01..` 直连。
- 日常只选 `⓪ 总入口（轮询双通道·抗 429）`。

### 场景 D：回复空白 / 看起来"崩了"
- **现象**：WorkBuddy 出空白或只有极短内容；抓原始报文是 `choices[0].message.content = null`、`finish_reason = "length"`、`completion_tokens = 512`。
- **原因**：部分成员是推理型，把 token 预算全烧在隐藏 `reasoning` 上（流式里 `delta.reasoning` 一直有、`delta.content` 始终空）。免费上游对单次 completion 有 512 上限，推理一超就没有正文。
- **处置**：桥层已内置**空正文守卫**——检测到"200 + 空正文 + finish=length"就把该成员冷却 45s 并换下一个成员（**成员级**问题，不关整条通道）。客户端可同时补 `reasoning_effort:'low'` 或把 `max_tokens` 抬到 ≥2048（实测推理消耗可降到 0）。
- **流式注意**：SSE 已发出的 chunk 无法回收，所以流式请求不做守卫。若某次流式只看到推理没有正文，重发一次或改用 `deepseek-v4.1-flash-free` / `glm-5.3-flash-free` / `mimo-v2.6-flash-free` 这类非重推理成员。
- **验证**：带小预算连打 10 次 `max_tokens:24`，应 0 次空正文（改造前约 1/6 会空）。

### 场景 E：`Quota exceeded: 429 {"error":"{\"error\":{…OpenCode free quota…`（整池耗尽）

**现象**：总入口隔几次就弹这条，文案带 `the OpenCode free quota window is open on this egress … retry after 2026-11-15T00:08:21.361Z … Kilo and extension channels are unaffected`。两个细节值得注意：
- 顶部 `{"error":"{\"error\"` 的**双层转义**是桥把上游错误二次包装的痕迹（v3 的 `relayError` 已修）。
- 报错只出现在 `combo:auto` 上、单模型却"看着还好"，说明 combo 内部轮到了已耗尽的通道。

**三步确诊**（不要凭感觉，按这三步走）：

```bash
# ① 通道级状态（最重要，一眼看出哪条通道关闸、何时恢复）
curl -s http://127.0.0.1:11435/health | python3 -m json.tool | head -30

# ② 逐成员并发探测：区分「通道级限额」和「单模型挂了」
python3 - <<'PY'
import json, os, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
KEY = json.load(open(os.path.expanduser('~/.our-free-model/settings.json')))['forwardKey']
mem = [c['models'] for c in json.load(open(os.path.expanduser('~/.our-free-model/settings.json')))['combos'] if c['id']=='combo:auto'][0]
def probe(m):
    b = json.dumps({"model": m, "messages":[{"role":"user","content":"ok"}], "max_tokens":8}).encode()
    r = urllib.request.Request('http://127.0.0.1:18900/v1/chat/completions', data=b,
        headers={'Content-Type':'application/json','Authorization':f'Bearer {KEY}'})
    try:
        json.load(urllib.request.urlopen(r, timeout=20)); return (m, 'OK')
    except urllib.error.HTTPError as e:
        t = e.read().decode('utf8','ignore')
        return (m, 'OC-LIMIT' if 'OpenCode free quota' in t else ('KILO-LIMIT' if 'Sign up for free' in t else f'HTTP{e.code}'))
    except Exception as e: return (m, 'ERR')
with ThreadPoolExecutor(max_workers=14) as ex:
    for m, st in ex.map(probe, mem): print(f'  {st:11} {m}')
PY

# ③ 救援通道状态
curl -s http://127.0.0.1:11435/health | python3 -c "import sys,json;print(json.load(sys.stdin)['rescue'])"
```

**判读口径**：
| `/health` 的 lanes | 含义 | 正确行为 |
|---|---|---|
| 两条都 `closed` | 免费池整段耗尽（上游硬限制，不是 bug） | 熔断跳过 + 救援通道出字，**不应报错** |
| 仅 OpenCode `closed` | Kilo 还有额度 | Kilo 成员接住，**不应报错** |
| 都 `open` 却仍 429 | 桥没生效 / 跑的是旧代码 | 按下方“修复”升级并重启 |

**v3 已落地的处置**（`ollama-bridge.mjs`）：
1. `classify()` 解析 `retry after <ISO>` 并判定通道 → `closeLane()` 按恢复时间关闸，关闸期间直接跳过。
2. `chatWithFallback()` 对 `combo:*` 做**成员级直连轮询**，只打开闸通道；一条通道判死后本轮剩余同通道成员一并跳过。
3. 免费池全不可用 → `tryRescue()` 降级到 `~/.our-free-model/rescue-providers.json` 的外部直连（顺序即优先级：**agnes → sensenova → glm-4-flash**），流式非流式都支持。
4. 全员失败 → `quotaExhaustedResponse()` 返回中文可读 429（含各通道恢复时间 + `lastUpstream` 现场）。

**想彻底摆脱这条错误**，只有两条路（按可行性排序）：
- 给 standalone 配**出口代理**（`settings.json` 的 `freeLane.proxyUrl`，或在 standalone UI 里配 egress），换一个 egress IP 就等于重置 OpenCode 的免费窗口额度；
- 或者让它自动降级到救援通道（已实现），把"报错"变成"慢一点但能出字"。



### 场景 F：结果输出不完整 / 回复写到一半就停

**现象**：回复在中途断掉（甚至断在 JSON、代码块或工具参数中间），前面内容正常，没有任何报错。

**原因（按概率排序，都已实测）**：
1. **救援通道选错了**——救援链首选 `glm-4-flash` 时，它只有 ~18 tok/s（实测输出 800 行要 118 秒），长回复还没写完就超过客户端等待上限；且它单次上限小，会直接 `finish_reason=length` 截断，甚至对超长请求返回 HTTP 500。
2. **`finish_reason=length`**——提供方的单次 completion 上限到了，桥若原样返回就是半截内容。
3. 客户端自己设了 `max_tokens` 且较小（这种情况属预期，不是 bug）。

**确诊（两分钟）**：
```bash
# ① 当前救援顺序（慢的排前面就会拖出截断）
python3 -c "import json,os;print([p['id'] for p in json.load(open(os.path.expanduser('~/.our-free-model/rescue-providers.json')))['providers']])"

# ② 开诊断日志，看每次尝试的通道/状态/是否截断（改完需重启桥）
#    launchctl setenv OFM_DEBUG_CHAT 1  然后 kickstart 桥，日志在 $HOME/.our-free-model/logs/bridge.log
#    输出形如：[chat] 救援 sensenova-6.8-flash-lite stream=false finish=stop chars=3594 34700ms

# ③ 直测单条救援通道的产出上限与速度（把 ID 换掉即可）
python3 - <<'PY'
import json, os, time, urllib.request
cfg = json.load(open(os.path.expanduser('~/.our-free-model/rescue-providers.json')))
p = cfg['providers'][0]
body = json.dumps({"model": p['model'], "max_tokens": 8192,
  "messages":[{"role":"user","content":"请从 1 数到 800，每行一个数字，不要任何其它文字。"}]}).encode()
r = urllib.request.Request(p['baseUrl']+'/chat/completions', data=body,
  headers={'Content-Type':'application/json','Authorization':'Bearer '+p['apiKey']})
t=time.time(); j = json.load(urllib.request.urlopen(r, timeout=300)); ch=j['choices'][0]
c = ch['message'].get('content') or ''
n = len([x for x in c.splitlines() if x.strip().isdigit()])
print(f"{p['id']}: finish={ch.get('finish_reason')} 行数={n}/800 用时={time.time()-t:.1f}s")
PY
```

**修复（v3 已内置）**：
- 救援顺序：**2026-11-14 用户指定为 `agnes-2.5-flash` → `sensenova-6.8-flash-lite` → `glm-4-flash`**（改顺序只改 `rescue-providers.json` 的 `providers` 数组，桥热加载不用重启；`glm-4-flash` 固定排最后）。
- 桥对救援返回的 `finish_reason=length` **判定为不完整，自动换下一个通道重试**；全部截断才返回最长的一份并带 `X-OFM-Truncated: 1`。
- 效果实测：600 行长输出 15.7 秒完整出字（改造前走 glm 要 36–118 秒且会被截断）。

**已知边界**：流式已经发出的内容无法回收；如果两条通道都在中途截断，桥只能在**下一次请求**换更优通道，不会重拼已发出去的文字。

## 修复：桥层 v3 内核（通道熔断 + 成员直连 + 外部救援）

> 完整实现见 `src/ollama-bridge.mjs`；历史备份文件未纳入本仓库。下面只列骨架与关键约束。

```js
// 1) 通道归属 + 熔断表（持久化到 ~/.our-free-model/bridge-lanes.json，重启不丢）
const KILO_LANE_PREFIX = /^(kilo|nvidia|cohere|baidu|particle-ai|dots-studio|stealth|reflection|openrouter|…)\//i;
const laneOf = (m = '') => (KILO_LANE_PREFIX.test(m) ? 'kilo' : 'opencode');
const laneOpen = (lane) => { const s = laneState[lane]; return !s || !s.until || Date.now() >= s.until; };
function closeLane(lane, { until, reason }) { /* 有 retry-after 用它；没有则 1min→10min 指数退避 */ }

// 2) 失败分类：只有 429 才关整条通道；空正文/超时/5xx 只冷却单个成员
async function classify(resp) { /* 解析 retry after <ISO> + OpenCode / Sign-up 文案判定通道 */ }

// 3) 主调度：组合成员直连轮询；一条通道判死后，本轮同通道剩余成员直接跳过
async function chatWithFallback(payload, opts) {
  const cands = comboMembers(payload.model).filter(m => laneOpen(laneOf(m)) && !memberCooling(m));
  for (const m of cands) {
    const resp = await attempt(payload, { ...opts, model: m });
    if (!(await classify(resp)).retryable) return { resp, source: `member:${m}` };
    // 429 → closeLane + 本轮同通道跳过；其它 → 仅 coolMember 45s
  }
  return (await tryRescue(payload, opts)) || { resp: quotaExhaustedResponse(), source: 'none' };
}

// 4) 救援 + 错误透传
async function tryRescue()             // 外部直连（独立配额），支持 SSE，chunk 里 model 改回请求名
function relayError(res, st, text)     // 上游 error 体原样返回，杜绝 {"error":"{\"error\"… 双层转义
```

**关键设计约束（都踩过）**：
- 切不同模型**不要**加指数退避——不同模型配额独立，加退避只是白等（曾把单次请求拖到 60s+，WorkBuddy 直接卡死）。
- **不要靠文案匹配判断限流**，只认状态码；文案仅用于解析 `retry-after` 和判定通道。
- **整池耗尽时不要再盲试 9 个候选**：一遍试完要 8 秒，用户体感就是"崩了"。关闸 + 救援才是正解。
- 空正文是**成员级**问题，别因此关掉整条通道（否则一个推理型模型会连坐整段配额）。
- 改完必须重启：`launchctl kickstart -k gui/$(id -u)/com.ofm.ollama-bridge`，再 `curl /health` 看 `lanes`。
- 桥的 `/health` 必须暴露 `lanes` / `rescue`，否则下次排障只能靠猜。

## combo 配置要点（ofm-combos.mjs）

- **新建** combo：`save`，JSON 用 `{"name":"auto",...}`（不要带 `id`，服务端会生成 `combo:auto`）。带 id 会报"已有同名路由组"。
- **更新** combo：`batch`，JSON 里带 `id`（如 `combo:auto`）走更新路径。
- `strategy` 可选：`fallback`（顺序降级）/ `smart`（按额度择优）/ `round-robin` / `usage` / `pace`。
  - **总入口（combo:auto）推荐 `round-robin`**：`smart` 在没有配额读数时会退化成"永远先打第一个模型"，连续请求把单一通道（OpenCode）刷爆而频发 429；round-robin 每次从不同成员起步，把负载摊到双通道。
- 保存前先 `node ofm-combos.mjs get` 拿到现有全部，改完再 `batch` 写回，避免误删其他 combo。
- 建链时**必须混通道**：成员里既要有 OpenCode 通道模型，也要有 kilo 通道模型（`catalog.json` 的 `kiloRows` 里那些带 `nvidia/`、`kilo-`、`reflection/`、`openrouter/` 等前缀的），做双保险。

## 可观测性与运维（v4 · 2026-11-14）

- **`GET /metrics`**：累计指标——`requests/successes/failures/successRatePct/avgLatencyMs`、`sources`（谁出的字：member/rescue/none）、`emptyReplies`（空正文守卫命中数）、`truncations`（截断换道次数）、`laneCloses`（各通道熔断次数）。重启不丢，落盘在 `~/.our-free-model/bridge-metrics.json`。
- **`POST /admin/reset-lanes`**：一键解除全部通道熔断 + 成员/救援冷却（确认额度恢复后用，不用再改文件重启桥）。
- **退出落盘**：桥收到 SIGTERM/SIGINT（含 `launchctl kickstart -k`）会同步把熔断与指标写盘，重启不丢最后几百毫秒的状态。
- **长期健康判断口径**：`sources.rescue` 占比持续升高 → 免费池长期紧张，考虑配出口代理；`emptyReplies` 频繁 → 某推理型成员烧预算，考虑把它移出 combo；`successRatePct` < 95 → 按场景 A–F 排障。

## 密钥与配置安全（务必遵守）

- 含密钥文件权限一律 **600**（仅本人可读写）：`settings.json` / `rescue-providers.json` / `models.json`；`~/.our-free-model/` 目录 **700**。桥与导入脚本写盘时会自动 chmod 600。
- `examples/rescue-providers.example.json` 是**脱敏示例**，复制为 `rescue-providers.json` 后填真实密钥；真实文件**禁止提交 git、禁止分享**。
- 排障截图前先遮盖 `apiKey` 字段。

## Windows 部署（与 macOS 等价）

1. 安装 Node.js ≥ 18：`winget install OpenJS.NodeJS.LTS`。
2. 克隆本仓库并保留目录结构与 `~/.our-free-model/settings.json`（注意权限）。
3. 启动：`powershell -ExecutionPolicy Bypass -File start-bridge.ps1`（自动找 node + 版本护栏）。
4. 服务化（登录自启 + 崩溃自愈，对标 launchd KeepAlive）：`powershell -ExecutionPolicy Bypass -File install-bridge-service.ps1`；卸载加 `-Uninstall`。
5. 验证：`Invoke-RestMethod http://127.0.0.1:11435/health`。
- ps1 已带 UTF-8 BOM（Win PowerShell 5.1 需要），勿用 ANSI 编辑器改写。

## 验证口诀（完成即验证）

每改一步都要客观验证：
- 链路在线：`curl -s http://127.0.0.1:11435/health` → 200；两个端口 `lsof` 有监听。
- 熔断/救援是否生效：`curl -s http://127.0.0.1:11435/health | python3 -m json.tool` 看 `lanes`（`open`/`closed` + `resumeAt`）与 `rescue.providers`（`cooling`）。
- 整池耗尽演练：两条通道都 `closed` 时 stream 请求 `combo:auto`，应 **200 出字**（走救援通道，1s 左右），而不是 429。
- 多场景实操：跑 `src/healthcheck.mjs`（基础/写作/逻辑/代码/长文），全 5/5 出字才算通。
- 巡检状态：`python3 -c "import json,os;d=json.load(open(os.path.expanduser('~/.our-free-model/health.json')));print(d['overall'],{k:v['state'] for k,v in d['services'].items()})"`（换设备数据目录用 `OFM_HOME` 覆盖 `~`）。

## 环境坑（本机踩过）

- 本机 Bash 是 **zsh**：`for m in $var` 默认**不按空格分词**（bash 才分），循环模型列表要写成 zsh 数组 `models=(a b c)` 或 `for m in ${(z)var}`。
- 沙箱（WorkBuddy 内执行）有独立 PID 命名空间：`ps` 看不到宿主机进程、`launchctl list` 为空，但**共享网络**（curl localhost:11435/18900 可用）。所以：
  - 巡检/锁清理脚本（含 launchctl）**只能在真实 Mac 终端跑**，沙箱里 `launchctl load/bootstrap`、`crontab` 全被拒。
  - `service.lock` 的"pid 已死"判定在沙箱会误判（ps 看不到），别在沙箱里跑会删锁的脚本。
- 直连 standalone 18900 用 `forwardKey`；经桥 11435 用 `REPLACE_WITH_YOUR_FORWARD_KEY`（或 models.json 里 combo:auto 的 apiKey）。两者别混用，否则 401。

## 何时使用（触发词）

用户说："免费模型未知错误""总入口不出字""没额度""卡死""总入口失败""挑花眼""combo 降级""跨通道""健康检查""桥掉线""开机自启""模型列表排序""免费大模型"等，或要动 ofm-bridge / dsh-our-free-model / ~/.workbuddy/models.json 时，加载本技能。