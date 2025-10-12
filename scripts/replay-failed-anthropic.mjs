#!/usr/bin/env node
// Replay all failed Anthropics requests (from drop-diagnosis files):
// For each rid with provider hits, replay provider pairs through host converter
// injecting the corresponding anthropic-request as debug.request to provide tools schema.
// Prints a summary of produced tool_use counts and key-set comparisons.

import fs from 'fs/promises';
import path from 'path';

const home = process.env.HOME || process.env.USERPROFILE || '';
const baseDir = path.join(home, '.routecodex', 'codex-samples', 'anth-replay');

async function readJson(p) { return JSON.parse(await fs.readFile(p, 'utf8')); }

async function listFiles(prefix) {
  try {
    const names = await fs.readdir(baseDir);
    const items = await Promise.all(names.filter(n => n.startsWith(prefix)).map(async n => {
      const full = path.join(baseDir, n);
      const st = await fs.stat(full); return { name: n, full, mtimeMs: st.mtimeMs };
    }));
    return items.sort((a,b) => b.mtimeMs - a.mtimeMs);
  } catch { return []; }
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
function keysOf(obj) { return obj && typeof obj === 'object' ? Object.keys(obj).sort() : []; }

async function getHostConverter() {
  const p = path.resolve('dist/modules/pipeline/modules/llmswitch/llmswitch-anthropic-openai.js');
  const mod = await import(p);
  return mod.AnthropicOpenAIConverter;
}

async function replayPair(pairFile, anthReqFile) {
  const pair = await readJson(pairFile);
  const anthReq = await readJson(anthReqFile);
  const AnthropicOpenAIConverter = await getHostConverter();
  const logger = { logModule() {}, logTransformation() {}, logProviderRequest() {} };
  const conv = new AnthropicOpenAIConverter({ type: 'llmswitch-anthropic-openai', config: { enableTools: true, enableStreaming: false, trustSchema: true } }, { logger });
  await conv.initialize();
  const dto = { data: pair.response, metadata: { pipelineId: 'replay', processingTime: 0, stages: [], requestId: pair.requestId || 'replay' }, debug: { request: anthReq.data } };
  const out = await conv.processOutgoing(dto);
  const content = Array.isArray(out?.data?.content) ? out.data.content : (Array.isArray(out?.content) ? out.content : []);
  const tus = content.filter(b => b && b.type === 'tool_use');
  const calls = (pair?.response?.choices?.[0]?.message?.tool_calls) || [];
  const zipped = tus.map((t, i) => ({ id: t.id, name: t.name, tool_use_keys: keysOf(t.input), provider_keys: keysOf(safeParse(calls[i]?.function?.arguments) || {}) }));
  return { pair: path.basename(pairFile), tool_use_count: tus.length, provider_call_count: calls.length, tuples: zipped };
}

async function main() {
  const drops = await listFiles('drop-diagnosis-');
  const targets = drops
    .map(x => x.full)
    .filter(Boolean)
    .slice(0, 50); // cap

  const results = [];
  for (const drop of targets) {
    const diag = await readJson(drop);
    const rid = diag?.requestId;
    const anthReq = path.join(baseDir, `anthropic-request-${rid}.json`);
    if (!rid || !diag?.stages?.provider?.hits?.length) continue;
    for (const hit of diag.stages.provider.hits) {
      const pairFile = path.join(baseDir, hit.file);
      try {
        const rep = await replayPair(pairFile, anthReq);
        results.push({ rid, drop: path.basename(drop), ...rep });
      } catch (e) {
        results.push({ rid, drop: path.basename(drop), pair: hit.file, error: String(e?.message || e) });
      }
    }
  }
  console.log(JSON.stringify({ count: results.length, sample: results.slice(0, 10) }, null, 2));
}

main().catch(e => { console.error('replay failed:', e); process.exit(1); });

