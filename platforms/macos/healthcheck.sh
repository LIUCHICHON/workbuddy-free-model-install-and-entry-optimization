#!/bin/bash
# ============================================================================
# OFM 链路自愈脚本 (healthcheck.sh)
# ----------------------------------------------------------------------------
# 职责：周期性检查 桥(11435) 与 独立服务(18900) 是否在位、是否真能服务；
#      发现掉线则自动拉起；发现 macOS 不回收的陈旧 service.lock 则先清理再拉起；
#      把健康状态与自愈动作写入 ~/.our-free-model/health.json 与 health.log。
#
# 由 LaunchAgent com.ofm.healthcheck 每 2 分钟调用一次（StartInterval=120）。
# 也可手动跑：bash healthcheck.sh
#
# 注意：macOS 自带 bash 为 3.2，不支持关联数组，故只用标量变量。
# ============================================================================

set -u

# ---- 路径与常量 ----
HOME_DIR="$HOME"
BRIDGE_PORT=11435
STANDALONE_PORT=18900
DATA_DIR="$HOME_DIR/.our-free-model"
LOCK_FILE="$DATA_DIR/service.lock"
STATUS_FILE="$DATA_DIR/health.json"
LOG_FILE="$DATA_DIR/health.log"
NOW_TS=$(date +%s)
NOW_STR=$(date '+%Y-%m-%d %H:%M:%S')

# ---- 状态变量（标量）----
BRIDGE_STATE="ok"
STANDALONE_STATE="ok"
COMBO_STATE="ok"
BRIDGE_DETAIL=""
STANDALONE_DETAIL=""
COMBO_DETAIL=""

# 从 WorkBuddy 自定义模型配置取桥的鉴权 key（与模型列表保持一致）
# 优先环境变量；否则从 WorkBuddy 模型表读取；都不行则明确报错，不内置任何 key
BRIDGE_KEY="${OFM_FORWARD_KEY:-$(python3 -c "import json;d=json.load(open('$HOME_DIR/.workbuddy/models.json'));print([m['apiKey'] for m in d if m['id']=='combo:auto'][0])" 2>/dev/null || true)}"
if [ -z "$BRIDGE_KEY" ]; then
  echo "[x] 无法取得桥鉴权 key：请设置 OFM_FORWARD_KEY，或确认 ~/.workbuddy/models.json 里有 combo:auto。" >&2
  exit 1
fi

# ---- 工具函数 ----
log() {
  echo "[$NOW_STR] $*" | tee -a "$LOG_FILE"
}

# 端口是否被监听
port_listening() {
  local p="$1"
  [ -n "$(lsof -nP -iTCP:$p -sTCP:LISTEN -t 2>/dev/null | head -1)" ]
}

# 通过 HTTP 判断服务是否真能响应（不只是端口 listening）
http_ok() {
  local url="$1"; local code
  code=$(curl -s -m 6 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)
  [ "$code" = "200" ] || [ "$code" = "401" ] || [ "$code" = "403" ]
}

# 进程是否存活
pid_alive() {
  local pid="$1"
  [ -n "$pid" ] && ps -p "$pid" >/dev/null 2>&1
}

# launchctl 拉起某服务
kick() {
  local label="$1"
  launchctl kickstart -k "gui/$(id -u)/$label" 2>&1 | tee -a "$LOG_FILE"
}

# 探活总入口 combo:auto：发一个极小请求，确认整条免费通道还能出字。
# 返回 OK / EMPTY（空响应，可能所有模型额度耗尽或卡死）/ ERROR（明显报错）
combo_probe() {
  local key="$1"; local resp
  resp=$(curl -s -m 45 "http://127.0.0.1:$BRIDGE_PORT/v1/chat/completions" \
    -H "Content-Type: application/json" -H "Authorization: Bearer $key" \
    -d '{"model":"combo:auto","messages":[{"role":"user","content":"回复一个字：好"}],"max_tokens":8,"stream":false}' 2>/dev/null)
  python3 - "$resp" <<'PY'
import json,sys
try:
    j=json.loads(sys.argv[1])
except Exception:
    print("ERROR"); sys.exit(0)
if isinstance(j,dict) and "error" in j:
    print("ERROR"); sys.exit(0)
try:
    c=j["choices"][0]["message"]["content"].strip()
    print("OK" if c else "EMPTY")
except Exception:
    print("ERROR")
PY
}

# ============================================================================
# 1) 独立服务 standalone (18900)
# ============================================================================
if ! port_listening "$STANDALONE_PORT"; then
  STANDALONE_STATE="restart"
  STANDALONE_DETAIL="端口 $STANDALONE_PORT 未监听"
  log "standalone 未监听，进入自愈流程"

  # 陈旧锁检测：lock 里记录的 pid 已死，且端口无人占用 -> 锁是垃圾，清掉
  if [ -f "$LOCK_FILE" ]; then
    LOCK_PID=$(python3 -c "import json,sys;d=json.load(open('$LOCK_FILE'));print(d.get('pid',''))" 2>/dev/null || echo "")
    if ! pid_alive "$LOCK_PID"; then
      log "发现陈旧 service.lock (记录 pid=$LOCK_PID 已死)，删除之"
      rm -f "$LOCK_FILE"
      STANDALONE_DETAIL="$STANDALONE_DETAIL; 清理陈旧锁 pid=$LOCK_PID"
    else
      log "service.lock 指向存活进程 pid=$LOCK_PID，疑似真实冲突，不强行删除"
      STANDALONE_DETAIL="$STANDALONE_DETAIL; 锁指向存活pid=$LOCK_PID(未动)"
    fi
  fi

  # 拉起
  log "kickstart com.ofm.standalone"
  kick "com.ofm.standalone"
  # 等待最多 15s 监听
  for i in $(seq 1 15); do sleep 1; if port_listening "$STANDALONE_PORT"; then break; fi; done
