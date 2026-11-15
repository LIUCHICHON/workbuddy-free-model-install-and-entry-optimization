#!/usr/bin/env node
/**
 * Ollama 协议桥 —— 把 dsh-our-free-model 的 OpenAI 兼容端点伪装成 Ollama 服务。
 *
 *   GET  /api/version, /api/tags, /api/ps   -> 合并本机 Ollama + 免费模型
 *   POST /api/chat, /api/generate, /api/show -> 免费模型走上游网关，本地模型转发给真 Ollama
 *   ANY  /api/pull,create,copy,delete,stop,embed,push,blobs/* -> 透传给真 Ollama（让管理命令在桥上也能用）
 *   ANY  /v1/*                              -> 原样透传给上游（OpenAI 兼容）
 *
 * 环境变量（都有默认值，通常无需改动）：
 *   OFM_BRIDGE_PORT     桥监听端口，默认 11435
 *   OFM_UPSTREAM        standalone 的 /v1 地址，默认 http://127.0.0.1:18900/v1
 *   OFM_LOCAL_OLLAMA    真 Ollama 地址，默认 http://127.0.0.1:11434
 *   OFM_SETTINGS        standalone 的 settings.json 路径
 */
import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, statSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 设备护栏：桥用到内置 fetch / ReadableStream / TransformStream（Node 18+）。
// 换到旧机器时给出明确提示，而不是抛一堆 undefined is not a function。
if (Number(process.versions.node.split('.')[0]) < 18) {
  console.error(`[×] 需要 Node.js >= 18（当前 v${process.versions.node}）。`);
  console.error('    升级：brew install node 或 https://nodejs.org 下载 LTS。');
  process.exit(1);
}

