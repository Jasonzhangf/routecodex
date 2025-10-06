#!/usr/bin/env node
// A/B test GLM via OpenAI SDK provider (openai-provider) with/without history trimming

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { repoRootFrom, listFiles as listFilesUtil, readJSON } from './lib/utils.mjs';
import url from 'node:url';

const repoRoot = repoRootFrom(import.meta.url);

function listFiles(dir, prefix) {
  return listFilesUtil(dir, { prefix, suffix: '.json' });
}

async function importPreferSrc(relJs, relTs) {
  try {
    const p = path.join(repoRoot, 'src', relTs);
    return await import(url.pathToFileURL(p).href);
  } catch {
    const p = path.join(repoRoot, 'dist', relJs);
    return await import(url.pathToFileURL(p).href);
  }
}

function buildManagerConfig(baseUrl, apiKey) {
  const pipelineId = 'glm_openai.glm-4.6';
  return {
    pipelines: [
      {
        id: pipelineId,
        provider: { type: 'openai-provider' },
        modules: {
          llmSwitch: { type: 'llmswitch-openai-openai', config: {} },
          compatibility: { type: 'glm-compatibility', config: { thinking: { enabled: true, payload: { type: 'enabled' } } } },
          workflow: { type: 'streaming-control', config: { streamingToNonStreaming: true } },
          provider: { type: 'openai-provider', config: { type: 'glm', baseUrl, auth: { type: 'apikey', apiKey } } }
        },
        settings: { debugEnabled: true }
      }
    ],
    settings: { debugLevel: 'basic', defaultTimeout: 60000, maxRetries: 0 }
  };
}

function trimMessages(messages, maxN) {
  if (!Array.isArray(messages)) return [];
  const system = messages.find(m => m && m.role === 'system');
  const rest = messages.filter(m => m && m.role !== 'system');
  const tail = rest.slice(Math.max(0, rest.length - maxN));
  return system ? [system, ...tail] : tail;
}

async function createManager(baseUrl, apiKey) {
  const { PipelineManager } = await importPreferSrc('modules/pipeline/core/pipeline-manager.js', 'modules/pipeline/core/pipeline-manager.ts');
  const managerConfig = buildManagerConfig(baseUrl, apiKey);
  const dummyError = { handleError: async () => {}, createContext: () => ({}), getStatistics: () => ({}) };
  const dummyDebug = { logDebug: () => {}, logError: () => {}, logModule: () => {}, processDebugEvent: () => {}, getLogs: () => [] };
  const manager = new PipelineManager(managerConfig, dummyError, dummyDebug);
  await manager.initialize();
  return manager;
}

async function runOne(manager, sampleReq, route, options) {
  const body = JSON.parse(JSON.stringify(sampleReq.body || {}));
  body.stream = false;
  if (options.trimN && options.trimN > 0 && Array.isArray(body.messages)) {
    body.messages = trimMessages(body.messages, options.trimN);
  }
  // Remove fields GLM doesn't accept when passing via OpenAI SDK
  delete body.tools; delete body.tool_choice; delete body.response_format;
  // Compose DTO
  const dto = {
    data: body,
    route: { providerId: route.providerId, modelId: route.modelId, requestId: sampleReq.requestId || `req_${Date.now()}`, timestamp: Date.now() },
    metadata: { source: 'ab-openai-glm' },
    debug: { enabled: true, stages: { llmSwitch: true, compatibility: true, provider: true, workflow: true } }
  };
  try {
    const resp = await manager.processRequest(dto);
    return { ok: true, data: resp.data };
  } catch (e) {
    return { ok: false, error: e?.message || String(e), details: e?.details };
  }
}

async function main() {
  const args = process.argv.slice(2);
  let max = 30, dir = path.join(os.homedir(), '.routecodex', 'codex-samples');
  let baseUrl = process.env.GLM_BASE_URL || 'https://open.bigmodel.cn/api/coding/paas/v4';
  const apiKey = process.env.GLM_API_KEY || process.env.ZHIPUAI_API_KEY || process.env.ZHIPU_API_KEY || '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dir') dir = args[++i];
    else if (a === '--max') max = parseInt(args[++i] || '30', 10) || 30;
    else if (a === '--base') baseUrl = args[++i];
  }
  if (!apiKey) {
    console.error('Missing GLM_API_KEY in environment');
    process.exit(2);
  }
  const chatFiles = listFiles(dir, 'chat-req_');
  if (chatFiles.length === 0) {
    console.error(`No chat-req_* found in ${dir}`);
    process.exit(0);
  }
  const pick = chatFiles.slice(-max);

  console.log(`Building pipeline manager (openai-provider -> ${baseUrl})...`);
  const manager = await createManager(baseUrl, apiKey);
  const route = { providerId: 'glm_openai', modelId: 'glm-4.6' };

  let pass1Ok = 0, pass1Fail = 0;
  console.log('\nPass A: no-trim (passthrough messages)');
  for (const f of pick) {
    const req = readJSON(f);
    const r = await runOne(manager, req, route, { trimN: 0 });
    if (r.ok) { pass1Ok++; console.log(`✓ ${path.basename(f)} ok`); }
    else { pass1Fail++; console.log(`✗ ${path.basename(f)} ${r.error || ''}`); }
  }
  console.log(`Pass A summary: ok=${pass1Ok} fail=${pass1Fail}`);

  let pass2Ok = 0, pass2Fail = 0;
  const trimN = parseInt(process.env.RCC_GLM_MAX_MSG || '60', 10) || 60;
  console.log(`\nPass B: trim last ${trimN} (preserve first system)`);
  for (const f of pick) {
    const req = readJSON(f);
    const r = await runOne(manager, req, route, { trimN });
    if (r.ok) { pass2Ok++; console.log(`✓ ${path.basename(f)} ok`); }
    else { pass2Fail++; console.log(`✗ ${path.basename(f)} ${r.error || ''}`); }
  }
  console.log(`Pass B summary: ok=${pass2Ok} fail=${pass2Fail}`);
}

main().catch(e => { console.error(e); process.exit(1); });
