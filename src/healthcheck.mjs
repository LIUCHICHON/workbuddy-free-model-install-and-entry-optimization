#!/usr/bin/env node
/**
 * 免费模型健康检查 + 自动降级验证工具。
 *
 *   node healthcheck.mjs            # 检查桥 + standalone + 逐个模型探活
 *   node healthcheck.mjs --models   # 只列模型与可用性
 *   node healthcheck.mjs --combo    # 实测 combo 链路是否会自动降级
 *
 * 不打印任何 API Key。退出码 0 = 全部正常，1 = 有异常。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BRIDGE = process.env.OFM_BRIDGE || 'http://127.0.0.1:11435';
const SETTINGS = process.env.OFM_SETTINGS || join(homedir(), '.our-free-model', 'settings.json');
const TIMEOUT_MS = Number(process.env.OFM_PROBE_TIMEOUT || 45000);

const args = new Set(process.argv.slice(2));

function forwardKey() {
  try { return JSON.parse(readFileSync(SETTINGS, 'utf8')).forwardKey || ''; } catch { return ''; }
}
const KEY = forwardKey();

async function getModels() {
  const r = await fetch(`${BRIDGE}/v1/models`, {
    headers: { Authorization: `Bearer ${KEY}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`模型列表 HTTP ${r.status}`);
  const body = await r.json();
  return (body.data || []).map(x => x.id).filter(Boolean);
}

async function probe(model) {
  const started = Date.now();
  try {
    const r = await fetch(`${BRIDGE}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8,
        stream: false,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ms = Date.now() - started;
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return { ok: false, ms, reason: `HTTP ${r.status} ${text.slice(0, 160).replace(/\s+/g, ' ')}` };
    }
    const body = await r.json().catch(() => ({}));
    const choice = body?.choices?.[0];
    if (!choice) return { ok: false, ms, reason: 'no choices in response' };
    return { ok: true, ms, reason: `finish=${choice.finish_reason ?? '?'}` };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, reason: e.name === 'TimeoutError' ? `超时 ${TIMEOUT_MS}ms` : e.message };
  }
}

async function checkHealth() {
  try {
    const r = await fetch(`${BRIDGE}/health`, { signal: AbortSignal.timeout(5000) });
    const body = await r.json();
    console.log(`桥 /health      : ok (models=${body.models}, upstream=${body.upstream})`);
    return true;
  } catch (e) {
    console.log(`桥 /health      : 失败 — ${e.message}`);
    return false;
  }
}

async function main() {
  console.log('== ofm-bridge 健康检查 ==\n');
  const healthy = await checkHealth();

  let models = [];
  try { models = await getModels(); } catch (e) {
    console.log(`模型列表         : 失败 — ${e.message}`);
    process.exit(1);
  }
  console.log(`模型总数        : ${models.length}\n`);

  if (args.has('--models')) {
    for (const id of models) console.log(` - ${id}`);
    return;
  }

  console.log('== 逐模型探活（串行，避免触发限流）==');
  const rows = [];
  for (const id of models) {
    if (id.startsWith('combo:')) { rows.push({ id, ok: null, reason: '跳过（虚拟组合，见 --combo）' }); continue; }
    const res = await probe(id);
    rows.push({ id, ...res });
    const mark = res.ok ? 'OK  ' : 'FAIL';
    console.log(`[${mark}] ${id}  ${res.ms}ms  ${res.reason}`);
  }

  const ok = rows.filter(r => r.ok === true).length;
  const fail = rows.filter(r => r.ok === false).length;
  const skip = rows.filter(r => r.ok === null).length;
  console.log(`\n可用 ${ok} / 失败 ${fail} / 跳过 ${skip}`);

  if (args.has('--combo')) {
    console.log('\n== combo 自动降级验证 ==');
    const combos = models.filter(id => id.startsWith('combo:'));
    for (const id of combos) {
      const res = await probe(id);
      console.log(`[${res.ok ? 'OK  ' : 'FAIL'}] ${id}  ${res.ms}ms  ${res.reason}`);
    }
  }

  if (!healthy) process.exit(1);
  process.exit(fail > 0 ? 1 : 0);
}

main();
