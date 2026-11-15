/**
 * 通过本地管理接口管理 dsh-our-free-model 的降级路由组（combo）。
 *
 *   node ofm-combos.mjs get
 *   node ofm-combos.mjs save <combo.json>     # 单个 {name,models,strategy,stickyLimit,enabled}
 *   node ofm-combos.mjs remove <comboId>
 *   node ofm-combos.mjs preview <models.json> # 只看排序，不保存
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const S = JSON.parse(readFileSync(join(homedir(), '.our-free-model', 'settings.json'), 'utf8'));
const BASE = process.env.OFM_BASE || 'http://127.0.0.1:18900';
const PREFIX = '/api/management';
const HEADERS = { origin: BASE, 'sec-fetch-site': 'same-origin' };

const [mode, arg] = process.argv.slice(2);

const login = await fetch(`${BASE}${PREFIX}/session`, {
  method: 'POST',
  headers: { ...HEADERS, 'content-type': 'application/json' },
  body: JSON.stringify({ key: S.managementKey || S.forwardKey }),
});
const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
if (!login.ok || !cookie) {
  console.error('登录失败', login.status, await login.text());
  process.exit(1);
}

async function call(method, path, body) {
  const r = await fetch(`${BASE}${PREFIX}${path}`, {
    method,
    headers: { ...HEADERS, cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  if (!r.ok) {
    console.error(`${method} ${path} -> ${r.status}\n${text}`);
    process.exit(1);
  }
  try { return JSON.parse(text); } catch { return text; }
}

const readJson = p => JSON.parse(readFileSync(p, 'utf8'));

if (mode === 'get') {
  const out = await call('GET', '/routing');
  console.log('== 现有路由组 ==');
  console.log(JSON.stringify(out.combos, null, 2));
  console.log(`\n== 可用模型 ${out.models.length} 个 · 支持策略 ${out.strategies.join(' / ')} ==`);
} else if (mode === 'save') {
  if (!arg) { console.error('缺少 combo.json 路径'); process.exit(1); }
  const out = await call('POST', '/routing/save', { combo: readJson(arg) });
  console.log(JSON.stringify(out, null, 2));
} else if (mode === 'remove') {
  if (!arg) { console.error('缺少 comboId'); process.exit(1); }
  console.log(JSON.stringify(await call('POST', '/routing/remove', { id: arg }), null, 2));
} else if (mode === 'batch') {
  if (!arg) { console.error('缺少 batch.json 路径'); process.exit(1); }
  const body = readJson(arg);
  const combos = Array.isArray(body) ? body : body.combos;
  const removeIds = Array.isArray(body?.remove) ? body.remove : [];
  for (const id of removeIds) {
    try { await call('POST', '/routing/remove', { id }); console.log('removed', id); }
    catch { console.log('skip remove', id); }
  }
  for (const combo of combos) {
    const out = await call('POST', '/routing/save', { combo });
    const saved = out.combos.find(c => c.name === combo.name);
    console.log('saved', saved ? `${saved.id} (${saved.models.length} 个成员)` : combo.name);
  }
  const final = await call('GET', '/routing');
  console.log('\n== 最终路由组 ==');
  for (const c of final.combos) {
    console.log(`${c.enabled ? '✓' : '✗'} ${c.name.padEnd(10)} [${c.strategy}] → ${c.models.join(' › ')}`);
  }
} else if (mode === 'preview') {
  if (!arg) { console.error('缺少 models.json 路径'); process.exit(1); }
  const body = readJson(arg);
  console.log(JSON.stringify(await call('POST', '/routing/preview',
    Array.isArray(body) ? { models: body } : body), null, 2));
} else {
  console.error('用法: node ofm-combos.mjs get | save <file> | remove <id> | preview <file>');
  process.exit(1);
}
