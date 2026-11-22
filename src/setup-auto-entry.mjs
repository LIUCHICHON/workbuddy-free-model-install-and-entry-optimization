#!/usr/bin/env node
/**
 * 总入口生成器（设备无关）—— 为 dsh-our-free-model standalone 创建/更新一条
 * `combo:auto` 总入口：round-robin 策略 + 双通道成员（OpenCode + kilo 前缀）自动择优降级。
 * 负载在双通道间分散，避免单一通道被连续请求刷爆 429；standalone 链内仍会在单次请求内自动兜底。
 *
 * 设计目标：换一台设备也能跑。全部靠自动探测 + 环境变量，不写死任何绝对路径/端口/密钥。
 *
 * 环境变量（都可选）：
 *   OFM_HOME            standalone 数据目录（默认 ~/.our-free-model；与 standalone 的 OFM_HOME 一致）
 *   OFM_DATA_DIR        OFM_HOME 的别名（二者取其一即可）
 *   OFM_BRIDGE_PORT     桥端口（默认 11435）
 *   OFM_UPSTREAM        桥的上游 standalone 地址（默认 http://127.0.0.1:18900/v1）
 *   OFM_BRIDGE_ENTRY_DIR 可选：ofm-bridge 目录（含 ofm-combos.mjs），用于自动接入 WorkBuddy
 *   OFM_WORKBUDDY_MODELS  可选：models.json 路径（默认 ~/.workbuddy/models.json）
 *
 * 用法：
 *   node setup-auto-entry.mjs                  # 创建/更新 combo:auto（默认 round-robin）
 *   node setup-auto-entry.mjs --wb             # 额外把它插入 WorkBuddy models.json 置顶
 *   node setup-auto-entry.mjs --dry            # 只打印计划，不改动
 *   node setup-auto-entry.mjs --strategy smart # 指定策略（fallback/round-robin/smart/usage/pace）
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

// 设备护栏：脚本用到内置 fetch / AbortSignal.timeout（Node 18+）。
// 换到旧机器时给出明确提示，而不是 "fetch is not defined"。
if (Number(process.versions.node.split('.')[0]) < 18) {
  console.error(`[×] 需要 Node.js >= 18（当前 v${process.versions.node}）。`);
  console.error('    升级：brew install node 或 https://nodejs.org 下载 LTS。');
  process.exit(1);
}

const HOME = homedir();
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const TO_WB = args.includes('--wb') || args.includes('--workbuddy');
// 路由策略：默认 round-robin（负载在 OpenCode/kilo 多通道间分散，避免单一通道被连续请求刷爆 429）。
// 也可用 --strategy smart 还原。其它合法值：fallback / pace / usage。
const STRATEGY = (() => {
  const i = args.indexOf('--strategy');
  if (i >= 0 && args[i + 1]) return args[i + 1];
  return 'round-robin';
})();
if (!['fallback', 'round-robin', 'smart', 'usage', 'pace'].includes(STRATEGY)) {
  console.error(`[✗] 非法策略: ${STRATEGY}（可选 fallback/round-robin/smart/usage/pace）`);
  process.exit(1);
}

// ---- 探测数据目录 ----
const dataDir = resolve(
  process.env.OFM_HOME || process.env.OFM_DATA_DIR || join(HOME, '.our-free-model')
);
const settingsPath = join(dataDir, 'settings.json');
const catalogPath = join(dataDir, 'catalog.json');

if (!existsSync(settingsPath)) {
  console.error(`[×] 找不到 settings.json：${settingsPath}`);
  console.error('    请用 OFM_HOME 指定 standalone 数据目录，或确认本机已安装 dsh-our-free-model。');
  process.exit(2);
}

const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
const managementKey = settings.managementKey || '';
const forwardKey = settings.forwardKey || '';
const standalonePort = Number(settings.standalonePort) || 18900;

// ---- 探测桥 ----
const bridgePort = Number(process.env.OFM_BRIDGE_PORT) || 11435;
const bridgeBase = `http://127.0.0.1:${bridgePort}`;
const upstream = (process.env.OFM_UPSTREAM || `http://127.0.0.1:${standalonePort}/v1`).replace(/\/+$/, '');

// ---- 从 catalog 自动挑双通道成员 ----
// kilo 通道模型：id 带前缀（kilo-/nvidia//reflection//openrouter//cohere//baidu//stealth//particle-ai//dots-studio//inclusionai//liquid//cohere 等），
// 且已知不稳定的 ling-3.2 / lfm-3-1.7b 排除。
const UNSTABLE = ['inclusionai/ling-3.2-flash:free', 'liquid/lfm-3-1.7b:free'];

// 上游已下线的模型 id（2026-11-22 实测确认，404 model not found）。
// 这些 id 必须排除，否则重跑 --wb 会把死 id 写回 models.json，桥每次轮询都会撞一次 404。
const GONE = [
  'glm-5.3-flash-free',
  'dots-studio/dots-3-note-preview:free',
  'cohere/north-mini-code:free',
  'minimax-m3.1-flash-free',
  'inkling-2-small-free',
];

// 统一排除集：临时不稳定 + 已被上游下线。两类都不该进池。
const EXCLUDE = [...new Set([...UNSTABLE, ...GONE])];

// 救援通道优先级（用户指定，2026-11-14）：sensenova → glm-4-flash。
// 备注：agnes 不做实名认证，每次都 429 → 已移除；glm-4-flash 只有 ~18 tok/s、长请求还会 500，固定排最后。
const RESCUE_RANK = { 'sensenova-6.8-flash-lite': 0, 'glm-4-flash': 1 };
const rescueRankOf = (id) => (RESCUE_RANK[id] ?? 5);

// ---- WorkBuddy models.json 合并同步：总入口 + 专项 combo 的显示名 ----
// （已有条目沿用原名，缺失时才用这里的默认名）
const COMBO_NAMES = {
  'combo:auto': '⓪ 总入口（轮询双通道·抗 429）',
  'combo:daily': '① 日常主力（自动降级·5级）',
  'combo:fast': '② 快速响应（自动降级·4级）',
  'combo:deep': '③ 深度推理（智能择优·4级）',
  'combo:vision': '④ 看图识图（自动降级·4级）',
  'combo:code': '⑤ 代码专用（自动降级·3级）',
};
const COMBO_ORDER = Object.keys(COMBO_NAMES);
let kiloIds = [];
try {
  const cat = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const kiloRows = cat.kiloRows || [];
  kiloIds = kiloRows
    .map(m => m.id)
    .filter(id => !EXCLUDE.includes(id));
} catch { /* 无 catalog 时用内置兜底池 */ }

