#!/usr/bin/env node
// Regress a failing sample by running core converter with DTO carrying debug.request (tools schema)
// Usage: node scripts/regress-core-conversion.mjs anth_<rid>

import fs from 'fs/promises';
import path from 'path';

const rid = process.argv[2];
if (!rid || !rid.startsWith('anth_')) {
  console.error('Usage: node scripts/regress-core-conversion.mjs anth_<rid>');
  process.exit(1);
}

const home = process.env.HOME || process.env.USERPROFILE || '';
const baseDir = path.join(home, '.routecodex', 'codex-samples', 'anth-replay');

async function readJson(p) { return JSON.parse(await fs.readFile(p, 'utf8')); }

async function findFile(prefix, contains) {
  const names = await fs.readdir(baseDir);
  const list = names.filter(n => n.startsWith(prefix) && (!contains || n.includes(contains)))
    .map(n => ({ name: n, full: path.join(baseDir, n) }));
  if (!list.length) return null;
  // choose latest by mtime
  const stats = await Promise.all(list.map(async it => ({ ...it, st: await fs.stat(it.full) })));
  stats.sort((a,b) => b.st.mtimeMs - a.st.mtimeMs);
  return stats[0].full;
}

async function main() {
  const anthReqFile = await findFile('anthropic-request-', rid);
  if (!anthReqFile) throw new Error('anthropic-request file not found for ' + rid);
  const diagFile = await findFile('drop-diagnosis-', rid);
  const diag = diagFile ? await readJson(diagFile) : null;
  let pairFile = null;
  if (diag?.stages?.provider?.hits?.length) {
    pairFile = path.join(baseDir, diag.stages.provider.hits[0].file);
  }
  if (!pairFile) {
    // fallback to latest provider pair
    pairFile = await findFile('openai-provider-pair_', '');
  }
  if (!pairFile) throw new Error('provider pair not found');

  const anthReq = await readJson(anthReqFile);
  const pair = await readJson(pairFile);

  let AnthropicOpenAIConverter;
  try {
    const core = await import('@routecodex/pipeline-core');
    AnthropicOpenAIConverter = core.AnthropicOpenAIConverter;
  } catch {
    const local = path.resolve('sharedmodule/pipeline-core/dist/modules/llmswitch/llmswitch-anthropic-openai.js');
    AnthropicOpenAIConverter = (await import(local)).AnthropicOpenAIConverter;
  }
  const logger = { logModule() {}, logTransformation() {}, logProviderRequest() {} };
  const conv = new AnthropicOpenAIConverter({ type: 'llmswitch-anthropic-openai', config: { enableTools: true, enableStreaming: false, trustSchema: true } }, { logger });
  await conv.initialize();

  // Build DTO carrying current request as debug.request
  const dto = {
    data: pair.response,
    metadata: { pipelineId: 'test', processingTime: 0, stages: [], requestId: rid },
    debug: { request: anthReq.data }
  };
  const out = await conv.processOutgoing(dto);
  const content = Array.isArray(out?.data?.content) ? out.data.content : (Array.isArray(out?.content) ? out.content : []);
  const tus = content.filter(b => b && b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, input_keys: b.input && typeof b.input === 'object' ? Object.keys(b.input) : [] }));
  console.log(JSON.stringify({ rid, anth_req_file: path.basename(anthReqFile), provider_pair_file: path.basename(pairFile), tool_use: tus }, null, 2));
}

main().catch(e => { console.error('regress error:', e.message); process.exit(1); });
