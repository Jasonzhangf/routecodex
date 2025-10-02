#!/usr/bin/env node
// Batch regression over failing samples with increasing trim rates in 5% steps.
// Uses GLMHTTPProvider directly (no server), real network call to GLM.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

async function importPreferSrc(relJs, relTs) {
  try {
    return await import(url.pathToFileURL(path.join(repoRoot, 'src', relTs)).href);
  } catch {
    return await import(url.pathToFileURL(path.join(repoRoot, 'dist', relJs)).href);
  }
}

function readJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
function listChatReq(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.startsWith('chat-req_') && f.endsWith('.json')).sort();
}

function buildManagerConfig(baseUrl, apiKey) {
  const pipelineId = 'glm_key1.glm-4.6';
  return {
    pipelines: [
      {
        id: pipelineId,
        provider: { type: 'glm-http-provider' },
        modules: {
          llmSwitch: { type: 'llmswitch-openai-openai', config: {} },
          compatibility: { type: 'glm-compatibility', config: { thinking: { enabled: true, payload: { type: 'enabled' } } } },
          workflow: { type: 'streaming-control', config: { streamingToNonStreaming: true } },
          provider: { type: 'glm-http-provider', config: { type: 'glm', baseUrl, auth: { type: 'apikey', apiKey } } }
        },
        settings: { debugEnabled: true }
      }
    ],
    settings: { debugLevel: 'basic', defaultTimeout: 60000, maxRetries: 0 }
  };
}

async function createManager(baseUrl, apiKey) {
  const { PipelineManager } = await importPreferSrc('modules/pipeline/core/pipeline-manager.js', 'modules/pipeline/core/pipeline-manager.ts');
  const cfg = buildManagerConfig(baseUrl, apiKey);
  const dummyError = { handleError: async () => {}, createContext: () => ({}), getStatistics: () => ({}) };
  const dummyDebug = { logDebug: () => {}, logError: () => {}, logModule: () => {}, processDebugEvent: () => {}, getLogs: () => [] };
  const manager = new PipelineManager(cfg, dummyError, dummyDebug);
  await manager.initialize();
  return manager;
}

async function runOne(manager, sampleDir, id) {
  try {
    const req = readJSON(path.join(sampleDir, `chat-req_${id}.json`));
    const body = JSON.parse(JSON.stringify(req.body || {}));
    body.stream = false; // unify
    // Remove GLM unsupported fields
    delete body.tools; delete body.tool_choice; delete body.response_format;
    const dto = {
      data: body,
      route: { providerId: 'glm_key1.glm-4', modelId: '6', requestId: req.requestId || `req_${Date.now()}`, timestamp: Date.now() },
      metadata: { origin: 'batch-trim' },
      debug: { enabled: true, stages: { llmSwitch: true, compatibility: true, provider: true, workflow: true } }
    };
    const resp = await manager.processRequest(dto);
    return { ok: true, data: resp.data };
  } catch (e) {
    return { ok: false, error: e?.message || String(e), status: e?.statusCode || e?.details?.upstreamStatus, details: e?.details };
  }
}

async function main() {
  const args = process.argv.slice(2);
  let ids = [];
  let dir = path.join(os.homedir(), '.routecodex', 'codex-samples');
  let baseUrl = process.env.GLM_BASE_URL || 'https://open.bigmodel.cn/api/coding/paas/v4';
  const apiKey = process.env.GLM_API_KEY || process.env.ZHIPUAI_API_KEY || process.env.ZHIPU_API_KEY || '';
  let max = 0;
  for (let i=0;i<args.length;i++) {
    const a = args[i];
    if (a === '--ids') ids = args[++i].split(',').map(s=>s.trim()).filter(Boolean);
    else if (a === '--dir') dir = args[++i];
    else if (a === '--max') max = parseInt(args[++i]||'0',10)||0;
    else if (a === '--base') baseUrl = args[++i];
  }
  if (!apiKey) { console.error('Missing GLM_API_KEY'); process.exit(2); }

  if (!ids.length) {
    // fallback: pick latest <= max chat-req ids
    const files = listChatReq(dir);
    const pick = max>0 ? files.slice(-max) : files.slice(-10);
    ids = pick.map(f => f.replace(/^chat-req_|\.json$/g,''));
  }

  const manager = await createManager(baseUrl, apiKey);

  // Trim rates in 5% steps: 0 (no trim), 5,10,15,20,25,30
  const steps = [0,5,10,15,20,25,30];
  const results = [];

  for (const trim of steps) {
    // Configure env for provider trimming
    if (trim === 0) {
      // No trimming: passthrough on
      process.env.RCC_GLM_PASSTHROUGH = '1';
      delete process.env.RCC_GLM_RETAIN_PERCENT;
    } else {
      delete process.env.RCC_GLM_PASSTHROUGH;
      const retain = Math.max(1, 100 - trim);
      process.env.RCC_GLM_RETAIN_PERCENT = String(retain);
    }

    let ok=0, fail=0; const perId=[];
    for (const id of ids) {
      const r = await runOne(manager, dir, id);
      if (r.ok) { ok++; }
      else { fail++; }
      perId.push({ id, ok: r.ok, status: r.status||null, error: r.ok?null:r.error });
      await new Promise(r => setTimeout(r, 50));
    }
    results.push({ trimPercent: trim, ok, fail, details: perId });
    console.log(`Trim ${trim}% => ok=${ok} fail=${fail}`);
  }

  const outFile = path.join(dir, `batch-trim-results_${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ ids, results }, null, 2));
  console.log(`Saved detailed results to ${outFile}`);
}

main().catch(e => { console.error('batch-trim-regress failed:', e); process.exit(1); });