const FALLBACK_KILO = [
  'kilo-auto/free', 'nvidia/nemotron-3.5-lightning:free', 'nvidia/nemotron-3.5-super-vl:free',
  'reflection/beam-free', 'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', 'openrouter/free',
  'cohere/north-mini-code:free', 'baidu/ernie-5.5-flash-preview:free',
];
const kiloPool = kiloIds.length ? kiloIds : FALLBACK_KILO;

// OpenCode 通道：catalog.entries（默认通道）优先，配合几个常用优质模型
let openIds = [];
try {
  const cat = JSON.parse(readFileSync(catalogPath, 'utf8'));
  openIds = (cat.entries || []).filter(id => !EXCLUDE.includes(id));
} catch { /* ignore */ }
const PREFERRED_OPEN = ['deepseek-v4.1-flash-free', 'mimo-v2.6-flash-free', 'longcat-2.5-free'];
// 跨设备修正：PREFERRED 只是"优先级"，不代表本机 catalog 一定提供。
// 有 catalog 时取交集（避免在新设备上选到根本不存在的模型），没有 catalog 时才原样使用。
const preferredAvailable = openIds.length
  ? PREFERRED_OPEN.filter(id => openIds.includes(id))
  : PREFERRED_OPEN;
const openPool = [...new Set([...preferredAvailable, ...openIds])].filter(id => !EXCLUDE.includes(id));

// 组装成员：OpenCode 优质在前，kilo 兜底在后（round-robin 在双通道间轮询分散；桥再兜通道级 429）
const members = [...openPool.slice(0, 6), ...kiloPool.slice(0, 8)];
const deduped = [...new Set(members)];

// 探测上游清单（dry-run 也要用它来算 WorkBuddy 合并计划）
const upstreamModels = await probeUpstreamModels();

