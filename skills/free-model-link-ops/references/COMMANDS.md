# 排障命令速查

> 换设备时先 `export REPO_ROOT=<本仓库路径>`；示例 key 均已替换为占位符。
> 一次性实验脚本（combo-practice2.py 等）未纳入仓库，改用 `src/healthcheck.mjs --models` 巡检。

# 免费大模型链路 · 命令速查表

> 所有命令在本机已验证。**换设备时**：先设 `export REPO_ROOT=<本仓库路径>`（本机示例 `$REPO_ROOT`），下文命令里的该路径用 `$REPO_ROOT` 代替；数据目录用 `$HOME/.our-free-model`（或 `OFM_HOME`）代替；端口按设备实际 `settings.json` 的 `standalonePort` / 桥端口调整。

## 1. 链路在线检查

```bash
# 两个端口是否在监听
lsof -nP -iTCP:11435 -sTCP:LISTEN -t   # 桥
lsof -nP -iTCP:18900 -sTCP:LISTEN -t   # standalone
# 桥健康
curl -s -m 5 http://127.0.0.1:11435/health
# 当前 combo 清单
cd $REPO_ROOT
node ofm-combos.mjs get 2>/dev/null | sed -n '/^\[/,/^\]/p'
# health.json 状态
python3 -c "import json;d=json.load(open('$HOME/.our-free-model/health.json'));print(d['overall'],{k:v['state'] for k,v in d['services'].items()})"
```

## 2. 直测单个模型（判断是否通道级限额）

```bash
# 经桥（用 REPLACE_WITH_YOUR_FORWARD_KEY）
curl -s -m 30 http://127.0.0.1:11435/v1/chat/completions \
  -H "Content-Type: application/json" -H "Authorization: Bearer REPLACE_WITH_YOUR_FORWARD_KEY" \
  -d '{"model":"deepseek-v4.1-flash-free","messages":[{"role":"user","content":"hi"}],"max_tokens":5,"stream":false}'
```
- 429 + 文案含 `Free usage limit reached / OpenCode / Kilo and extension channels are unaffected` → 通道级限额。
- 200 → 单模型可用（或已被 smart 跨通道路由到 kilo，看响应里的 model 字段）。

## 3. 测总入口 combo:auto（stream，模拟 WorkBuddy）

```bash
curl -s -m 60 http://127.0.0.1:11435/v1/chat/completions \
  -H "Content-Type: application/json" -H "Authorization: Bearer REPLACE_WITH_YOUR_FORWARD_KEY" \
  -d '{"model":"combo:auto","messages":[{"role":"user","content":"只回答两个字：正常"}],"max_tokens":12,"stream":false}'
```
- 200 出字 → 修复生效（OpenCode 限额时桥自动切 kilo）。

## 4. 多场景实操（5/5 才算通）

```bash
node $REPO_ROOT/src/healthcheck.mjs --models
```

## 5. 重启桥 / standalone（改代码后必做）

```bash
# 重启桥（改了 ollama-bridge.mjs 必须）
kill -9 $(lsof -nP -iTCP:11435 -sTCP:LISTEN -t)   # KeepAlive 1 秒内拉起新代码
curl -s http://127.0.0.1:11435/health             # 验证 200

# 重启 standalone（若陈旧锁导致起不来，先清锁）
rm -f ~/.our-free-model/service.lock
launchctl kickstart -k gui/$(id -u)/com.ofm.standalone
```

## 6. 清陈旧 service.lock（standalone 起不来的元凶）

```bash
cat ~/.our-free-model/service.lock      # 看 pid
ps -p <pid>                             # 确认是否存活；已死则可删
rm -f ~/.our-free-model/service.lock
launchctl kickstart -k gui/$(id -u)/com.ofm.standalone
```

## 7. combo 增删改（ofm-combos.mjs）