const HOST = process.env.OFM_BRIDGE_HOST || '127.0.0.1';
const PORT = Number(process.env.OFM_BRIDGE_PORT || 11435);
const UPSTREAM = (process.env.OFM_UPSTREAM || 'http://127.0.0.1:18900/v1').replace(/\/+$/, '');
const LOCAL = (process.env.OFM_LOCAL_OLLAMA || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const SETTINGS = process.env.OFM_SETTINGS || join(homedir(), '.our-free-model', 'settings.json');

/** 模型管理类端点一律交给真 Ollama，避免默认指向桥时 pull/rm/create 报 404 */
const LOCAL_MANAGE = new Set([
  '/api/pull', '/api/push', '/api/create', '/api/copy',
  '/api/delete', '/api/stop', '/api/embed',
]);

function apiKey() {
  try {
    return JSON.parse(readFileSync(SETTINGS, 'utf8')).forwardKey || '';
  } catch {
    return process.env.OFM_API_KEY || '';
  }
}
const authHeaders = (extra = {}) => ({
  Authorization: `Bearer ${apiKey()}`,
  'Content-Type': 'application/json',
  ...extra,
});
const isoNow = () => new Date().toISOString();
const json = (res, code, obj) => {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
};
const ndjson = (res, obj) => res.write(JSON.stringify(obj) + '\n');
// 诊断开关：OFM_DEBUG_CHAT=1 时打印每次尝试的通道/状态/截断情况（排「输出不完整」用）
const DEBUG_CHAT = process.env.OFM_DEBUG_CHAT === '1';
const dbg = (...a) => { if (DEBUG_CHAT) console.log('[chat]', ...a); };

// ——— 稳定性内核 v3：通道熔断 + 组合成员直连 + 外部救援 ———
// 真实故障链（2026-11-14 实测）：
//   · OpenCode 通道整段额度耗尽 → 429 "…retry after 2026-11-15T00:08:21.361Z…"
//   · 同一时刻 Kilo 通道也返回 429 "Sign up for free to continue… Or come back later."
//   · 免费池 0 可用。旧逻辑仍盲试 9 个候选 + 2 轮退避（约 8 秒），最后把上游原始 429
//     甩给客户端 —— 在 WorkBuddy 里就是反复弹「Quota exceeded: 429 …」，像总入口崩了。
//
// v3 做法：
//   1) 通道熔断：从 429 报文解析 retry-after / 判定通道，按恢复时间「关闸」；关闸期间直接跳过，
//      到期自动开闸，无需人工。Kilo 无明确时间时用指数退避（1min → 10min 封顶）。
//   2) 组合成员直连：combo:* 请求由桥自己按成员清单轮询直连，只打「开闸」通道的成员，
//      绕开上游内部的盲轮询，同时保证负载在多通道间分散。
//   3) 外部救援：免费池整段不可用时，自动降级到独立配额的外部直连（glm-4-flash / sensenova…），
//      流式与非流式都支持，客户端无感。
//   4) 只有全员失败才报错，且返回可读中文原因 + 各通道恢复时间，不再抛上游原始 JSON。
function isRetryableStatus(code) {
  return code === 429 || code === 502 || code === 503 || code === 504;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 跨通道兜底池：与 combo 成员互不重叠的独立模型，作为成员级重试的补充。
const CROSS_CHANNEL_POOL = [
  'kilo-auto/free',
  'nvidia/nemotron-3.5-lightning:free',
  'nvidia/nemotron-3.5-super-vl:free',
  'cohere/north-mini-code:free',
  'baidu/ernie-5.5-flash-preview:free',
  'dots-studio/dots-3-note-preview:free',
  'particle-ai/particle-1:free',
];

// ---------- 通道归属 ----------
// 带命名空间前缀的走 Kilo 聚合（nvidia/ cohere/ baidu/ kilo-auto/ …），
// 其余裸名走 OpenCode（deepseek-v4.1-flash-free、glm-5.3-flash-free …）。
const KILO_LANE_PREFIX = /^(kilo|nvidia|cohere|baidu|particle-ai|dots-studio|stealth|reflection|openrouter|google|meta|mistralai|qwen|moonshotai|z-ai|minimax|x-ai|openai)\//i;
const laneOf = (model = '') => (KILO_LANE_PREFIX.test(model) ? 'kilo' : 'opencode');
const LANE_LABEL = { opencode: 'OpenCode', kilo: 'Kilo', rescue: '外部救援' };

// ---------- 持久化状态 ----------
const DATA_DIR = join(homedir(), '.our-free-model');
const LANE_FILE = process.env.OFM_LANE_STATE || join(DATA_DIR, 'bridge-lanes.json');
const RESCUE_FILE = process.env.OFM_RESCUE_CONFIG || join(DATA_DIR, 'rescue-providers.json');
const METRICS_FILE = process.env.OFM_METRICS_FILE || join(DATA_DIR, 'bridge-metrics.json');

// ---------- 可观测性：累计指标（重启不丢，便于判断长期稳定性） ----------
// 口径：requests 只统计走了稳定性内核（chatWithFallback）的聊天请求；
//       sources 记录「最终是谁出的字」（member/model/rescue/none）。
let metrics = (() => {
  const base = {
    startedAt: new Date().toISOString(),
    requests: 0,
    successes: 0,
    failures: 0,            // 全员失败（返回了 ALL_FREE_LANES_EXHAUSTED）
    emptyReplies: 0,        // 空正文守卫命中次数（已自动换成员）
    truncations: 0,         // 救援通道截断换道次数
    sources: {},            // member:x / rescue:x / none 各多少次
    laneCloses: { opencode: 0, kilo: 0 },
    latencyMs: { count: 0, sum: 0, max: 0 },
    lastRequestAt: null,
  };
  try {
    const saved = JSON.parse(readFileSync(METRICS_FILE, 'utf8'));
    if (saved && typeof saved === 'object') return { ...base, ...saved, startedAt: new Date().toISOString() };
  } catch { /* 首次运行 */ }
  return base;
})();
let metricsSaveTimer = null;
function saveMetrics() {
  if (metricsSaveTimer) return;
  metricsSaveTimer = setTimeout(() => {
    metricsSaveTimer = null;
    flushMetrics();
  }, 500);
  if (metricsSaveTimer.unref) metricsSaveTimer.unref();
}
function metricsSnapshot() {
  const avg = metrics.latencyMs.count ? Math.round(metrics.latencyMs.sum / metrics.latencyMs.count) : 0;
  const successRate = metrics.requests ? Math.round((metrics.successes / metrics.requests) * 1000) / 10 : 100;
  return {
    ...metrics,
    successRatePct: successRate,
    avgLatencyMs: avg,
    uptimeSec: Math.round(process.uptime()),
  };
}

let laneState = (() => {
  try { return JSON.parse(readFileSync(LANE_FILE, 'utf8')) || {}; } catch { return {}; }
})();
let laneSaveTimer = null;
function saveLaneState() {
  if (laneSaveTimer) return;
  laneSaveTimer = setTimeout(() => {
    laneSaveTimer = null;
    flushLaneState();
  }, 200);
  if (laneSaveTimer.unref) laneSaveTimer.unref();
}
/** 同步落盘（退出时 / 管理端点用）。含密钥的配置与状态一律 600。 */
function flushLaneState() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(LANE_FILE, JSON.stringify(laneState, null, 2));
    try { chmodSync(LANE_FILE, 0o600); } catch { /* Windows 上无 chmod 语义，忽略 */ }
  } catch { /* 状态落盘失败不影响主流程 */ }
}
function flushMetrics() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(METRICS_FILE, JSON.stringify(metrics, null, 2));
    try { chmodSync(METRICS_FILE, 0o600); } catch { /* 忽略 */ }
  } catch { /* 指标落盘失败不影响主流程 */ }
}
const laneOpen = (lane) => {
  const s = laneState[lane];
  return !s || !s.until || Date.now() >= s.until;
};
function laneInfo(lane) {
  const s = laneState[lane];
  if (!s || !s.until || Date.now() >= s.until) return { state: 'open', streak: s?.streak || 0 };
  return {
    state: 'closed',
    resumeAt: new Date(s.until).toISOString(),
    secondsLeft: Math.max(1, Math.round((s.until - Date.now()) / 1000)),
    reason: s.reason || '',
    streak: s.streak || 0,
  };
}
/** 关闸：有明确恢复时间就按它，否则指数退避（Kilo 这类无 retry-after 的通道）。 */
function closeLane(lane, { until, reason } = {}) {
  const s = laneState[lane] || { streak: 0 };
  s.streak = (s.streak || 0) + 1;
  metrics.laneCloses[lane] = (metrics.laneCloses[lane] || 0) + 1;
  const backoff = Math.min(60_000 * 2 ** (s.streak - 1), 10 * 60_000);
  const target = until && until > Date.now() ? until : Date.now() + backoff;
  // 同一通道被反复触发时不要把恢复时间越推越远：取「较晚者」，但不超过 24h。
  s.until = Math.min(Math.max(target, s.until && s.until > Date.now() ? s.until : 0), Date.now() + 86_400_000);
  s.reason = reason || s.reason || '';
  s.at = new Date().toISOString();
  laneState[lane] = s;
  saveLaneState();
  saveMetrics();
}
function openLane(lane) {
  const s = laneState[lane];
  if (s && (s.streak || s.until)) {
    laneState[lane] = { streak: 0, until: 0, at: new Date().toISOString() };
    saveLaneState();
  }
}