let wbPlan = null;
if (TO_WB) {
  const wbPath0 = process.env.OFM_WORKBUDDY_MODELS || join(HOME, '.workbuddy', 'models.json');
  if (existsSync(wbPath0)) {
    wbPlan = planWorkBuddy(JSON.parse(readFileSync(wbPath0, 'utf8')), upstreamModels, bridgePort);
  }
}

console.log('=== 总入口生成计划 ===');
console.log('  数据目录 :', dataDir);
console.log('  桥端口   :', bridgePort, '| upstream:', upstream);
console.log('  策略     :', STRATEGY, STRATEGY === 'round-robin' ? '（双通道轮询分散负载，抗 429）' : '（按额度自动择优 + 降级）');
console.log('  成员数   :', deduped.length, '（OpenCode 优先 + kilo 兜底）');
console.log('  OpenCode :', openPool.slice(0, 6).join(', '));
console.log('  kilo     :', kiloPool.slice(0, 8).join(', '));
console.log('  WorkBuddy:', !TO_WB ? '不接入' : wbPlan
  ? `合并同步 ${wbPlan.entries.length} 条（新增 ${wbPlan.added.length} / 移除 ${wbPlan.removed.length} / 改名 ${wbPlan.renamed.length} / 外部直连保留 ${wbPlan.externalCount}，上游探测${wbPlan.upstreamOk ? '成功' : '失败-沿用现有'}）`
  : '找不到 models.json（跳过）');
if (wbPlan && wbPlan.added.length) console.log('    将新增:', wbPlan.added.join(', '));
if (wbPlan && wbPlan.removed.length) console.log('    将移除:', wbPlan.removed.join(', '));
if (wbPlan && wbPlan.renamed.length) {
  console.log('    将改名:');
  for (const id of wbPlan.renamed) console.log(`      ${id}: ${(wbPlan.entries.find(e => e.id === id).name)}`);
}
if (TO_WB && wbPlan) {
  const ext = wbPlan.entries
    .filter(m => m && m.id && !(m.url || '').includes('127.0.0.1'))
    .sort((a, b) => rescueRankOf(a.id) - rescueRankOf(b.id));
  console.log('  救援通道:', ext.length ? `将写入 ${ext.length} 条外部直连（按优先级：${ext.map(m => m.id).join(' → ')}）` : '无外部直连，跳过');
}

if (DRY) { console.log('\n[dry-run] 未做任何改动。'); process.exit(0); }

