#!/usr/bin/env node
// Provider-layer replay of captured requests/responses to validate field parsing
// - For provider-out-openai_*.json: run GLMCompatibility.processResponse and compare tool_calls before/after
// - For pipeline-in-anth_*.json: run AnthropicOpenAIConverter.transformRequest to inspect outgoing OpenAI request fields

import fs from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';

const home = process.env.HOME || process.env.USERPROFILE || '';
const dir = path.join(home, '.routecodex', 'codex-samples');

async function list(prefix, limit=20) {
  try {
    const files = await fs.readdir(dir);
    const list = files.filter(f => f.startsWith(prefix) && f.endsWith('.json'))
      .map(f => ({ f, ts: Number(f.match(/_(\d{10,})/)?.[1] || 0) }))
      .sort((a,b) => b.ts - a.ts)
      .slice(0, limit)
      .map(x => path.join(dir, x.f));
    return list;
  } catch { return []; }
}

async function readJson(p) { try { return JSON.parse(await fs.readFile(p,'utf8')); } catch { return null; } }

async function importDist(rel) {
  const dist = path.resolve(process.cwd(), 'dist', rel);
  return await import(url.pathToFileURL(dist).href);
}

function summarizeToolCallsOpenAI(j) {
  const ch = Array.isArray(j?.choices) ? j.choices[0] : null;
  const msg = ch?.message || {};
  const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  let empty = 0, nonStr = 0, parseErr = 0;
  for (const tc of calls) {
    const fn = tc?.function || {};
    if (typeof fn.arguments !== 'string') { nonStr++; continue; }
    const s = fn.arguments; if (!s || !s.trim() || s.trim() === '{}') empty++;
    try { JSON.parse(s); } catch { parseErr++; }
  }
  return { count: calls.length, empty, nonStr, parseErr };
}

function summarizeToolUseAnthropic(j) {
  const msgs = j?.data?.messages; if (!Array.isArray(msgs)) return { count:0, empty:0, missing:0 };
  let count=0, empty=0, missing=0;
  for (const m of msgs) {
    const content = Array.isArray(m?.content) ? m.content : [];
    for (const c of content) {
      if (c?.type === 'tool_use') {
        count++;
        const input = (c.input && typeof c.input === 'object') ? c.input : {};
        if (!input || Object.keys(input).length===0) empty++;
      }
    }
  }
  return { count, empty, missing };
}

async function replayProviderOut(files) {
  const mod = await importDist('modules/pipeline/modules/compatibility/glm-compatibility.js');
  const GLMCompatibility = mod.GLMCompatibility || mod.default || null;
  if (!GLMCompatibility) throw new Error('GLMCompatibility not found in dist');
  const comp = new GLMCompatibility({ type:'glm-compatibility', config:{} }, { logger: { logModule(){}, logTransformation(){} } });
  await comp.initialize?.();
  const rows = [['file','pre_count','pre_empty','pre_nonStr','pre_parseErr','post_count','post_empty','post_nonStr','post_parseErr']];
  for (const f of files) {
    const j = await readJson(f); if (!j) continue;
    const pre = summarizeToolCallsOpenAI(j);
    // Prefer modern pipeline hook name
    const postJ = typeof comp.processOutgoing === 'function' ? await comp.processOutgoing(j)
                : (typeof comp.processResponse === 'function' ? await comp.processResponse(j) : j);
    const post = summarizeToolCallsOpenAI(postJ);
    rows.push([path.basename(f), pre.count, pre.empty, pre.nonStr, pre.parseErr, post.count, post.empty, post.nonStr, post.parseErr].join(','));
  }
  await fs.mkdir('tmp', { recursive: true });
  await fs.writeFile('tmp/provider-replay.csv', rows.join('\n'));
  console.log('Provider-out replay summary:');
  console.log(rows.slice(0,6).join('\n'));
}

async function replayPipelineIn(files) {
  const mod = await importDist('modules/pipeline/modules/llmswitch/llmswitch-anthropic-openai.js');
  const Conv = mod.AnthropicOpenAIConverter || mod.default || null;
  if (!Conv) throw new Error('AnthropicOpenAIConverter not found in dist');
  const conv = new Conv({ type:'llmswitch-anthropic-openai', config:{} }, { logger: { logModule(){}, logTransformation(){} } });
  await conv.initialize?.();
  const rows = [['file','tool_use_count','empty_inputs']];
  for (const f of files) {
    const j = await readJson(f); if (!j) continue;
    const sum = summarizeToolUseAnthropic(j);
    rows.push([path.basename(f), sum.count, sum.empty].join(','));
  }
  await fs.mkdir('tmp', { recursive: true });
  await fs.writeFile('tmp/pipeline-in-replay.csv', rows.join('\n'));
  console.log('Pipeline-in replay summary:');
  console.log(rows.slice(0,6).join('\n'));
}

async function main() {
  const prov = await list('provider-out-openai_', Number(process.env.REPLAY_LIMIT||20));
  const anth = await list('pipeline-in-anth_', Number(process.env.REPLAY_LIMIT||20));
  if (prov.length) await replayProviderOut(prov);
  else console.log('No provider-out-openai samples found');
  if (anth.length) await replayPipelineIn(anth);
  else console.log('No pipeline-in-anth samples found');
}

main().catch(err => { console.error(err); process.exit(1); });