// 成员级冷却：某模型 429 后短期不再踩它，避免每轮轮询都白撞一次。
const memberCool = new Map();
const memberCooling = (m) => (memberCool.get(m) || 0) > Date.now();
const coolMember = (m, ms) => memberCool.set(m, Date.now() + Math.max(5_000, ms));

// 组合成员清单（跟随 settings.json 变更自动刷新）
let comboCache = { mtime: 0, map: new Map() };
function loadCombos() {
  try {
    const st = statSync(SETTINGS);
    if (st.mtimeMs === comboCache.mtime) return comboCache.map;
    const s = JSON.parse(readFileSync(SETTINGS, 'utf8'));
    const map = new Map();
    for (const c of s.combos || []) map.set(c.id, (c.models || []).slice());
    comboCache = { mtime: st.mtimeMs, map };
    return map;
  } catch {
    return comboCache.map;
  }
}

// ---------- 外部救援通道 ----------
let rescueCache = { mtime: 0, cfg: null };
function rescueConfig() {
  try {
    const st = statSync(RESCUE_FILE);
    if (st.mtimeMs === rescueCache.mtime && rescueCache.cfg) return rescueCache.cfg;
    const raw = JSON.parse(readFileSync(RESCUE_FILE, 'utf8'));
    const cfg = {
      enabled: raw.enabled !== false,
      onlyForCombos: raw.onlyForCombos === true,
      timeoutMs: Number(raw.timeoutMs) || 60_000,
      providers: (raw.providers || [])
        .filter((p) => p && p.baseUrl && p.apiKey && p.model)
        .map((p) => ({
          ...p,
          baseUrl: String(p.baseUrl).replace(/\/chat\/completions\/?$/i, '').replace(/\/+$/, ''),
        })),
    };
    rescueCache = { mtime: st.mtimeMs, cfg };
    return cfg;
  } catch {
    return rescueCache.cfg || { enabled: false, onlyForCombos: false, timeoutMs: 60_000, providers: [] };
  }
}
const rescueCool = new Map();

/** 单次上游尝试（带超时；失败也返回 Response，便于统一分类）。 */
const ATTEMPT_TIMEOUT = Math.max(5_000, Number(process.env.OFM_ATTEMPT_TIMEOUT_MS) || 35_000);
async function attempt(payload, { signal, reqHeaders, model } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ATTEMPT_TIMEOUT);
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(`${UPSTREAM}/chat/completions`, {
      method: 'POST',
      headers: authHeaders(reqHeaders || {}),
      body: JSON.stringify(model ? { ...payload, model } : payload),
      signal: ctrl.signal,
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: { message: `上游单次尝试失败: ${e?.message || e}` } }), {
      status: 504,
      headers: { 'Content-Type': 'application/json' },
    });
  } finally {
    clearTimeout(timer);
    if (signal && signal.removeEventListener) signal.removeEventListener('abort', onAbort);
  }
}

/** 空正文守卫：HTTP 200 但 content 为空且 finish_reason=length/None（推理 token 烧光预算）。 */
async function isEmptyReply(resp) {
  if (!resp || !resp.ok) return false;
  const ct = resp.headers.get('content-type') || '';
  if (!ct.includes('application/json')) return false;
  try {
    const j = JSON.parse(await resp.clone().text());
    const ch = (j.choices || [])[0] || {};
    const c = ch.message ? ch.message.content : undefined;
    const empty = c == null || (typeof c === 'string' && c.trim() === '');
    return empty && (ch.finish_reason === 'length' || ch.finish_reason == null);
  } catch {
    return false;
  }
}

