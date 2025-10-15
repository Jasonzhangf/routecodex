#!/usr/bin/env node
// Probe our OpenAIProvider against a third-party OpenAI-compatible endpoint (e.g., GLM)
// Bypasses the server; validates endpoint+Authorization handling inside provider.
// Usage: node scripts/probe-openai-compat.mjs --config ~/.routecodex/config.json --model glm-4.6

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function parseArgs() {
  const out = { config: `${process.env.HOME || ''}/.routecodex/config.json`, model: 'glm-4.6' };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--config' || a === '-c') && argv[i+1]) { out.config = argv[++i]; continue; }
    if ((a === '--model' || a === '-m') && argv[i+1]) { out.model = argv[++i]; continue; }
  }
  return out;
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

async function importDist(rel) {
  return await import(url.pathToFileURL(path.join(repoRoot, 'dist', rel)).href);
}

function findCompatProvider(cfg) {
  const provs = cfg?.virtualrouter?.providers || {};
  const pick = Object.entries(provs).find(([id, p]) => /bigmodel\.cn/i.test(String(p?.baseURL || p?.baseUrl || '')))
           || Object.entries(provs).find(([id, p]) => String(id).toLowerCase().includes('glm'))
           || Object.entries(provs)[0];
  if (!pick) return null;
  const [id, p] = pick;
  const baseUrl = p?.baseURL || p?.baseUrl;
  let apiKey = p?.auth?.apiKey || (Array.isArray(p?.apiKey) ? p.apiKey[0] : p?.apiKey);
  if (!apiKey || /\*|REDACTED/i.test(String(apiKey))) {
    apiKey = process.env.GLM_API_KEY || process.env.ROUTECODEX_API_KEY || process.env.OPENAI_API_KEY || '';
  }
  return { baseUrl, apiKey };
}

async function main() {
  const args = parseArgs();
  if (!fs.existsSync(args.config)) {
    console.error(JSON.stringify({ ok:false, error:`Config not found: ${args.config}` }));
    process.exit(2);
  }
  const cfg = readJson(args.config);
  const prov = findCompatProvider(cfg);
  if (!prov || !prov.baseUrl) {
    console.error(JSON.stringify({ ok:false, error:'No compatible provider found in config (need baseUrl)' }));
    process.exit(2);
  }
  if (!prov.apiKey) {
    console.error(JSON.stringify({ ok:false, error:'Missing apiKey (set in config or GLM_API_KEY env)' }));
    process.exit(2);
  }

  const { OpenAIProvider } = await importDist('modules/pipeline/modules/provider/openai-provider.js');
  const { PipelineDebugLogger } = await importDist('modules/pipeline/utils/debug-logger.js');
  const logger = new PipelineDebugLogger({ processDebugEvent:()=>{} });
  const dummyEC = { handleError: async()=>{}, createContext:()=>({}) };
  const provider = new OpenAIProvider({ type:'openai-provider', config:{ baseUrl: prov.baseUrl, auth:{ type:'apikey', apiKey: prov.apiKey } } }, { logger, debugCenter: {}, errorHandlingCenter: dummyEC });
  await provider.initialize();

  const body = { model: args.model, messages:[{ role:'user', content:'ping from compat-probe' }], stream:false };
  try {
    const resp = await provider.sendRequest(body);
    const text = (resp?.data?.choices?.[0]?.message?.content || '').slice(0, 120);
    console.log(JSON.stringify({ ok:true, status: resp?.status, endpoint: prov.baseUrl, model: args.model, head:text }, null, 2));
  } catch (e) {
    const status = e?.statusCode || e?.details?.upstream?.status || null;
    console.error(JSON.stringify({ ok:false, status, error: e?.message || String(e) }, null, 2));
    process.exit(1);
  }
}

main().catch(e => { console.error(JSON.stringify({ ok:false, error:e?.message || String(e) })); process.exit(1); });

