#!/usr/bin/env node
/**
 * 一键自检：Our Free Model 在 LM Studio 与 Ollama 两端的接入是否都正常。
 * 运行：~/.local/node/bin/node ofm-bridge/verify.mjs
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const BRIDGE = 'http://127.0.0.1:11435';
const PLUGIN = join(HOME, '.lmstudio/extensions/plugins/local/ofm-free-models');
const BUNDLE = join(PLUGIN, '.lmstudio/production.js');
const SETTINGS = join(HOME, '.our-free-model/settings.json');
const ok = s => `\x1b[32m✓\x1b[0m ${s}`;
const bad = s => `\x1b[31m✗\x1b[0m ${s}`;
let failed = 0;
const check = (cond, msg) => { console.log(cond ? ok(msg) : bad(msg)); if (!cond) failed++; };

const key = JSON.parse(readFileSync(SETTINGS, 'utf8')).forwardKey;

// 1. 网关模型清单
const modelsResp = await fetch('http://127.0.0.1:18900/v1/models', { headers: { Authorization: `Bearer ${key}` } });
const models = (await modelsResp.json()).data || [];
check(modelsResp.ok && models.length > 0, `独立服务 /v1/models：${models.length} 个免费模型`);

// 2. LM Studio 插件：读取插件里实际写入的配置，用插件自带的 openai SDK 真实调用一次
try {
  const code = readFileSync(BUNDLE, 'utf8');
  const baseURL = code.match(/"overrideBaseUrl",[\s\S]*?\n      \},\n      "([^"]+)"/)[1];
  const pluginKey = code.match(/"customApiKey",[\s\S]*?\n      \},\n      "([^"]+)"/)[1];
  const defaultModel = code.match(/        \]\n      \},\n      "([^"]+)"\n    \)/)[1];
  const optionCount = (code.match(/\{ value: "/g) || []).length;
  check(baseURL === 'http://127.0.0.1:18900/v1' && pluginKey === key,
    `LM Studio 插件配置：Base URL + API Key 正确`);
  const synced = optionCount >= models.length;
  check(synced, `LM Studio 插件模型下拉框：${optionCount} 项 / 网关 ${models.length} 个，默认 ${defaultModel}${synced ? '（已同步）' : '（落后，请重跑 patch-lms-plugin.mjs 刷新）'}`);

  const require = createRequire(join(PLUGIN, 'package.json'));
  const mod = require('openai');
  const OpenAI = mod.default || mod.OpenAI || mod;
  const client = new OpenAI({ apiKey: pluginKey, baseURL });
  const r = await client.chat.completions.create({
    model: defaultModel,
    messages: [{ role: 'user', content: '只回复两个字：在的' }],
    max_tokens: 32,
  });
  const text = r.choices?.[0]?.message?.content || '';
  check(text.includes('在'), `LM Studio 插件生成链路实测：${JSON.stringify(text)}`);
} catch (e) {
  check(false, `LM Studio 插件验证失败：${e.message}`);
}

// 3. Ollama 协议桥
try {
  const tags = await (await fetch(`${BRIDGE}/api/tags`)).json();
  const free = (tags.models || []).filter(m => String(m.digest || '').startsWith('ofm-'));
  check(free.length > 0, `Ollama /api/tags：${free.length} 个免费模型 + ${(tags.models || []).length - free.length} 个本地模型`);
  const chat = await (await fetch(`${BRIDGE}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash-free', messages: [{ role: 'user', content: '只回复两个字：在的' }], stream: false }),
  })).json();
  check((chat.message?.content || '').includes('在'), `Ollama /api/chat 实测：${JSON.stringify(chat.message?.content || chat.error)}`);
} catch (e) {
  check(false, `Ollama 桥验证失败：${e.message}`);
}

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过：LM Studio 与 Ollama 都可用。');
process.exit(failed ? 1 : 0);
