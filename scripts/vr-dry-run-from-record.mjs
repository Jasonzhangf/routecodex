#!/usr/bin/env node
// Virtual Router dry-run from recorded request
//
// Usage:
//   node scripts/vr-dry-run-from-record.mjs --record ~/.routecodex/monitor/sessions/<date>/<protocol>/<reqId>
//   node scripts/vr-dry-run-from-record.mjs --request /path/to/request.json [--protocol openai|anthropic]
//   [--config /path/to/user-config.json]
//   [--assert]

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

function parseArgs() {
  const out = { record: '', request: '', protocol: '', config: '', assert: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--record' || a === '-r') && argv[i+1]) { out.record = argv[++i]; continue; }
    if ((a === '--request' || a === '-q') && argv[i+1]) { out.request = argv[++i]; continue; }
    if ((a === '--protocol' || a === '-p') && argv[i+1]) { out.protocol = argv[++i]; continue; }
    if ((a === '--config' || a === '-c') && argv[i+1]) { out.config = argv[++i]; continue; }
    if (a === '--assert') { out.assert = true; continue; }
  }
  if (!out.record && !out.request) throw new Error('Usage: --record <dir> or --request <file>');
  return out;
}

function resolveFromRepo(rel) {
  const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
  const p1 = path.resolve(__dirname, '..', rel);
  if (fs.existsSync(p1)) return p1;
  return path.resolve(process.cwd(), rel);
}

async function importDist(rel) {
  const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
  const modPath = path.resolve(__dirname, '..', 'dist', rel);
  return await import(url.pathToFileURL(modPath).href);
}

function readJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

async function main() {
  const args = parseArgs();
  const modulesJson = resolveFromRepo('config/modules.json');
  if (!fs.existsSync(modulesJson)) throw new Error(`modules.json not found: ${modulesJson}`);
  const modulesConfig = readJSON(modulesJson);
  const classificationConfig = modulesConfig?.modules?.virtualrouter?.config?.classificationConfig;
  if (!classificationConfig) throw new Error('classificationConfig missing from config/modules.json');

  let protocol = args.protocol || 'openai';
  let request;
  let configuredTargets = {};

  if (args.record) {
    const base = path.resolve(args.record.replace(/^~\//, `${process.env.HOME || ''}/`));
    const metaPath = path.join(base, 'meta.json');
    const reqPath = path.join(base, 'request.json');
    if (!fs.existsSync(reqPath)) throw new Error(`record request missing: ${reqPath}`);
    try { const meta = readJSON(metaPath); protocol = meta?.protocol || protocol; } catch { /* ignore */ }
    request = readJSON(reqPath);
  } else {
    const reqFile = path.resolve(args.request.replace(/^~\//, `${process.env.HOME || ''}/`));
    if (!fs.existsSync(reqFile)) throw new Error(`request file not found: ${reqFile}`);
    request = readJSON(reqFile);
  }

  const userCfgPath = args.config ? path.resolve(args.config.replace(/^~\//, `${process.env.HOME || ''}/`)) : '';
  const userConfig = userCfgPath && fs.existsSync(userCfgPath) ? readJSON(userCfgPath) : null;
  if (userConfig) configuredTargets = (userConfig?.virtualrouter?.routing) || {};

  const { VirtualRouterDryRunExecutor } = await importDist('modules/virtual-router/virtual-router-dry-run.js');
  const exec = new VirtualRouterDryRunExecutor({ enabled: true, includeLoadBalancerDetails: true, includeHealthStatus: true, includeWeightCalculation: true, simulateProviderHealth: true });
  await exec.initialize({ classificationConfig, userConfig: userConfig || undefined });
  const endpoint = protocol === 'anthropic' ? '/v1/messages' : '/v1/chat/completions';
  const res = await exec.executeDryRun({ request, endpoint, protocol });

  const out = {
    protocol,
    route: res?.routingDecision?.route || 'default',
    confidence: res?.routingDecision?.confidence ?? null,
    alternativeRoutes: res?.routingDecision?.alternativeRoutes || [],
    configuredTargetsForRoute: configuredTargets[res?.routingDecision?.route || 'default'] || [],
    decision: res?.routingDecision || null,
  };
  console.log(JSON.stringify(out, null, 2));
  if (args.assert) {
    const ok = Array.isArray(out.configuredTargetsForRoute) && out.configuredTargetsForRoute.length > 0;
    process.exit(ok ? 0 : 3);
  }
}

main().catch((e) => { console.error('vr-dry-run-from-record failed:', e?.message || e); process.exit(1); });