/** 分类一次失败：是否可重试、属于哪个通道、恢复时间、原因文案。 */
async function classify(resp) {
  const out = { retryable: false, lane: null, retryAt: 0, reason: '', empty: false };
  if (resp.ok) {
    out.empty = await isEmptyReply(resp);
    out.retryable = out.empty;
    if (out.empty) out.reason = '空正文（推理 token 烧光预算）';
    return out;
  }
  if (!isRetryableStatus(resp.status)) return out;
  out.retryable = true;
  let text = '';
  try { text = await resp.clone().text(); } catch { /* 忽略读取失败 */ }
  const m = /retry after ([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z)/i.exec(text);
  if (m) {
    const t = Date.parse(m[1]);
    if (Number.isFinite(t)) out.retryAt = t;
  }
  if (/OpenCode free quota/i.test(text)) out.lane = 'opencode';
  else if (/Sign up for free to continue/i.test(text)) out.lane = 'kilo';
  const mm = /"message"\s*:\s*"([^"]{0,200})/.exec(text);
  out.reason = (mm ? mm[1] : `HTTP ${resp.status}`).replace(/\\+"/g, '"');
  return out;
}

/** 全员失败时的可读错误（含各通道恢复时间），不再把上游原始 JSON 甩给用户。 */
function quotaExhaustedResponse(lastDetail) {
  const closed = [];
  for (const lane of ['opencode', 'kilo']) {
    const info = laneInfo(lane);
    if (info.state === 'closed') {
      const t = new Date(info.resumeAt);
      const hh = String(t.getHours()).padStart(2, '0');
      const mi = String(t.getMinutes()).padStart(2, '0');
      closed.push(`${LANE_LABEL[lane]} ${hh}:${mi} 恢复`);
    }
  }
  const head = closed.length
    ? `总入口暂时无可用通道（${closed.join('；')}）`
    : '总入口暂时无可用通道（上游免费模型整体限流）';
  return new Response(JSON.stringify({
    error: {
      message: `${head}，外部救援通道也未成功，请稍后重试。`,
      type: 'rate_limit_error',
      code: 'ALL_FREE_LANES_EXHAUSTED',
      lanes: { opencode: laneInfo('opencode'), kilo: laneInfo('kilo') },
      lastUpstream: lastDetail || null,
    },
  }), {
    status: 429,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '60' },
  });
}

// ---------- 外部救援实现 ----------
function withTimeout(signal, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  return { signal: ctrl.signal, done: () => { clearTimeout(timer); if (signal && signal.removeEventListener) signal.removeEventListener('abort', onAbort); } };
}

/** 救援返回流式时，把 chunk 里的 model 改回客户端请求的名字，避免界面上突然变成别的模型。 */
function rewriteModelStream(resp, wantedModel) {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = '';
  const ts = new TransformStream({
    transform(chunk, ctrl) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const t = line.trim();
        if (t.startsWith('data:')) {
          const payload = t.slice(5).trim();
          if (payload && payload !== '[DONE]') {
            try {
              const j = JSON.parse(payload);
              j.model = wantedModel;
              ctrl.enqueue(enc.encode(`data: ${JSON.stringify(j)}\n\n`));
              continue;
            } catch { /* 非 JSON 帧原样透传 */ }
          }
          ctrl.enqueue(enc.encode(`${t}\n\n`));
          continue;
        }
        ctrl.enqueue(enc.encode(`${line}\n`));
      }
    },
    flush(ctrl) { if (buf) ctrl.enqueue(enc.encode(buf)); },
  });
  return new Response(resp.body.pipeThrough(ts), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
}

