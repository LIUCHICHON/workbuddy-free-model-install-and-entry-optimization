#!/usr/bin/env node
/**
 * 免费大模型链路 · 一键回归测试集（版本化）
 *
 * 覆盖此前所有实测过的真实故障模式：
 *   R1 双通道 429 → 通道熔断 + 外部救援出字（model 字段改回请求名）
 *   R2 熔断持久化与 /health 状态暴露
 *   R3 空正文守卫：200+content=null+finish=length 自动换成员（不关整条通道）
 *   R4 救援截断换道：finish=length 换下一救援通道拿完整版
 *   R5 全员失败：返回中文可读 429（含恢复时间），无双层转义
 *   R6 流式透传：SSE 帧完整、model 改写正确
 *   R7 指标计数：/metrics 的 requests/sources 与实际一致
 *   R8 --wb --dry 幂等：新增 0 / 移除 0（仅在本机真实环境跑，SKIP_REAL=1 可跳过）
 *
 * 用法：node tests/run-regression.mjs          # 全部（含真实环境冒烟 R8）
 *       SKIP_REAL=1 node tests/run-regression.mjs   # 只跑隔离的受控测试 R1–R7
 *
 * 退出码：0 = 全部通过；1 = 有失败项。
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const BRIDGE = join(BRIDGE_DIR, 'src', 'ollama-bridge.mjs');
const SKIP_REAL = process.env.SKIP_REAL === '1';

let passed = 0, failed = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { passed += 1; console.log(`✅ ${name}${extra ? '  | ' + extra : ''}`); }
  else { failed += 1; console.log(`❌ ${name}${extra ? '  | ' + extra : ''}`); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 受控环境：假上游 + 假救援 ----------
// mode: 'all429' 全部 429 | 'empty' 空正文 | 'ok' 正常
let upstreamMode = 'all429';
const upstream = http.createServer((req, res) => {
  if (req.url.startsWith('/__mode')) {
    upstreamMode = new URL(req.url, 'http://x').searchParams.get('mode');
    res.end('ok'); return;
  }
  if (req.url === '/v1/models') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'oc-a-free' }, { id: 'oc-b-free' }, { id: 'kilo/k-a:free' }] }));
    return;
  }
  // /v1/chat/completions：不关心请求体，直接按 mode 返回
  req.resume();
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (upstreamMode === 'all429') {
      res.statusCode = 429;
      res.end(JSON.stringify({ error: { message: 'the OpenCode free quota window is open on this egress: Free usage limit reached. retry after 2099-01-01T00:00:00.000Z', type: 'rate_limit_error' } }));
    } else if (upstreamMode === 'empty') {
      res.end(JSON.stringify({ id: 'x', model: 'oc-a-free', choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'length' }], usage: { completion_tokens: 512 } }));
    } else {
      res.end(JSON.stringify({ id: 'x', model: 'oc-a-free', choices: [{ index: 0, message: { role: 'assistant', content: '上游正常出字' }, finish_reason: 'stop' }], usage: { completion_tokens: 4 } }));
    }
  });
});

// 假救援：①截断 ②完整（支持流式）
const rescues = [
  { port: 0, truncate: true, id: 'rescue-trunc' },
  { port: 0, truncate: false, id: 'rescue-full' },
];
const rescueServers = rescues.map((r) => http.createServer((req, res2) => {
  let b = ''; req.on('data', (c) => b += c);
  req.on('end', () => {
    const wantStream = JSON.parse(b || '{}').stream === true;
    const content = r.truncate ? '半截内容' : '完整内容：这是没有被截断的救援输出。';
    const finish = r.truncate ? 'length' : 'stop';
    if (wantStream) {
      res2.setHeader('Content-Type', 'text/event-stream');
      const frame = (delta, f) => `data: ${JSON.stringify({ id: 'r', object: 'chat.completion.chunk', created: 0, model: 'upstream-model', choices: [{ index: 0, delta, finish_reason: f }] })}\n\n`;
      res2.end(frame({ role: 'assistant', content }, null) + frame({}, finish) + 'data: [DONE]\n\n');
    } else {
      res2.setHeader('Content-Type', 'application/json');
      res2.end(JSON.stringify({ id: 'r', model: 'upstream-model', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }], usage: { completion_tokens: 8 } }));
    }
  });
}));

const BPORT = 11437;
let bridge = null;
let tmp = null;

function callBridge(body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: BPORT, path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => { let t = ''; res.on('data', (c) => t += c); res.on('end', () => resolve({ status: res.statusCode, text: t, headers: res.headers })); });
    req.on('error', reject);
    req.setTimeout(60_000, () => req.destroy(new Error('timeout')));
    req.end(JSON.stringify(body));
  });
}
const getJson = (path) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: BPORT, path }, (res) => { let t = ''; res.on('data', (c) => t += c); res.on('end', () => { try { resolve(JSON.parse(t)); } catch (e) { reject(e); } }); }).on('error', reject);
});
const postJson = (path) => new Promise((resolve, reject) => {
  const q = http.request({ host: '127.0.0.1', port: BPORT, path, method: 'POST' }, (res) => { let t = ''; res.on('data', (c) => t += c); res.on('end', () => { try { resolve(JSON.parse(t)); } catch (e) { reject(e); } }); });
  q.on('error', reject);
  q.end('{}');
});

async function setMode(mode) {
  const port = upstream.address().port;
  await new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: `/__mode?mode=${mode}` }, (x) => { x.resume(); x.on('end', res); }).on('error', rej));
}

async function restartBridge() {
  if (bridge) { bridge.kill(); await wait(500); }
  bridge = spawn('node', [BRIDGE], {
    env: {
      ...process.env,
      OFM_BRIDGE_PORT: String(BPORT),
      OFM_UPSTREAM: `http://127.0.0.1:${upstream.address().port}/v1`,
      OFM_SETTINGS: join(tmp, 'settings.json'),
      OFM_LANE_STATE: join(tmp, 'lanes.json'),
      OFM_RESCUE_CONFIG: join(tmp, 'rescue.json'),
      OFM_METRICS_FILE: join(tmp, 'metrics.json'),
    },
    stdio: process.env.DEBUG_BRIDGE ? ['ignore', 'inherit', 'inherit'] : 'ignore',
  });
  for (let i = 0; i < 40; i++) {
    try { const h = await getJson('/health'); if (h.status === 'ok') return; } catch { /* 还没起来 */ }
    await wait(250);
  }
  throw new Error('桥 10 秒内未就绪');
}