```bash
cd $REPO_ROOT
# 读现有
node ofm-combos.mjs get
# 新建（name 不带 id）
node ofm-combos.mjs save /tmp/combo.json        # JSON: {"name":"xxx","strategy":"smart","stickyLimit":1,"enabled":true,"models":[...]}
# 批量更新（带 id）
node ofm-combos.mjs batch /tmp/all-combos.json  # JSON 数组，每项带 "id":"combo:xxx"
# 删除
node ofm-combos.mjs remove combo:xxx
```

## 8. 一键自查（查疑补缺）

```bash
bash $REPO_ROOT/platforms/macos/selfcheck.sh
```
- 并发扫描全部非 combo 单模型存活，自动用废模型作链头复验降级是否生效。

## 9. 启用定时巡检（真实 Mac 终端跑，沙箱跑不了）

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ofm.healthcheck.plist
launchctl print gui/$(id -u)/com.ofm.healthcheck   # 看 state=running
```
- 不跑也行：plist 已放 ~/Library/LaunchAgents/，下次登录/重启自动加载。
## 10. 空正文（content=null）回归验证

```bash
# 小预算连打 10 次，空正文应为 0（改造前约 1/6 会空）
python3 - <<'PY'
import json,urllib.request
U='http://127.0.0.1:11435/v1/chat/completions';K='REPLACE_WITH_YOUR_FORWARD_KEY'
empty=0
for i in range(10):
    b=json.dumps({"model":"combo:auto","messages":[{"role":"user","content":"回答：好"}],"max_tokens":24,"stream":False}).encode()
    r=urllib.request.Request(U,data=b,headers={'Content-Type':'application/json','Authorization':f'Bearer {K}'})
    j=json.load(urllib.request.urlopen(r,timeout=90))
    c=j['choices'][0]['message'].get('content')
    if not (c and c.strip()): empty+=1
print('空正文:',empty,'/10')
PY
```

## 11. 同步导入 WorkBuddy 模型表（合并 + 备份）

```bash
node "$HOME/.workbuddy/skills/free-model-entry-builder/src/setup-auto-entry.mjs" --wb --dry  # 先看计划
node "$HOME/.workbuddy/skills/free-model-entry-builder/src/setup-auto-entry.mjs" --wb        # 落盘（自动备份）
```
- 会先探测上游 `/v1/models`，重建桥内条目、保留外部直连（sensenova/glm/agnes），并备份 `models.json.bak-*`。

## 12. 通道熔断状态与解除

```bash
# 看哪条通道关闸、何时恢复、救援通道是否在冷却
curl -s http://127.0.0.1:11435/health | python3 -m json.tool