/** 把一份完整 JSON 结果合成为 SSE 帧（客户端要流式、但提供方只给整包时用）。 */
function sseFramesFromJson(j, wantedModel) {
  const content = j?.choices?.[0]?.message?.content ?? '';
  const id = 'chatcmpl-rescue';
  const created = Math.floor(Date.now() / 1000);
  const frame = (delta, finish) => `data: ${JSON.stringify({
    id, object: 'chat.completion.chunk', created, model: wantedModel,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
  return frame({ role: 'assistant', content }, null) + frame({}, 'stop') + 'data: [DONE]\n\n';
}

async function tryRescue(payload, opts = {}) {
  const cfg = rescueConfig();
  if (!cfg.enabled || !cfg.providers.length) return null;
  if (cfg.onlyForCombos && !loadCombos().has(payload.model || '')) return null;
  const wantStream = payload.stream === true;
  let bestTruncated = null;   // 全都被截断时，留最长的那份兜底

  for (const p of cfg.providers) {
    if (opts.signal?.aborted) break;
    if ((rescueCool.get(p.id) || 0) > Date.now()) continue;
    const body = { ...payload, model: p.model, stream: wantStream };
    delete body.reasoning_effort;   // 外部通道多数不认这个参数
    const started = Date.now();
    const t = withTimeout(opts.signal, cfg.timeoutMs);
    try {
      const resp = await fetch(`${p.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}` },
        body: JSON.stringify(body),
        signal: t.signal,
      });
      if (resp.ok) {
        const ct = resp.headers.get('content-type') || '';
        if (wantStream && ct.includes('text/event-stream')) {
          dbg('救援流式', p.id, `${Date.now() - started}ms`);
          return { resp: rewriteModelStream(resp, payload.model), source: `rescue:${p.id}` };
        }
        const j = await resp.json().catch(() => null);
        if (!j) { rescueCool.set(p.id, Date.now() + 60_000); continue; }
        const ch = (j.choices || [])[0] || {};
        const content = ch.message?.content ?? '';
        dbg('救援', p.id, `stream=${wantStream} finish=${ch.finish_reason} chars=${String(content).length} ${Date.now() - started}ms`);
        // 「输出不完整」的关键判定：finish_reason=length 说明被提供方的单次上限截断，
        // 直接返回就是半截内容。换下一个（更快/上限更高的）通道重试，拿完整版。
        if (ch.finish_reason === 'length' && !ch.message?.tool_calls) {
          metrics.truncations += 1; saveMetrics();
          const cand = { j, len: String(content).length, id: p.id };
          if (!bestTruncated || cand.len > bestTruncated.len) bestTruncated = cand;
          continue;
        }
        j.model = payload.model;
        const out = wantStream ? sseFramesFromJson(j, payload.model) : JSON.stringify(j);
        return {
          resp: new Response(out, {
            status: 200,
            headers: { 'Content-Type': wantStream ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8' },
          }),
          source: `rescue:${p.id}`,
        };
      }
      dbg('救援失败', p.id, `HTTP ${resp.status} ${Date.now() - started}ms`);
      rescueCool.set(p.id, Date.now() + (resp.status === 429 ? 5 * 60_000 : 60_000));
      resp.body?.cancel?.().catch?.(() => {});
    } catch (e) {
      dbg('救援异常', p.id, String(e?.message || e).slice(0, 80));
      rescueCool.set(p.id, Date.now() + 60_000);
    } finally {
      t.done();
    }
  }

  if (bestTruncated) {
    dbg('全部被截断，返回最长的一份', bestTruncated.id, `chars=${bestTruncated.len}`);
    const j = bestTruncated.j;
    j.model = payload.model;
    const out = wantStream ? sseFramesFromJson(j, payload.model) : JSON.stringify(j);
    return {
      resp: new Response(out, {
        status: 200,
        headers: {
          'Content-Type': wantStream ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8',
          'X-OFM-Truncated': '1',
        },
      }),
      source: `rescue:${bestTruncated.id}(truncated)`,
    };
  }
  return null;
}

// ---------- 主调度 ----------
let rrCursor = 0;

/**
 * 返回 { resp, source }：
 *   source = 'member:<model>' 组合成员直连成功
 *          | 'model:<model>'  单模型直连成功
 *          | 'rescue:<id>'    外部救援成功
 *          | 'none'           全员失败（resp 为可读 429）
 */
async function chatWithFallback(payload, opts = {}) {
  const reqT0 = Date.now();
  metrics.requests += 1;
  metrics.lastRequestAt = new Date().toISOString();
  const finish = (result) => {
    const ms = Date.now() - reqT0;
    const ok = result?.resp?.ok === true;
    if (ok) metrics.successes += 1; else metrics.failures += 1;
    const src = result?.source || 'none';
    const key = src.split(':')[0];
    metrics.sources[key] = (metrics.sources[key] || 0) + 1;
    metrics.latencyMs.count += 1;
    metrics.latencyMs.sum += ms;
    if (ms > metrics.latencyMs.max) metrics.latencyMs.max = ms;
    saveMetrics();
    return result;
  };
  const { signal } = opts;
  const wanted = payload.model || '';
  const combos = loadCombos();
  const isCombo = combos.has(wanted);

  // 候选清单：只保留「通道开闸 + 成员不在冷却」的；combo 用轮询起点保证负载分散。
  let candidates = [];
  if (isCombo) {
    const members = combos.get(wanted) || [];
    const live = members.filter((m) => laneOpen(laneOf(m)) && !memberCooling(m));
    if (live.length > 1) {
      const k = rrCursor++ % live.length;
      candidates = [...live.slice(k), ...live.slice(0, k)];
    } else {
      candidates = live;
    }
  } else {
    candidates = [wanted];
    for (const m of CROSS_CHANNEL_POOL) {
      if (m !== wanted && laneOpen(laneOf(m)) && !memberCooling(m)) candidates.push(m);
    }
  }

  let lastDetail = null;
  const closedNow = new Set();   // 本轮已判定关闸的通道，后面的同通道成员直接跳过（冷启动由 14 次尝试降到 2 次）

  for (const m of candidates) {
    if (signal?.aborted) break;
    const guessLane = laneOf(m);
    if (closedNow.has(guessLane)) continue;
    const t0 = Date.now();
    const resp = await attempt(payload, { ...opts, model: m });
    const cls = await classify(resp);
    dbg('成员尝试', m, `status=${resp.status} retryable=${cls.retryable}${cls.empty ? ' 空正文' : ''} ${Date.now() - t0}ms`);
    if (cls.empty) { metrics.emptyReplies += 1; saveMetrics(); }
    if (!cls.retryable) {
      openLane(laneOf(m));
      memberCool.delete(m);
      return finish({ resp, source: `${isCombo ? 'member' : 'model'}:${m}` });
    }
    lastDetail = { model: m, status: resp.status, reason: cls.reason };
    // 只有 429 代表「通道级额度耗尽」；空正文/超时/5xx 是成员级问题，只冷却该成员，不关整条通道。
    const lane = cls.lane || guessLane;
    if (resp.status === 429) {
      closedNow.add(lane);
      closeLane(lane, { until: cls.retryAt, reason: cls.reason });
    }
    coolMember(m, cls.retryAt ? Math.max(5_000, cls.retryAt - Date.now()) : 45_000);
    resp.body?.cancel?.().catch?.(() => {});
  }

  // 免费池整段不可用（或全部命中冷却）→ 外部独立配额救援，这是真正止血的一步。
  const rescued = await tryRescue(payload, opts);
  if (rescued) return finish(rescued);

  return finish({ resp: quotaExhaustedResponse(lastDetail), source: 'none' });
}

let cache = { ts: 0, ids: [] };
async function freeModels(force = false) {
  if (!force && cache.ids.length && Date.now() - cache.ts < 60_000) return cache.ids;
  try {
    const r = await fetch(`${UPSTREAM}/models`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await r.json();
    const ids = (body.data || []).map(x => x.id).filter(Boolean);
    if (ids.length) cache = { ts: Date.now(), ids };
  } catch { /* 保留上次清单，服务暂时不可用时不让客户端的模型列表变空 */ }
  return cache.ids;
}

/** Ollama CLI 会自动给裸模型名补 :latest，这里把它还原成上游的真实 id。 */
async function resolveFree(name) {
  if (!name) return null;
  const ids = await freeModels();
  if (ids.includes(name)) return name;
  if (name.endsWith(':latest') && ids.includes(name.slice(0, -7))) return name.slice(0, -7);
  return null;
}

async function localJson(path) {
  try {
    const r = await fetch(`${LOCAL}${path}`, { signal: AbortSignal.timeout(4_000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function proxyLocal(req, res, path, body) {
  try {
    const r = await fetch(`${LOCAL}${path}`, {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : JSON.stringify(body),
    });
    res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/json' });
    if (r.body) for await (const chunk of r.body) res.write(chunk);
    res.end();
  } catch (e) {
    json(res, 502, { error: `本地 Ollama 不可达: ${e.message}` });
  }
}

/** /api/blobs/* 上传的是原始二进制，不能走 JSON 重序列化 */
async function proxyRawLocal(req, res, path, rawBuf) {
  try {
    const r = await fetch(`${LOCAL}${path}`, {
      method: req.method,
      headers: { 'Content-Type': req.headers['content-type'] || 'application/octet-stream' },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : rawBuf,
    });
    res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/json' });
    if (r.body) {
      for await (const chunk of r.body) res.write(chunk);
    }
    res.end();
  } catch (e) {
    json(res, 502, { error: `本地 Ollama 不可达: ${e.message}` });
  }
}

/** 错误透传：上游/内核已经是 OpenAI 形状的 error 体时原样返回，不再二次包装。
 *  旧实现会把 `{"error":{"message":...}}` 再塞进 `{"error": "<字符串>"}`，
 *  客户端看到的就是 `Quota exceeded: 429 {"error":"{\"error\":{...` 这种双层转义乱码。 */
function relayError(res, status, text) {
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* 非 JSON，走兜底包装 */ }
  if (parsed && typeof parsed === 'object' && parsed.error !== undefined) {
    const buf = Buffer.from(JSON.stringify(parsed));
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
    res.end(buf);
    return;
  }
  json(res, status, { error: text.slice(0, 800) || `上游 HTTP ${status}` });
}

/** /v1/* 透传（含 SSE 流式）；对通道级 429 自动切换 kilo 通道重发，避免总入口整体失败 */
async function proxyOpenAI(req, res, path, raw) {
  let bodyObj = null;
  try { bodyObj = JSON.parse(raw.toString('utf8')); } catch { /* 非 JSON（如 GET）直接透传 */ }
  let up;
  try {
    up = bodyObj
      ? (await chatWithFallback(bodyObj, { reqHeaders: req.headers['content-type'] ? { 'Content-Type': req.headers['content-type'] } : {} })).resp
      : await fetch(`${UPSTREAM}${path}`, {
          method: req.method,
          headers: authHeaders(req.headers['content-type'] ? { 'Content-Type': req.headers['content-type'] } : {}),
          body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw,
        });
  } catch (e) {
    json(res, 502, { error: `上游服务不可达: ${e.message}` });
    return;
  }
  if (up.ok) {
    res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/json' });
    if (up.body) for await (const chunk of up.body) res.write(chunk);
    res.end();
    return;
  }
  const text = await up.text().catch(() => '');
  relayError(res, up.status, text);
}

function toMessages(body) {
  const out = [];
  if (body.system) out.push({ role: 'system', content: String(body.system) });
  for (const m of body.messages || []) {
    let content = m.content;
    if (Array.isArray(content)) content = content.map(p => p.text || '').join('');
    if (content == null) content = '';
    out.push({ role: m.role === 'assistant' ? 'assistant' : m.role, content: String(content) });
  }
  if (!out.length && body.prompt) out.push({ role: 'user', content: String(body.prompt) });
  return out;
}

function optionsToParams(body) {
  const o = body.options || {};
  const p = {};
  if (Number.isFinite(o.temperature)) p.temperature = o.temperature;
  if (Number.isFinite(o.top_p)) p.top_p = o.top_p;
  if (Number.isFinite(o.num_predict)) p.max_tokens = o.num_predict;
  if (Number.isFinite(o.stop)) p.stop = o.stop;
  if (Array.isArray(o.stop) && o.stop.length) p.stop = o.stop;
  return p;
}

const usageFields = (u, started) => ({
  total_duration: Date.now() - started,
  load_duration: 0,
  prompt_eval_count: u?.prompt_tokens ?? 0,
  prompt_eval_duration: 0,
  eval_count: u?.completion_tokens ?? 0,
  eval_duration: Date.now() - started,
});

async function generateFree(req, res, body, model, isGenerate) {
  const started = Date.now();
  const stream = body.stream !== false;
  const payload = {
    model,
    messages: toMessages(body),
    stream,
    ...optionsToParams(body),
  };
  const controller = new AbortController();
  res.on('close', () => controller.abort());

  let up;
  try {
    up = (await chatWithFallback(payload, { signal: controller.signal })).resp;
  } catch (e) {
    json(res, 502, { error: `上游服务不可达: ${e.message}` });
    return;
  }
  if (!up.ok) {
    const text = await up.text().catch(() => '');
    relayError(res, up.status, text);
    return;
  }

  if (!stream) {
    const data = await up.json().catch(() => ({}));
    const content = data?.choices?.[0]?.message?.content ?? '';
    return json(res, 200, {
      model,
      created_at: isoNow(),
      ...(isGenerate
        ? { response: content }
        : { message: { role: 'assistant', content } }),
      done: true,
      done_reason: 'stop',
      ...usageFields(data?.usage, started),
    });
  }

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' });
  let buffer = '';
  let usage = null;
  const emit = (content, thinking) => {
    const message = { role: 'assistant', content };
    if (thinking) message.thinking = thinking;
    ndjson(res, {
      model,
      created_at: isoNow(),
      ...(isGenerate ? { response: content } : { message }),
      done: false,
    });
  };
  try {
    for await (const chunk of up.body) {
      buffer += Buffer.from(chunk).toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue; // 心跳注释帧 / event 行
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let evt;
        try { evt = JSON.parse(data); } catch { continue; }
        if (evt.usage) usage = evt.usage;
        const d = evt.choices?.[0]?.delta || {};
        const content = d.content || '';
        const thinking = d.reasoning_content || d.reasoning || d.reasoning_text || '';
        if (content || thinking) emit(content, thinking);
      }
    }
  } catch (e) {
    if (!controller.signal.aborted) ndjson(res, { model, created_at: isoNow(), message: { role: 'assistant', content: `\n[桥接中断: ${e.message}]` }, done: false });
  }
  ndjson(res, {
    model,
    created_at: isoNow(),
    ...(isGenerate ? { response: '' } : { message: { role: 'assistant', content: '' } }),
    done: true,
    done_reason: 'stop',
    ...usageFields(usage, started),
  });
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  // 允许本地网页（file:// 或 WorkBuddy 预览面板）直接调用桥，无需额外代理服务。
  // 只监听 127.0.0.1，不对外暴露。
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Chromium 新版对「网页 → 127.0.0.1」会发 Private Network Access 预检，缺此头会被拦。
  res.setHeader('Access-Control-Allow-Private-Network', 'true');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Private-Network': 'true',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Max-Age': '600',
    });
    return res.end();
  }

  if (path.startsWith('/v1/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return proxyOpenAI(req, res, path.slice(3) + url.search, Buffer.concat(chunks));
  }

  const chunks = [];
  if (!['GET', 'HEAD'].includes(req.method)) {
    for await (const c of req) chunks.push(c);
  }
  const rawBuf = Buffer.concat(chunks);
  let body = {};
  try { body = rawBuf.length ? JSON.parse(rawBuf.toString('utf8')) : {}; } catch { /* 二进制上传，body 保持空 */ }

  try {
    if (path === '/' || path === '/health') {
      const rc = rescueConfig();
      return json(res, 200, {
        status: 'ok',
        upstream: UPSTREAM,
        localOllama: LOCAL,
        models: (await freeModels()).length,
        lanes: { opencode: laneInfo('opencode'), kilo: laneInfo('kilo') },
        rescue: {
          enabled: rc.enabled,
          providers: rc.providers.map((p) => ({
            id: p.id,
            cooling: (rescueCool.get(p.id) || 0) > Date.now(),
          })),
        },
        metrics: metricsSnapshot(),
      });
    }
    // /metrics：可观测性端点（JSON 累计指标 + 当前通道状态）
    if (path === '/metrics') {
      return json(res, 200, {
        metrics: metricsSnapshot(),
        lanes: { opencode: laneInfo('opencode'), kilo: laneInfo('kilo') },
        rescueCooling: [...rescueCool.entries()]
          .filter(([, until]) => until > Date.now())
          .map(([id, until]) => ({ id, until: new Date(until).toISOString() })),
      });
    }
    // POST /admin/reset-lanes：手动解除全部通道熔断与成员/救援冷却（运维操作用）
    if (path === '/admin/reset-lanes' && req.method === 'POST') {
      laneState = {};
      memberCool.clear();
      rescueCool.clear();
      flushLaneState();
      return json(res, 200, { ok: true, lanes: { opencode: laneInfo('opencode'), kilo: laneInfo('kilo') } });
    }
    if (path === '/api/version') {
      const v = await localJson('/api/version');
      return json(res, 200, v || { version: '0.40.16' });
    }
    if (path === '/api/tags') {
      const free = await freeModels();
      const local = (await localJson('/api/tags'))?.models || [];
      const freeRows = free.map(id => ({
        name: id,
        model: id,
        modified_at: isoNow(),
        size: 0,
        digest: `ofm-${id.replace(/[^a-z0-9]/gi, '').slice(0, 24)}`,
        details: { parent_model: '', format: 'api', family: 'our-free-model', families: ['our-free-model'], parameter_size: 'cloud', quantization_level: 'N/A' },
      }));
      const localNames = new Set(local.map(m => m.name));
      return json(res, 200, { models: [...local, ...freeRows.filter(m => !localNames.has(m.name))] });
    }
    if (path === '/api/ps') return proxyLocal(req, res, path, body);
    if (path === '/api/show') {
      const model = await resolveFree(body.name || body.model);
      if (!model) return proxyLocal(req, res, path, body);
      return json(res, 200, {
        license: 'MIT (dsh-our-free-model) / 上游模型服务条款',
        modelfile: `FROM ${model}\n# 由 Our Free Model 网关提供，非本地权重`,
        parameters: 'num_ctx 131072',
        template: '{{ .Prompt }}',
        details: { parent_model: '', format: 'api', family: model, families: [model], parameter_size: 'cloud', quantization_level: 'N/A' },
        model_info: { 'general.architecture': 'api', 'general.name': model },
        capabilities: ['completion'],
      });
    }
    if (path === '/api/chat' || path === '/api/generate' || path === '/api/embeddings') {
      const model = await resolveFree(body.model || body.name);
      if (!model) {
        if (path === '/api/embeddings') return json(res, 404, { error: '该模型不支持 embeddings' });
        return proxyLocal(req, res, path, body);
      }
      return generateFree(req, res, body, model, path === '/api/generate');
    }
    if (path.startsWith('/api/blobs/')) return proxyRawLocal(req, res, path, rawBuf);
    if (LOCAL_MANAGE.has(path)) return proxyLocal(req, res, path, body);
    return json(res, 404, { error: `unknown endpoint: ${path}` });
  } catch (e) {
    return json(res, 500, { error: e.stack || String(e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[ofm-ollama-bridge] http://${HOST}:${PORT}  ->  ${UPSTREAM}  (本地模型转发 ${LOCAL})`);
});

// 退出前把防抖中的状态/指标同步落盘（launchctl kickstart -k 发的是 SIGTERM），
// 否则重启会丢掉最近几百毫秒的熔断与计数。
function flushAndExit() {
  flushLaneState();
  flushMetrics();
  process.exit(0);
}
process.on('SIGTERM', flushAndExit);
process.on('SIGINT', flushAndExit);