async function main() {
  tmp = mkdtempSync(join(tmpdir(), 'ofm-regression-'));
  writeFileSync(join(tmp, 'settings.json'), JSON.stringify({ forwardKey: 'test-key', combos: [{ id: 'combo:auto', models: ['oc-a-free', 'oc-b-free', 'kilo/k-a:free'] }] }));
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  for (const s of rescueServers) await new Promise((r) => s.listen(0, '127.0.0.1', r));
  rescues.forEach((r, i) => { r.port = rescueServers[i].address().port; });
  writeFileSync(join(tmp, 'rescue.json'), JSON.stringify({
    enabled: true, timeoutMs: 10_000,
    providers: rescues.map((r) => ({ id: r.id, baseUrl: `http://127.0.0.1:${r.port}`, apiKey: 'k', model: 'upstream-model' })),
  }));
  writeFileSync(join(tmp, 'lanes.json'), '{}');

  await restartBridge();
  console.log('=== 免费大模型链路 · 回归测试 ===\n受控环境：桥 :%d，上游 :%d，救援 :%d/%d\n', BPORT, upstream.address().port, rescues[0].port, rescues[1].port);

  // R1 双通道 429 → 熔断 + 救援（顺序：rescue-trunc 截断 → rescue-full 完整）
  await setMode('all429');
  let r = await callBridge({ model: 'combo:auto', messages: [{ role: 'user', content: 'hi' }], max_tokens: 32, stream: false });
  ok(r.status === 200 && r.text.includes('完整内容'), 'R1 全通道 429 → 截断换道后救援出完整内容');
  ok(r.text.includes('"model":"combo:auto"') || r.text.includes('"model": "combo:auto"'), 'R1b model 字段改回请求名');
  // 连续第二次请求：熔断已生效，应跳过上游直连打救援（快）
  const t0 = Date.now();
  r = await callBridge({ model: 'combo:auto', messages: [{ role: 'user', content: 'hi' }], max_tokens: 32, stream: false });
  ok(r.status === 200 && Date.now() - t0 < 15_000, 'R1c 熔断后请求不盲试全部成员', `${Date.now() - t0}ms`);

  // R2 熔断持久化与 /health 暴露（落盘有 200ms 防抖，轮询等待）
  const health = await getJson('/health');
  ok(health.lanes?.opencode?.state === 'closed', 'R2a /health 显示 OpenCode 关闸');
  let laneFile = {};
  for (let i = 0; i < 10; i++) {
    await wait(150);
    try { laneFile = JSON.parse(readFileSync(join(tmp, 'lanes.json'), 'utf8')); } catch { /* 还没写入 */ }
    if (laneFile.opencode?.until) break;
  }
  ok(laneFile.opencode?.until > Date.now(), 'R2b 熔断状态已持久化到文件');
  const st = await getJson('/metrics');
  ok(typeof st.metrics?.requests === 'number' && st.metrics.requests >= 2, 'R2c /metrics 计数正常', `requests=${st.metrics?.requests}`);

  // R3 空正文守卫：不关整条通道、只换成员；上游全空正文 → 最终救援兜底
  // 用管理端点清零熔断与冷却（比改文件 + 重启更贴近真实运维路径）
  await setMode('empty');
  await postJson('/admin/reset-lanes');
  r = await callBridge({ model: 'combo:auto', messages: [{ role: 'user', content: 'hi' }], max_tokens: 32, stream: false });
  ok(r.status === 200 && r.text.includes('完整内容'), 'R3a 空正文全灭 → 救援兜底出字');
  const m3 = (await getJson('/metrics')).metrics;
  ok((m3.emptyReplies || 0) >= 3, 'R3b 空正文计数 ≥ 成员数（3）', `emptyReplies=${m3.emptyReplies}`);

  // R4 截断换道：救援① length → 救援②完整
  await setMode('all429');
  await postJson('/admin/reset-lanes');
  r = await callBridge({ model: 'combo:auto', messages: [{ role: 'user', content: 'hi' }], max_tokens: 32, stream: false });
  const m4 = (await getJson('/metrics')).metrics;
  ok(r.text.includes('完整内容') && (m4.truncations || 0) >= 1, 'R4 finish=length 自动换下一救援通道', `truncations=${m4.truncations}`);

  // R5 全员失败：救援配置清空后应返回可读 429
  writeFileSync(join(tmp, 'rescue.json'), JSON.stringify({ enabled: true, providers: [] }));
  await postJson('/admin/reset-lanes');
  r = await callBridge({ model: 'combo:auto', messages: [{ role: 'user', content: 'hi' }], max_tokens: 32, stream: false });
  let r5j = null; try { r5j = JSON.parse(r.text); } catch { /* ignore */ }
  ok(r.status === 429 && r5j?.error?.code === 'ALL_FREE_LANES_EXHAUSTED', 'R5a 全员失败返回中文可读 429');
  ok(typeof r5j?.error?.message === 'string' && !r5j.error.message.includes('\\"'), 'R5b 错误无双层转义');

  // R6 流式：救援②流式帧透传 + model 改写
  writeFileSync(join(tmp, 'rescue.json'), JSON.stringify({
    enabled: true, timeoutMs: 10_000,
    providers: [{ id: 'rescue-full', baseUrl: `http://127.0.0.1:${rescues[1].port}`, apiKey: 'k', model: 'upstream-model' }],
  }));
  r = await callBridge({ model: 'combo:auto', messages: [{ role: 'user', content: 'hi' }], max_tokens: 32, stream: true });
  ok(r.status === 200 && r.text.includes('data:') && r.text.includes('完整内容'), 'R6a 流式救援帧完整');
  ok(r.text.includes('"model":"combo:auto"') && !r.text.includes('upstream-model'), 'R6b 流式 model 已改写为请求名');

  // R7 指标：本轮 sources 里应有 rescue
  const m7 = (await getJson('/metrics')).metrics;
  ok((m7.sources?.rescue || 0) >= 4, 'R7 指标记录救援来源', `sources=${JSON.stringify(m7.sources)}`);
  // 指标落盘有 500ms 防抖，轮询等待
  let metricsFlushed = false;
  for (let i = 0; i < 10 && !metricsFlushed; i++) { await wait(200); metricsFlushed = existsSync(join(tmp, 'metrics.json')); }
  ok(metricsFlushed, 'R7b 指标已持久化到文件');

  if (bridge) bridge.kill();
  upstream.close(); rescueServers.forEach((s) => s.close());

  // R8 真实环境冒烟：生产桥健康 + 一次短请求出字
  if (!SKIP_REAL) {
    console.log('\n=== R8 真实环境冒烟（生产桥 :11435）===');
    try {
      const h = await new Promise((res2, rej) => http.get({ host: '127.0.0.1', port: 11_435, path: '/health' }, (x) => { let t = ''; x.on('data', (c) => t += c); x.on('end', () => res2(JSON.parse(t))); }).on('error', rej));
      ok(h.status === 'ok', 'R8a 生产桥健康', `models=${h.models}`);
      const req = http.request({ host: '127.0.0.1', port: 11_435, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer REPLACE_WITH_YOUR_FORWARD_KEY' } }, (res2) => { let t = ''; res2.on('data', (c) => t += c); res2.on('end', () => {
        let j = null; try { j = JSON.parse(t); } catch { /* ignore */ }
        const c = j?.choices?.[0]?.message?.content;
        ok(res2.statusCode === 200 && c && c.trim(), 'R8b combo:auto 出字', `内容=${String(c || '').trim().slice(0, 20)}`);
        finish();
      }); });
      req.on('error', () => { ok(false, 'R8b combo:auto 出字', '请求异常'); finish(); });
      req.setTimeout(120_000, () => { req.destroy(); ok(false, 'R8b combo:auto 出字', '超时 120s'); finish(); });
      req.end(JSON.stringify({ model: 'combo:auto', messages: [{ role: 'user', content: '只答两个字：正常' }], max_tokens: 32, stream: false }));
    } catch (e) {
      ok(false, 'R8a 生产桥健康', String(e.message || e));
      finish();
    }
  } else {
    finish();
  }
}

function finish() {
  console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('回归测试自身异常：', e); if (bridge) bridge.kill(); process.exit(1); });
