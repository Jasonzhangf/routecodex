#!/usr/bin/env node
/**
 * Dry-run Responses golden samples via debug toolkit (no upstream calls).
 *
 * Usage:
 *   node scripts/tools/responses-golden-dry-run.mjs \
 *     --dir ~/.routecodex/golden_samples/responses/2025-11-23T04-51-48-919Z \
 *     --config ~/.routecodex/provider/c4m/config.v1.json \
 *     --target c4m.gpt-5.1
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

function usage(err) {
  const msg = err ? `❌ ${err}\n` : '';
  console.log(`${msg}Usage: node scripts/tools/responses-golden-dry-run.mjs --dir <path> [--config path] [--target provider.model] [--session id]`);
  process.exit(err ? 1 : 0);
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = {
    dir: null,
    config: path.join(os.homedir(), '.routecodex', 'provider', 'c4m', 'config.v1.json'),
    target: 'c4m.gpt-5.1',
    session: null
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dir') opts.dir = argv[++i];
    else if (arg === '--config') opts.config = argv[++i];
    else if (arg === '--target') opts.target = argv[++i];
    else if (arg === '--session') opts.session = argv[++i];
    else if (arg === '--help' || arg === '-h') usage();
    else usage(`Unknown argument: ${arg}`);
  }
  if (!opts.dir) usage('Missing --dir pointing to golden_samples/responses/<timestamp>');
  return opts;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function clone(value) {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(value);
  }
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

function resolveProviderRuntime(configPath, target) {
  const cfg = readJson(configPath);
  const [providerId, modelId = 'gpt-5.1'] = target.split('.');
  const providerDef = cfg?.virtualrouter?.providers?.[providerId];
  if (!providerDef) throw new Error(`Provider "${providerId}" not found in ${configPath}`);
  const auth = providerDef.auth || {};
  const apiKey = auth.apiKey || auth.value || process.env.C4M_API_KEY || process.env.RCC_PROVIDER_KEY;
  if (!apiKey) throw new Error(`Missing API key for ${providerId} (set in config or env)`);
  return {
    runtimeKey: `${providerId}.golden.${Date.now()}`,
    providerId,
    providerKey: `${providerId}.golden`,
    keyAlias: 'golden',
    providerType: (providerDef.type || 'responses').toLowerCase(),
    endpoint: providerDef.baseURL || providerDef.baseUrl || providerDef.endpoint || 'https://api.example.net/v1',
    auth: { type: 'apikey', value: apiKey },
    compatibilityProfile: providerDef.compat || 'default',
    outboundProfile: 'openai-responses',
    defaultModel: modelId
  };
}

function buildMetadata(runtime, requestId, entryEndpoint, stream) {
  return {
    requestId,
    providerId: runtime.providerId,
    providerKey: runtime.providerKey,
    providerType: runtime.providerType,
    providerProtocol: 'openai-responses',
    routeName: 'golden',
    target: {
      providerKey: `${runtime.providerId}.${runtime.keyAlias}.${runtime.defaultModel}`,
      providerType: runtime.providerType,
      compatibilityProfile: runtime.compatibilityProfile,
      runtimeKey: runtime.runtimeKey,
      modelId: runtime.defaultModel
    },
    metadata: {
      stream,
      entryEndpoint
    }
  };
}

async function main() {
  const options = parseArgs();
  if (!fs.existsSync(options.dir)) usage(`Directory not found: ${options.dir}`);
  const goldenFile = path.join(options.dir, 'golden-samples.json');
  if (!fs.existsSync(goldenFile)) usage(`golden-samples.json not found under ${options.dir}`);

  const report = readJson(goldenFile);
  const samples = Array.isArray(report.samples) ? report.samples : [];
  if (!samples.length) usage('golden-samples.json has no "samples" entries');

  const runtime = resolveProviderRuntime(options.config, options.target);
  const { createDebugToolkit } = await import(
    pathToFileURL(path.join(ROOT, 'dist/debug/index.js')).href
  );
  const toolkit = createDebugToolkit({ snapshotDirectory: path.join(ROOT, 'logs', 'debug') });
  const sessionId = options.session || `golden-${Date.now()}`;

  console.log(`[golden-dry-run] session=${sessionId} samples=${samples.length}`);
  for (const [index, sample] of samples.entries()) {
    const payload = sample?.request;
    if (!payload || typeof payload !== 'object') {
      console.warn(` - skip sample[${index}] ${sample?.name || 'unnamed'} (missing request)`);
      continue;
    }
    const cloned = clone(payload);
    if (!cloned.model) cloned.model = runtime.defaultModel;
    const providerRequest = {
      data: cloned,
      metadata: {
        entryEndpoint: '/v1/responses',
        stream: cloned.stream === true
      }
    };
    const metadata = buildMetadata(runtime, `golden-${index}-${Date.now()}`, '/v1/responses', cloned.stream === true);
    const result = await toolkit.dryRunner.runProviderPreprocess({
      runtime,
      request: providerRequest,
      metadata,
      sessionId,
      nodeId: `golden.${index}`
    });
    const body = result.processed?.data || result.processed;
    const outPath = path.join(options.dir, `dryrun-${index + 1}.json`);
    fs.writeFileSync(outPath, JSON.stringify(body, null, 2));
    console.log(` - sample[${index}] ${sample?.name || 'unnamed'} → ${outPath}`);
  }
}

main().catch((error) => {
  console.error('[responses-golden-dry-run] failed:', error);
  process.exit(1);
});
