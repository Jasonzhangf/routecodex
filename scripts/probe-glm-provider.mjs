#!/usr/bin/env node
// Probe GLM provider directly (bypass server/pipeline) to disambiguate auth vs payload issues.
// Usage:
//   node scripts/probe-glm-provider.mjs [--config ~/.routecodex/config/glm-5520.json]
// Env:
//   GLM_API_KEY, GLM_BASE_URL can override values from config file.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      args[k] = v ?? true;
    } else { args._.push(a); }
  }
  return args;
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

async function importDist(rel) {
  const p = path.join(repoRoot, 'dist', rel);
  return await import(url.pathToFileURL(p).href);
}

function findGLMInConfig(cfg) {
  try {
    const provs = cfg?.virtualrouter?.providers || {};
    const keys = Object.keys(provs);
    const id = keys.find(k => k.toLowerCase().includes('glm')) || keys[0];
    const p = provs[id] || {};
    const baseUrl = process.env.GLM_BASE_URL || p.baseURL || p.baseUrl || 'https://open.bigmodel.cn/api/coding/paas/v4';
    const apiKey = process.env.GLM_API_KEY || (Array.isArray(p.apiKey) ? p.apiKey[0] : (p.apiKey || ''));
    const model = Object.keys(p.models || {})[0] || 'glm-4';
    return { baseUrl, apiKey, model };
  } catch { return { baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', apiKey: '', model: 'glm-4' }; }
}

async function main() {
  const args = parseArgs(process.argv);
  const configPath = (args.config || path.join(process.env.HOME || '', '.routecodex', 'config', 'glm-5520.json'));
  if (!fs.existsSync(configPath)) {
    console.error(`Config not found: ${configPath}`);
    process.exit(2);
  }
  const cfg = readJson(configPath);
  const { baseUrl, apiKey, model } = findGLMInConfig(cfg);
  if (!apiKey) {
    console.error('Missing API key. Set GLM_API_KEY env or provide apiKey in config.');
    process.exit(3);
  }

  const { GLMHTTPProvider } = await importDist('modules/pipeline/modules/provider/glm-http-provider.js');
  const dummy = { logDebug:()=>{}, logError:()=>{}, logModule:()=>{}, processDebugEvent:()=>{}, getLogs:()=>[] };
  const loggerMod = await importDist('modules/pipeline/utils/debug-logger.js');
  const logger = new loggerMod.PipelineDebugLogger({ processDebugEvent: () => {} }, { enableConsoleLogging: true, logLevel: 'basic' });
  const provider = new GLMHTTPProvider({ type: 'glm-http-provider', config: { baseUrl, auth: { type: 'apikey', apiKey } } }, { logger, debugCenter: dummy, errorHandlingCenter: { handleError: async()=>{}, createContext:()=>({}) } });
  await provider.initialize();

  // Minimal OpenAI-style chat body (no tools) to avoid schema issues masking auth
  const body = {
    model,
    messages: [ { role: 'user', content: 'hello from provider probe' } ],
    stream: false
  };

  try {
    const resp = await provider.sendRequest(body);
    console.log(JSON.stringify({ ok: true, status: resp.status, model, snippet: (resp.data?.choices?.[0]?.message?.content || '').slice(0, 80) }, null, 2));
  } catch (e) {
    const status = e?.statusCode || e?.details?.upstreamStatus || null;
    console.error(JSON.stringify({ ok: false, status, message: e?.message || String(e), details: e?.details || null, model }, null, 2));
    process.exit(1);
  }
}

main().catch(e => { console.error('probe failed:', e); process.exit(1); });