// ---- 调 standalone 管理接口创建/更新 combo:auto ----
const base = `http://127.0.0.1:${standalonePort}`;
const PREFIX = '/api/management';
async function login() {
  const r = await fetch(`${base}${PREFIX}/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ key: managementKey || forwardKey }),
  });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  if (!r.ok || !cookie) throw new Error(`登录失败 HTTP ${r.status}`);
  return cookie;
}

// 探测上游真实可用模型清单（standalone /v1/models）。失败返回 null，退回"沿用现有条目"。
async function probeUpstreamModels() {
  try {
    const r = await fetch(`${upstream}/models`, {
      headers: { authorization: `Bearer ${forwardKey || 'ollama-bridge-free'}` },
    });
    if (!r.ok) return null;
    const j = await r.json();
    const ids = (j.data || []).map(m => m && m.id).filter(Boolean);
    return ids.length ? ids : null;
  } catch { return null; }
}

// 生成 models.json 合并计划（纯函数，不落盘）。dry-run 与真实写入共用同一份计划。
function planWorkBuddy(wb, upstreamIds, port) {
  const bridgePrefix = `http://127.0.0.1:${port}`;
  const byId = new Map(wb.filter(m => m && m.id).map(m => [m.id, m]));
  const ref = wb.find(m => (m.url || '').startsWith(bridgePrefix)) || wb[0] || {};
  const apiKey = ref.apiKey || 'ollama-bridge-free';

  // 可用的桥内模型：优先用上游真实清单；探测失败则沿用现有桥内条目
  const internalIds = upstreamIds
    ? upstreamIds.filter(id => !EXCLUDE.includes(id) || byId.has(id))
    : [...byId.keys()].filter(id => (byId.get(id).url || '').startsWith(bridgePrefix));

  const comboIds = COMBO_ORDER.filter(id => internalIds.includes(id));
  const wbIndex = new Map([...byId.keys()].map((id, i) => [id, i]));
  const rankOf = (id) => {
    const n = (byId.get(id) || {}).name || '';
    if (EXCLUDE.includes(id) || n.startsWith('[暂不可用]')) return 9;
    if (n.startsWith('★')) return 0;
    if (n.startsWith('备')) return 1;
    return id.includes('/') ? 3 : 2; // 新条目：OpenCode 组在前，kilo 组在后
  };
  const singleIds = internalIds
    .filter(id => !id.startsWith('combo:'))
    .sort((a, b) => (rankOf(a) - rankOf(b))
      || ((wbIndex.get(a) ?? 900 + internalIds.indexOf(a)) - (wbIndex.get(b) ?? 900 + internalIds.indexOf(b))));

  // 显示名规则：combo 类（⓪..⑤ 分组名）以 COMBO_NAMES 为准，保证每次导入都对齐当前策略；
  // 单模型则沿用已有名字（用户可能自定义过 ★/备 编号），缺失时才用默认名。
  const mk = (id, name, seq) => {
    const old = byId.get(id) || {};
    const isCombo = COMBO_ORDER.includes(id);
    const fallbackName = isCombo
      ? COMBO_NAMES[id]
      : `备${String(seq).padStart(2, '0')} ${id}`;
    return {
      id,
      name: isCombo ? (COMBO_NAMES[id] || old.name) : (old.name || name || fallbackName),
      vendor: old.vendor || 'Custom',
      url: `${bridgePrefix}/v1`,
      apiKey: old.apiKey || apiKey,
      supportsToolCall: old.supportsToolCall !== undefined ? old.supportsToolCall : true,
      supportsImages: old.supportsImages !== undefined ? old.supportsImages : /vl|vision/i.test(id),
      supportsReasoning: old.supportsReasoning !== undefined ? old.supportsReasoning : true,
      useCustomProtocol: old.useCustomProtocol !== undefined ? old.useCustomProtocol : false,
    };
  };

  const entries = [
    ...comboIds.map(id => mk(id)),
    ...singleIds.map((id, i) => mk(id, null, i + 1)),
  ];
  const keepIds = new Set(entries.map(e => e.id));
  const external = wb.filter(m => m && m.id && !(m.url || '').startsWith(bridgePrefix));
  const removed = [...byId.keys()].filter(id =>
    (byId.get(id).url || '').startsWith(bridgePrefix) && !keepIds.has(id));
  const added = entries.filter(e => !byId.has(e.id)).map(e => e.id);
  const renamed = entries.filter(e => byId.has(e.id) && byId.get(e.id).name !== e.name).map(e => e.id);

  return { entries: [...entries, ...external], added, removed, renamed, externalCount: external.length, upstreamOk: !!upstreamIds };
}

/**
 * 生成桥的外部救援通道配置（免费池整段限流时降级用）。
 * 数据来源：models.json 里的外部直连条目（非 127.0.0.1 的、带 apiKey 的）。
 * 已存在配置里的开关（enabled / onlyForCombos / timeoutMs）和缺失的 apiKey 会被保留。
 */
function syncRescueConfig(entries) {
  // 跟随 OFM_HOME/OFM_DATA_DIR（Windows 上数据目录可能不在 HOME 下），不写死 ~/.our-free-model
  const rescuePath = process.env.OFM_RESCUE_CONFIG || join(dataDir, 'rescue-providers.json');
  const ext = (entries || []).filter(m => m && m.id && m.apiKey && !(m.url || '').includes('127.0.0.1') && m.id !== 'agnes-2.5-flash');
  if (!ext.length) return null;

  let old = {};
  try { old = JSON.parse(readFileSync(rescuePath, 'utf8')); } catch { /* 首次生成 */ }
  const oldById = new Map((old.providers || []).map(p => [p.id, p]));
  // 排序按「速度 + 单次输出上限」实测（与 dry-run 预览保持同一口径）
  const providers = ext.map(m => {
    const prev = oldById.get(m.id) || {};
    return {
      id: m.id,
      name: m.name || m.id,
      baseUrl: String(m.url || '').replace(/\/chat\/completions\/?$/i, '').replace(/\/+$/, ''),
      apiKey: String(m.apiKey || prev.apiKey || ''),
      model: m.id,
    };
  }).sort((a, b) => rescueRankOf(a.id) - rescueRankOf(b.id));

  const cfg = {
    _comment: '桥的外部救援通道：免费池（OpenCode/Kilo）整段限流时自动降级到这里，走独立配额。由 setup-auto-entry.mjs --wb 自动生成/刷新。',
    enabled: old.enabled !== false,
    onlyForCombos: old.onlyForCombos === true,
    timeoutMs: Number(old.timeoutMs) || 60000,
    providers,
  };
  mkdirSync(dirname(rescuePath), { recursive: true });
  writeFileSync(rescuePath, JSON.stringify(cfg, null, 2));
  try { chmodSync(rescuePath, 0o600); } catch { /* Windows 无 chmod 语义，忽略 */ }
  return { path: rescuePath, count: providers.length, ids: providers.map(p => p.id) };
}

async function main() {
  let cookie;
  try {
    cookie = await login();
  } catch (e) {
    console.error('[×]', e.message);
    console.error('    确认 standalone 已启动（默认 18900）且 managementKey 正确。');
    process.exit(3);
  }
  // 先看是否已存在 combo:auto
  const listRes = await fetch(`${base}${PREFIX}/routing`, { headers: { cookie, origin: base, 'sec-fetch-site': 'same-origin' } });
  let existing = [];
  try { const j = await listRes.json(); existing = j.combos || j.routing || j.groups || j.data || []; } catch { /* ignore */ }
  const has = existing.some(c => c.id === 'combo:auto');

  const payload = { name: 'auto', strategy: STRATEGY, stickyLimit: 1, enabled: true, models: deduped };
  const body = has ? { combo: { id: 'combo:auto', ...payload } } : { combo: payload };

  const saveRes = await fetch(`${base}${PREFIX}/routing/save`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin: base, 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify(body),
  });
  const txt = await saveRes.text();
  if (!saveRes.ok) {
    console.error('[×] 保存失败 HTTP', saveRes.status, txt.slice(0, 200));
    process.exit(4);
  }
  console.log(`\n[✓] combo:auto ${has ? '已更新' : '已创建'}（${deduped.length} 个成员，策略 ${STRATEGY}）`);

  // ---- 可选：合并同步进 WorkBuddy models.json ----
  if (TO_WB) {
    const wbPath = process.env.OFM_WORKBUDDY_MODELS || join(HOME, '.workbuddy', 'models.json');
    if (!existsSync(wbPath)) {
      console.warn('[!] 找不到 WorkBuddy models.json：', wbPath, '（跳过接入）');
    } else {
      const wb = JSON.parse(readFileSync(wbPath, 'utf8'));
      const plan = planWorkBuddy(wb, upstreamModels, bridgePort);
      const bak = `${wbPath}.bak-${Date.now()}`;
      copyFileSync(wbPath, bak);
      writeFileSync(wbPath, JSON.stringify(plan.entries, null, 2));
      try { chmodSync(wbPath, 0o600); } catch { /* 忽略 */ }
      const groups = {
        combo: plan.entries.filter(m => m.id.startsWith('combo:')).length,
        single: plan.entries.filter(m => !m.id.startsWith('combo:')).length,
      };
      console.log(`[✓] WorkBuddy models.json 已合并同步：${plan.entries.length} 条（combo ${groups.combo} + 模型 ${groups.single}）`);
      if (plan.added.length) console.log('    新增:', plan.added.join(', '));
      if (plan.removed.length) console.log('    移除:', plan.removed.join(', '));
      console.log('    外部直连保留:', plan.externalCount, '| 备份:', bak);

      // 顺手刷新桥的救援通道配置（否则免费池整段限流时桥无处降级）
      const rs = syncRescueConfig(plan.entries);
      if (rs) console.log(`[✓] 救援通道已同步：${rs.count} 条（${rs.ids.join(' / ')}）→ ${rs.path}`);
      else console.log('[!] 没有可用的外部直连条目，救援通道未生成（免费池耗尽时只能返回错误）');
    }
  }

  console.log('\n完成。建议在 WorkBuddy 模型列表选「⓪ 总入口」。');
}

main().catch(e => { console.error('[×]', e.stack || e.message); process.exit(1); });