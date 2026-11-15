#!/bin/bash
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
BRIDGE="http://127.0.0.1:11435"
KEY="${OFM_FORWARD_KEY:?请设置 OFM_FORWARD_KEY}"
echo "=== 拉取非combo模型清单并并发存活扫描 ==="
ids=$(curl -s -m 8 "$BRIDGE/v1/models" -H "Authorization: Bearer $KEY" | \
  python3 -c "import sys,json;print('\n'.join(m['id'] for m in json.load(sys.stdin)['data'] if not m['id'].startswith('combo:')))")
echo "$ids" | xargs -P 8 -I{} bash "$REPO_ROOT/platforms/macos/probe.sh" {} > /tmp/scan.txt 2>/dev/null
echo "=== 存活扫描结果（X=非200，可能废）==="
sort /tmp/scan.txt | awk '{if($1!="200")print "  X "$0; else print "  . "$0}'
echo "--- 统计 ---"
echo "  总数: $(wc -l < /tmp/scan.txt)  废: $(grep -c '^  X' /tmp/scan.txt)"
dead=$(sort /tmp/scan.txt | awk '$1!="200"{print $2; exit}')
if [ -n "$dead" ]; then
  echo
  echo "=== 降级复核：用 [$dead] 作 fallback 链头（它当前非200）==="
  python3 -c "import json;json.dump({'name':'zzz-test-failover','strategy':'fallback','stickyLimit':1,'enabled':True,'models':['$dead','deepseek-v4.1-flash-free','glm-5.3-flash-free']},open('/tmp/cf.json','w'))"
  node "$REPO_ROOT/src/ofm-combos.mjs" save /tmp/cf.json 2>&1 | tail -2
  resp=$(curl -s -m 45 -w "HTTPSTATUS:%{http_code}" "$BRIDGE/v1/chat/completions" -H "Content-Type: application/json" -H "Authorization: Bearer $KEY" -d '{"model":"combo:zzz-test-failover","messages":[{"role":"user","content":"只回答两个字：跳通"}],"max_tokens":16,"stream":false}' 2>/dev/null)
  body="${resp%HTTPSTATUS:*}"; st="${resp##*HTTPSTATUS:}"
  echo "  实测 HTTP=$st"
  echo "$body" | python3 -c "import sys,json;j=json.load(sys.stdin);c=j.get('choices') or [];print('  出字:',(c[0]['message']['content'].strip() if c else '无'),'| model:',j.get('model'))"
  node "$REPO_ROOT/src/ofm-combos.mjs" remove combo:zzz-test-failover 2>&1 | tail -1
else
  echo "=== 未找到废模型（全部200），降级复核无可用失败链头，机制以源码+历史实测为准 ==="
fi
