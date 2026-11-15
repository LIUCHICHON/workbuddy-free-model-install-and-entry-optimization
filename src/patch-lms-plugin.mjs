#!/usr/bin/env node
/**
 * 把 LM Studio 的 OpenAI 兼容 generator 插件改造成「Our Free Model」专用插件。
 *
 * 作用：
 *   1. 从独立服务的 /v1/models 拉取当前全部免费模型，写进插件的模型下拉框；
 *   2. 预置本机端点 http://127.0.0.1:18900/v1 与 forwardKey，打开 LM Studio 即零配置可用；
 *   3. 强制所有模型走本地网关（原插件会按 deepseek- / glm- 前缀误连官方 API）。
 *
 * 上游模型清单变化后，重新运行本脚本即可刷新下拉框（脚本可重复运行）。
 * 目标插件：~/.lmstudio/extensions/plugins/local/ofm-free-models
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const BASE = process.env.OFM_UPSTREAM || 'http://127.0.0.1:18900/v1';
const SETTINGS = join(HOME, '.our-free-model', 'settings.json');
const CACHE = process.env.OFM_MODELS_CACHE || join(HOME, '.our-free-model', 'models.json');
const PLUGIN = join(HOME, '.lmstudio', 'extensions', 'plugins', 'local', 'ofm-free-models');
const BUNDLE = join(PLUGIN, '.lmstudio', 'production.js');

const key = JSON.parse(readFileSync(SETTINGS, 'utf8')).forwardKey;
let models;
try {
  const r = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
  models = (await r.json()).data.map(m => m.id).filter(Boolean);
  if (!models.length) throw new Error('空模型清单');
  writeFileSync(CACHE, JSON.stringify({ updatedAt: new Date().toISOString(), models }, null, 2));
} catch (e) {
  console.warn(`[warn] 拉取模型清单失败（${e.message}），使用上次缓存`);
  models = JSON.parse(readFileSync(CACHE, 'utf8')).models;
}
console.log(`[ofm] 免费模型 ${models.length} 个`);

if (!existsSync(BUNDLE)) throw new Error(`插件不存在：${BUNDLE}`);
let code = readFileSync(BUNDLE, 'utf8');

function replace(re, value, label) {
  if (!re.test(code)) throw new Error(`替换失败（未匹配）：${label}`);
  code = code.replace(re, value);
  console.log(`[ofm] ✓ ${label}`);
}

const DEFAULT = models.includes('deepseek-v4.1-flash-free') ? 'deepseek-v4.1-flash-free' : models[0];
const options = models.map(id => `          { value: ${JSON.stringify(id)}, displayName: ${JSON.stringify(id)} },`).join('\n');
const optionsBlock = `        options: [
${options}
          { value: CUSTOM_MODEL_VALUE, displayName: "Use Custom Model (手动填 ID)" }
        ]
      },
      ${JSON.stringify(DEFAULT)}
    )`;

replace(
  /        options: \[\n[\s\S]*?        \]\n      \},\n      "[^\n]*"\n    \)/,
  optionsBlock,
  '模型下拉框 + 默认模型',
);
replace(
  /(\.field\(\n      "customApiKey",[\s\S]*?\n      \},\n      )"[^\n]*"(\n    \))/,
  `$1${JSON.stringify(key)}$2`,
  '预置 API Key',
);
replace(
  /(\.field\(\n      "overrideBaseUrl",[\s\S]*?\n      \},\n      )"[^\n]*"(\n    \))/,
  `$1${JSON.stringify(BASE)}$2`,
  '预置 Base URL',
);
replace(
  /function resolveRoute\(model\) \{[\s\S]*?\n\}\nfunction resolveModel/,
  `function resolveRoute(model) {
  return {
    providerName: "Our Free Model",
    baseURL: ${JSON.stringify(BASE)},
    apiKeyField: "customApiKey"
  };
}
function resolveModel`,
  '强制走本地网关',
);

writeFileSync(BUNDLE, code);

writeFileSync(join(PLUGIN, 'manifest.json'), JSON.stringify({
  type: 'plugin', runner: 'node', owner: 'local', name: 'ofm-free-models', revision: 1,
}, null, 2) + '\n');

const pkgPath = join(PLUGIN, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.description = 'Our Free Model — LM Studio generator for the local dsh-our-free-model gateway';
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

console.log('[ofm] 插件改造完成，重启 LM Studio 后即可在顶部模型选择器看到 Our Free Model。');