fi

# 二次确认 standalone 是否真的活了（端口 + HTTP）
if port_listening "$STANDALONE_PORT"; then
  if http_ok "http://127.0.0.1:$STANDALONE_PORT/v1/models"; then
    [ "$STANDALONE_STATE" = "restart" ] && log "standalone 已恢复并响应 HTTP 200"
    STANDALONE_STATE="ok"
  else
    STANDALONE_STATE="degraded"
    STANDALONE_DETAIL="$STANDALONE_DETAIL; 端口在但 HTTP 无响应"
    log "standalone 端口在但 HTTP 无 2xx 响应"
  fi
else
  STANDALONE_STATE="down"
  STANDALONE_DETAIL="$STANDALONE_DETAIL; 拉起后仍无监听"
  log "standalone 拉起后仍无监听，需人工排查"
fi

# ============================================================================
# 2) 桥 bridge (11435)
# ============================================================================
if ! port_listening "$BRIDGE_PORT"; then
  BRIDGE_STATE="restart"
  BRIDGE_DETAIL="端口 $BRIDGE_PORT 未监听"
  log "bridge 未监听，kickstart com.ofm.ollama-bridge"
  kick "com.ofm.ollama-bridge"
  for i in $(seq 1 15); do sleep 1; if port_listening "$BRIDGE_PORT"; then break; fi; done
fi

if port_listening "$BRIDGE_PORT"; then
  if http_ok "http://127.0.0.1:$BRIDGE_PORT/health"; then
    [ "$BRIDGE_STATE" = "restart" ] && log "bridge 已恢复并响应"
    BRIDGE_STATE="ok"
  else
    BRIDGE_STATE="degraded"
    BRIDGE_DETAIL="$BRIDGE_DETAIL; 端口在但 HTTP 无响应"
    log "bridge 端口在但 HTTP 无 2xx 响应"
  fi
else
  BRIDGE_STATE="down"
  BRIDGE_DETAIL="$BRIDGE_DETAIL; 拉起后仍无监听"
  log "bridge 拉起后仍无监听，需人工排查"
fi

# ============================================================================
# 2.5) 总入口 combo:auto 探活（防止“所有免费模型都挂了却在 WorkBuddy 里只看到未知错误”）
# ============================================================================
if port_listening "$BRIDGE_PORT"; then
  log "探测总入口 combo:auto ..."
  PR=$(combo_probe "$BRIDGE_KEY")
  if [ "$PR" = "OK" ]; then
    log "总入口 combo:auto 正常出字"
    COMBO_STATE="ok"
  elif [ "$PR" = "EMPTY" ]; then
    COMBO_STATE="degraded"
    COMBO_DETAIL="总入口返回空响应（所有免费模型可能均已耗尽额度或卡死）"
    log "⚠️ 总入口返回空响应，免费通道可能已不可用"
  else
    COMBO_STATE="down"
    COMBO_DETAIL="总入口返回错误（所有免费模型均不可用，需切换付费模型或等待额度恢复）"
    log "❌ 总入口返回错误，整条免费通道可能已不可用"
  fi
else
  COMBO_STATE="down"
  COMBO_DETAIL="bridge 未监听，无法探测总入口"
fi

# ============================================================================
# 3) 写入健康状态 JSON
# ============================================================================
OVERALL="healthy"
if [ "$STANDALONE_STATE" = "down" ] || [ "$BRIDGE_STATE" = "down" ] || [ "$COMBO_STATE" = "down" ]; then
  OVERALL="critical"
elif [ "$STANDALONE_STATE" = "degraded" ] || [ "$BRIDGE_STATE" = "degraded" ] || [ "$COMBO_STATE" = "degraded" ] || [ "$STANDALONE_STATE" = "restart" ] || [ "$BRIDGE_STATE" = "restart" ]; then
  OVERALL="recovered"
fi

python3 - "$OVERALL" "$BRIDGE_STATE" "$STANDALONE_STATE" "$COMBO_STATE" "$BRIDGE_DETAIL" "$STANDALONE_DETAIL" "$COMBO_DETAIL" <<'PY'
import json,sys,os,time,datetime
overall,bridge,standalone,combo,bridge_d,standalone_d,combo_d = sys.argv[1:8]
now=int(time.time())
status={
  "overall":overall,
  "checked_at":now,
  "checked_at_str":datetime.datetime.fromtimestamp(now).strftime('%Y-%m-%d %H:%M:%S'),
  "services":{
    "bridge_11435":  {"state":bridge,  "detail":bridge_d},
    "standalone_18900":{"state":standalone,"detail":standalone_d},
    "combo_auto":  {"state":combo,  "detail":combo_d}
  }
}
path=os.path.expanduser('~/.our-free-model/health.json')
hist=[]
try:
    old=json.load(open(path))
    hist=old.get("history",[])
except Exception:
    pass
if bridge!="ok" or standalone!="ok" or combo!="ok":
    hist.append({"at":status["checked_at_str"],"overall":overall,"bridge":bridge,"standalone":standalone,"combo":combo})
hist=hist[-20:]
status["history"]=hist
open(path,'w').write(json.dumps(status,ensure_ascii=False,indent=2))
print("health.json written:",overall)
PY

log "本轮检查完成 overall=$OVERALL bridge=$BRIDGE_STATE standalone=$STANDALONE_STATE combo=$COMBO_STATE"
