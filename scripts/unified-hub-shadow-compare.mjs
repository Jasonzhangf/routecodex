#!/usr/bin/env node
/**
 * Unified Hub Framework V1 – Black-box shadow compare
 *
 * Runs the llmswitch-core HubPipeline twice (baseline vs candidate) on the same
 * input payload and diffs providerPayload + key metadata.
 *
 * This is the gating tool for gradual rollout:
 *   off → shadow(observe) → enforce → widen
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

function resolveErrorSamplesRoot() {
  const envOverride =
    process.env.ROUTECODEX_ERRORSAMPLES_DIR ||
    process.env.ROUTECODEX_ERROR_SAMPLES_DIR;
  if (envOverride && String(envOverride).trim()) {
    return path.resolve(String(envOverride).trim());
  }
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(home, '.routecodex', 'errorsamples');
}

function ensureDirSync(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
}

function usage() {
  console.log(`Usage:
  node scripts/unified-hub-shadow-compare.mjs --request <file.json> [options]

Options:
  --request <file.json>             can be a raw request body JSON OR a codex-samples client-request.json
  --entry-endpoint <path>        default: /v1/chat/completions
  --route-hint <name>            optional: select route (default/openai/responses/anthropic/gemini)
  --baseline-mode <off|observe|enforce>  default: off
  --candidate-mode <off|observe|enforce> default: observe
  --help                         show help
`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    entryEndpoint: '/v1/chat/completions',
    baselineMode: 'off',
    candidateMode: 'observe',
    routeHint: undefined
  };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--request') opts.request = args[++i];
    else if (a === '--entry-endpoint') opts.entryEndpoint = args[++i];
    else if (a === '--route-hint') opts.routeHint = args[++i];
    else if (a === '--baseline-mode') opts.baselineMode = args[++i];
    else if (a === '--candidate-mode') opts.candidateMode = args[++i];
    else if (a === '--help' || a === '-h') {
      usage();
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      usage();
      process.exit(2);
    }
  }
  if (!opts.request) {
    usage();
    process.exit(2);
  }
  return opts;
}

function normalizeEntryProviderProtocol(entryEndpoint) {
  const lowered = String(entryEndpoint || '').toLowerCase();
  if (lowered.includes('/v1/responses')) return 'openai-responses';
  if (lowered.includes('/v1/messages')) return 'anthropic-messages';
  return 'openai-chat';
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}

function extractEndpointFromSample(doc) {
  return doc?.data?.url || doc?.url || doc?.endpoint || undefined;
}

function extractRouteHintFromSample(doc) {
  const headers = doc?.headers;
  if (!headers || typeof headers !== 'object') return undefined;
  const hint = headers['X-Route-Hint'] || headers['x-route-hint'];
  return typeof hint === 'string' && hint.trim() ? hint.trim() : undefined;
}

function extractBodyFromSample(doc) {
  // Keep in sync with scripts/replay-codex-sample.mjs
  const bodyNode = doc?.data?.body || doc?.body;
  if (!bodyNode) {
    if (typeof doc?.data?.data === 'object') return doc.data.data;
    if (typeof doc?.body?.data === 'object') return doc.body.data;
    return undefined;
  }
  if (typeof bodyNode?.body === 'object') return bodyNode.body;
  if (typeof bodyNode === 'object') return bodyNode;
  if (typeof doc?.data?.data === 'object') return doc.data.data;
  if (typeof doc?.body?.data === 'object') return doc.body.data;
  return undefined;
}

function readRequestPayloadAndHints(file) {
  const doc = readJson(file);
  const extracted = extractBodyFromSample(doc);
  return {
    payload: extracted && typeof extracted === 'object' ? extracted : doc,
    entryEndpoint: extractEndpointFromSample(doc),
    routeHint: extractRouteHintFromSample(doc)
  };
}

function stableStringify(value) {
  return JSON.stringify(
    value,
    (key, val) => {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        const out = {};
        for (const k of Object.keys(val).sort()) {
          out[k] = val[k];
        }
        return out;
      }
      return val;
    },
    2
  );
}

function cloneJsonSafe(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function diffPayloads(expected, actual, p = '<root>') {
  if (Object.is(expected, actual)) return [];
  if (typeof expected !== typeof actual) {
    return [{ path: p, expected, actual }];
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const max = Math.max(expected.length, actual.length);
    const diffs = [];
    for (let i = 0; i < max; i += 1) {
      diffs.push(...diffPayloads(expected[i], actual[i], `${p}[${i}]`));
    }
    return diffs;
  }
  if (expected && typeof expected === 'object' && actual && typeof actual === 'object') {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    const diffs = [];
    for (const key of keys) {
      const next = p === '<root>' ? key : `${p}.${key}`;
      if (!(key in actual)) diffs.push({ path: next, expected: expected[key], actual: undefined });
      else if (!(key in expected)) diffs.push({ path: next, expected: undefined, actual: actual[key] });
      else diffs.push(...diffPayloads(expected[key], actual[key], next));
    }
    return diffs;
  }
  return [{ path: p, expected, actual }];
}

function buildVirtualRouterConfig() {
  // Minimal deterministic routes. We only need routing to select an outbound providerType/protocol.
  return {
    providers: {
      mockOpenai: {
        id: 'mockOpenai',
        enabled: true,
        type: 'openai',
        baseURL: 'mock://openai',
        auth: { type: 'apikey', apiKey: 'mock' },
        models: { 'gpt-test': {} }
      },
      mockResponses: {
        id: 'mockResponses',
        enabled: true,
        type: 'responses',
        baseURL: 'mock://responses',
        auth: { type: 'apikey', apiKey: 'mock' },
        models: { 'gpt-test': {} }
      },
      mockAnthropic: {
        id: 'mockAnthropic',
        enabled: true,
        type: 'anthropic',
        baseURL: 'mock://anthropic',
        auth: { type: 'apikey', apiKey: 'mock' },
        models: { 'gpt-test': {} }
      },
      mockGemini: {
        id: 'mockGemini',
        enabled: true,
        type: 'gemini',
        baseURL: 'mock://gemini',
        auth: { type: 'apikey', apiKey: 'mock' },
        models: { 'gpt-test': {} }
      }
    },
    routing: {
      default: [
        { id: 'default-primary', targets: ['mockOpenai.gpt-test'] }
      ],
      openai: [
        { id: 'openai-primary', targets: ['mockOpenai.gpt-test'] }
      ],
      responses: [
        { id: 'responses-primary', targets: ['mockResponses.gpt-test'] }
      ],
      anthropic: [
        { id: 'anthropic-primary', targets: ['mockAnthropic.gpt-test'] }
      ],
      gemini: [
        { id: 'gemini-primary', targets: ['mockGemini.gpt-test'] }
      ]
    }
  };
}

async function importHubPipelineCtor() {
  // Use the locally linked @jsonstudio/llms (symlinked to sharedmodule/llmswitch-core).
  const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
  const hubPath = path.join(repoRoot, 'sharedmodule', 'llmswitch-core', 'dist', 'conversion', 'hub', 'pipeline', 'hub-pipeline.js');
  const mod = await import(url.pathToFileURL(hubPath).href);
  if (typeof mod.HubPipeline !== 'function') {
    throw new Error('HubPipeline ctor not found in built llmswitch-core dist. Run `npm run llmswitch:build` or `cd sharedmodule/llmswitch-core && npm run build`.');
  }
  return mod.HubPipeline;
}

async function bootstrapVirtualRouterConfig(rawConfig) {
  const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
  const bootstrapPath = path.join(
    repoRoot,
    'sharedmodule',
    'llmswitch-core',
    'dist',
    'router',
    'virtual-router',
    'bootstrap.js'
  );
  const mod = await import(url.pathToFileURL(bootstrapPath).href);
  if (typeof mod.bootstrapVirtualRouterConfig !== 'function') {
    throw new Error('bootstrapVirtualRouterConfig not found in built llmswitch-core dist.');
  }
  return mod.bootstrapVirtualRouterConfig(rawConfig);
}

async function runOnce({ requestId, candidateMode, baselineMode, entryEndpoint, routeHint, payload }) {
  const HubPipeline = await importHubPipelineCtor();
  const artifacts = await bootstrapVirtualRouterConfig(buildVirtualRouterConfig());
  const pipeline = new HubPipeline({
    virtualRouter: artifacts.config,
    policy: { mode: candidateMode }
  });
  const providerProtocol = normalizeEntryProviderProtocol(entryEndpoint);
  const result = await pipeline.execute({
    id: requestId,
    endpoint: entryEndpoint,
    payload,
    metadata: {
      entryEndpoint,
      providerProtocol,
      routeHint,
      __hubShadowCompare: {
        baselineMode
      }
    }
  });
  return result;
}

function writeCompareErrorSample(opts) {
  const root = resolveErrorSamplesRoot();
  if (!root || !String(root).trim()) return;
  const dir = path.join(root, 'unified-hub-shadow');
  ensureDirSync(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `unified-hub-shadow-diff-${stamp}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(opts, null, 2), 'utf8');
    console.error(`[unified-hub-shadow-compare] wrote errorsample: ${file}`);
  } catch {
    // ignore
  }
}

async function main() {
  const opts = parseArgs();
  const loaded = readRequestPayloadAndHints(opts.request);
  const payload = loaded.payload;
  const entryEndpoint = String(opts.entryEndpoint || loaded.entryEndpoint || '/v1/chat/completions');
  const routeHint = opts.routeHint ? String(opts.routeHint) : (loaded.routeHint || undefined);
  const baselineMode = String(opts.baselineMode);
  const candidateMode = String(opts.candidateMode);
  const requestId = `shadow_unified_hub_${Date.now()}`;

  const candidate = await runOnce({ requestId, candidateMode, baselineMode, entryEndpoint, routeHint, payload });
  const shadow = candidate && candidate.metadata && typeof candidate.metadata === 'object'
    ? candidate.metadata.hubShadowCompare
    : undefined;
  const baselineProviderPayload =
    shadow && typeof shadow === 'object' && shadow && !Array.isArray(shadow)
      ? shadow.baselineProviderPayload
      : undefined;

  const baselineOut = {
    providerPayload: baselineProviderPayload,
    target: candidate.target,
    metadata: {
      entryEndpoint: candidate.metadata?.entryEndpoint,
      providerProtocol: candidate.metadata?.providerProtocol,
      processMode: candidate.metadata?.processMode,
      stream: candidate.metadata?.stream,
      routeHint: candidate.metadata?.routeHint
    }
  };
  const candidateOut = {
    providerPayload: candidate.providerPayload,
    target: candidate.target,
    metadata: {
      entryEndpoint: candidate.metadata?.entryEndpoint,
      providerProtocol: candidate.metadata?.providerProtocol,
      processMode: candidate.metadata?.processMode,
      stream: candidate.metadata?.stream,
      routeHint: candidate.metadata?.routeHint
    }
  };

  if (!baselineProviderPayload || typeof baselineProviderPayload !== 'object') {
    throw new Error('[unified-hub-shadow-compare] hubShadowCompare.baselineProviderPayload missing; ensure llmswitch-core is rebuilt.');
  }
  const diffs = diffPayloads(cloneJsonSafe(baselineOut), cloneJsonSafe(candidateOut));
  if (!diffs.length) {
    console.log('[unified-hub-shadow-compare] OK diff=0');
    return;
  }
  console.error(`[unified-hub-shadow-compare] DIFF count=${diffs.length} (showing first 80)`);
  diffs.slice(0, 80).forEach((d) => {
    console.error(`- ${d.path}`);
  });
  writeCompareErrorSample({
    kind: 'unified-hub-shadow-diff',
    timestamp: new Date().toISOString(),
    requestFile: path.resolve(opts.request),
    entryEndpoint,
    routeHint,
    baselineMode,
    candidateMode,
    diffCount: diffs.length,
    diffPaths: diffs.slice(0, 200).map((d) => d.path),
    baseline: baselineOut,
    candidate: candidateOut
  });
  console.error('\n--- baseline (stable) ---\n' + stableStringify(baselineOut));
  console.error('\n--- candidate (stable) ---\n' + stableStringify(candidateOut));
  process.exitCode = 1;
}

main().catch((err) => {
  console.error('[unified-hub-shadow-compare] failed:', err);
  process.exit(1);
});