# 立刻解除全部熔断（比如确认额度已恢复，不想等到点）
python3 - <<'PY'
import json, os, time
p = os.path.expanduser('~/.our-free-model/bridge-lanes.json')
d = json.load(open(p))
for k in d: d[k] = {'streak': 0, 'until': 0, 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ')}
json.dump(d, open(p, 'w'), indent=2)
print('已清空熔断，重启桥生效:', p)
PY
launchctl kickstart -k gui/$(id -u)/com.ofm.ollama-bridge
```

## 13. 救援通道（整池耗尽时的最后一道）

```bash
# 看救援配置（由 setup-auto-entry.mjs --wb 自动维护）
cat ~/.our-free-model/rescue-providers.json | python3 -m json.tool

# 单独测某条救援通道是否可用
python3 - <<'PY'
import json, os, urllib.request, urllib.error
cfg = json.load(open(os.path.expanduser('~/.our-free-model/rescue-providers.json')))
for p in cfg['providers']:
    body = json.dumps({"model": p['model'], "messages":[{"role":"user","content":"说三个字"}], "max_tokens":16}).encode()
    r = urllib.request.Request(p['baseUrl'] + '/chat/completions', data=body,
        headers={'Content-Type':'application/json','Authorization':'Bearer ' + p['apiKey']})
    try:
        j = json.load(urllib.request.urlopen(r, timeout=30))
        print('✅', p['id'], repr((j['choices'][0]['message'].get('content') or '')[:20]))
    except urllib.error.HTTPError as e:
        print('❌', p['id'], 'HTTP', e.code, e.read()[:100].decode('utf8','ignore'))
    except Exception as e:
        print('❌', p['id'], str(e)[:70])
PY
```

- 救援通道都是**独立配额**的外部直连（agnes / sensenova / glm-4-flash），与 OpenCode/Kilo 互不影响。
- 当前顺序（用户指定 2026-11-14）：**agnes → sensenova → glm-4-flash**。`agnes-2.5-flash` 若未实名会立即 429（约 +0.2s 后自动跳过），实名后就是最快首选；`glm-4-flash` 固定排最后。

## 14. 输出被截断 / 救援通道速度实测

```bash
# 看救援顺序（慢的排前面会拖出"输出不完整"）
python3 -c "import json,os;print([p['id'] for p in json.load(open(os.path.expanduser('~/.our-free-model/rescue-providers.json')))['providers']])"

# 逐条量产出上限与速度（800 行数字，正常应 finish=stop 且 800/800）
python3 - <<'PY'
import json, os, time, urllib.request, urllib.error
cfg = json.load(open(os.path.expanduser('~/.our-free-model/rescue-providers.json')))
for p in cfg['providers']:
    body = json.dumps({"model": p['model'], "max_tokens": 8192,
      "messages":[{"role":"user","content":"请从 1 数到 800，每行一个数字，不要任何其它文字。"}]}).encode()
    r = urllib.request.Request(p['baseUrl']+'/chat/completions', data=body,
      headers={'Content-Type':'application/json','Authorization':'Bearer '+p['apiKey']})
    t = time.time()
    try:
        j = json.load(urllib.request.urlopen(r, timeout=300)); ch = j['choices'][0]
        c = ch['message'].get('content') or ''
        n = len([x for x in c.splitlines() if x.strip().isdigit()])
        print(f"  {p['id']:26} finish={str(ch.get('finish_reason')):5} 行数={n:>3}/800  {time.time()-t:6.1f}s")
    except urllib.error.HTTPError as e:
        print(f"  {p['id']:26} HTTP {e.code}  {time.time()-t:6.1f}s")
    except Exception as e:
        print(f"  {p['id']:26} ERR {str(e)[:50]}")
PY

# 开桥的诊断日志（每次尝试的通道/状态/截断都会打印）
launchctl setenv OFM_DEBUG_CHAT 1
launchctl kickstart -k gui/$(id -u)/com.ofm.ollama-bridge
tail -f $HOME/.our-free-model/logs/bridge.log   # 用完记得 launchctl unsetenv OFM_DEBUG_CHAT
```

- 参考基线（2026-11-14 实测）：sensenova ~100 tok/s、3594 tokens 正常；agnes 未实名时直接 429（提示实名认证），实名后速度更快、可出 6393 tokens；**glm-4-flash 仅 ~18 tok/s，长请求会 500/截断 → 只能排最后**。
- 桥遇到 `finish_reason=length` 会换下一条救援通道重试；全部截断才返回最长的一份（响应头 `X-OFM-Truncated: 1`）。

## 15. 指标与一键解除熔断

```bash
# 累计指标（重启不丢）
curl -s http://127.0.0.1:11435/metrics | python3 -m json.tool

# 一键解除全部熔断与冷却（确认额度恢复后）
curl -s -X POST http://127.0.0.1:11435/admin/reset-lanes

# 一键回归测试（17 项，受控假上游 + 真实环境冒烟）
node $REPO_ROOT/tests/run-regression.mjs
# 只跑受控部分：SKIP_REAL=1 node .../run-regression.mjs
```

- `sources.rescue` 占比持续升高 = 免费池长期紧张，考虑给 standalone 配出口代理。
- 退出码 0 = 全过；1 = 有失败项，按 R 编号定位。

## 16. 密钥文件权限巡检

```bash
ls -l ~/.our-free-model/settings.json ~/.our-free-model/rescue-providers.json ~/.workbuddy/models.json
# 应全部为 -rw-------（600）。不是则：
chmod 600 ~/.our-free-model/settings.json ~/.our-free-model/rescue-providers.json ~/.workbuddy/models.json
chmod 700 ~/.our-free-model
```
