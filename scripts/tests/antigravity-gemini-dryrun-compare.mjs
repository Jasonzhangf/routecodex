#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

process.env.ROUTECODEX_HUB_SNAPSHOTS = '0';
process.env.ROUTECODEX_SNAPSHOT = '0';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '1';
    out[key] = val;
  }
  return out;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function extractResponsesBody(sampleDoc) {
  const bodyNode = sampleDoc?.data?.body ?? sampleDoc?.body ?? sampleDoc;
  if (bodyNode && typeof bodyNode === 'object' && typeof bodyNode.body === 'object' && bodyNode.body) {
    return bodyNode.body;
  }
  if (bodyNode && typeof bodyNode === 'object') {
    return bodyNode;
  }
  return undefined;
}

function stripVolatile(value, dropKeys) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => stripVolatile(entry, dropKeys));
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (dropKeys.has(key)) continue;
    out[key] = stripVolatile(val, dropKeys);
  }
  return out;
}

function sortKeys(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = sortKeys(value[key]);
  }
  return out;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function diffPaths(a, b, prefix = '', diffs = []) {
  if (diffs.length >= 20) return diffs;
  if (a === b) return diffs;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') {
    diffs.push(prefix || '(root)');
    return diffs;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (diffs.length >= 20) break;
    diffPaths(a[key], b[key], prefix ? `${prefix}.${key}` : key, diffs);
  }
  return diffs;
}

async function main() {
  const args = parseArgs(process.argv);
  const samplePath = args.sample || args._[0];
  if (!samplePath) throw new Error('Missing --sample <file.json>');

  const baselinePath = args.baseline || args._[1];
  if (!baselinePath) throw new Error('Missing --baseline <provider-request.json>');

  const configPath = args.config || path.join(os.homedir(), '.routecodex', 'config.json');
  const outDir = args.out || path.join(process.cwd(), 'test-results', 'antigravity-gemini-dryrun');
  fs.mkdirSync(outDir, { recursive: true });

  const distRoot = path.join(process.cwd(), 'dist');
  const bridgeUrl = pathToFileURL(path.join(distRoot, 'modules', 'llmswitch', 'bridge.js')).href;
  const loaderUrl = pathToFileURL(path.join(distRoot, 'config', 'routecodex-config-loader.js')).href;
  const metaUrl = pathToFileURL(path.join(distRoot, 'server', 'runtime', 'http-server', 'executor-metadata.js')).href;
  const harnessUrl = pathToFileURL(path.join(distRoot, 'debug', 'harnesses', 'provider-harness.js')).href;

  const bridge = await import(bridgeUrl);
  const loader = await import(loaderUrl);
  const meta = await import(metaUrl);
  const harness = await import(harnessUrl);

  const loaded = await loader.loadRouteCodexConfig(configPath);
  const userConfig = loaded?.userConfig || {};
  const artifacts = await bridge.bootstrapVirtualRouterConfig(userConfig.virtualrouter || userConfig.virtualRouter || {});
  const virtualRouter = artifacts?.config || artifacts;
  const HubPipelineCtor = await bridge.getHubPipelineCtor();
  const pipeline = new HubPipelineCtor({ virtualRouter });

  const sampleDoc = readJson(samplePath);
  const payload = extractResponsesBody(sampleDoc);
  if (!payload || typeof payload !== 'object') throw new Error('Sample did not contain a JSON request body');

  const requestId = sampleDoc?.requestId || `dryrun_${Date.now()}`;
  const input = {
    entryEndpoint: sampleDoc?.endpoint || '/v1/responses',
    method: 'POST',
    requestId,
    headers: sampleDoc?.headers || {},
    query: {},
    body: payload,
    metadata: {
      stream: payload?.stream === true,
      providerProtocol: 'openai-responses',
      // Avoid servertool/tool injection during dry-run compare.
      processMode: args.processMode || 'passthrough'
    }
  };
  const metadata = meta.buildRequestMetadata(input);
  const result = await pipeline.execute({
    id: requestId,
    endpoint: input.entryEndpoint,
    payload,
    metadata
  });

  const providerPayload = result?.providerPayload;
  if (!providerPayload || typeof providerPayload !== 'object') {
    throw new Error('HubPipeline did not produce providerPayload');
  }

  const target = result?.target || {};
  const providerKey = target.providerKey || '';
  const runtime = (artifacts?.targetRuntime && providerKey && artifacts.targetRuntime[providerKey]) || null;
  if (!runtime) {
    throw new Error(`Missing runtime config for providerKey=${providerKey}`);
  }
  const providerIdHint = runtime.providerId || providerKey.split('.')[0];
  const profile = loaded?.providerProfiles?.byId?.[providerIdHint];
  if (profile?.moduleType) {
    runtime.providerModule = profile.moduleType;
  }
  const routeName = result?.routingDecision?.routeName || 'default';
  const ProviderPreprocessHarness = harness.ProviderPreprocessHarness;
  const preprocessHarness = new ProviderPreprocessHarness();
  const preprocessResult = await preprocessHarness.executeForward({
    runtime,
    request: providerPayload,
    metadata: {
      requestId,
      providerId: providerIdHint,
      providerKey,
      providerType: runtime.providerType || target.providerType,
      providerProtocol: target.outboundProfile || runtime.outboundProfile || target.providerProtocol || 'gemini-chat',
      routeName,
      target: {
        providerKey,
        providerType: runtime.providerType || target.providerType,
        providerProtocol: target.outboundProfile || runtime.outboundProfile || target.providerProtocol,
        runtimeKey: runtime.runtimeKey || target.runtimeKey,
        routeName,
        compatibilityProfile: runtime.compatibilityProfile || target.compatibilityProfile
      },
      compatibilityProfile: runtime.compatibilityProfile || target.compatibilityProfile
    }
  });
  const finalizedPayload =
    preprocessResult?.payload && typeof preprocessResult.payload === 'object'
      ? preprocessResult.payload
      : providerPayload;

  const outPayloadPath = path.join(outDir, `${requestId}.provider-payload.json`);
  fs.writeFileSync(outPayloadPath, JSON.stringify(finalizedPayload, null, 2));

  const baselineDoc = readJson(baselinePath);
  const baselineBody = baselineDoc?.body || baselineDoc;

  const requiredTopKeys = ['request'];
  for (const key of requiredTopKeys) {
    if (!(key in providerPayload)) {
      throw new Error(`providerPayload missing required top-level key: ${key}`);
    }
  }

  const forbiddenTopKeys = ['contents', 'systemInstruction', 'tools', 'toolConfig', 'generationConfig', 'safetySettings'];
  for (const key of forbiddenTopKeys) {
    if (key in providerPayload) {
      throw new Error(`providerPayload leaked ${key} at top-level (should be under request)`);
    }
  }

  const dropKeys = new Set(['requestId', 'metadata', 'action']);
  const normalizedActual = sortKeys(stripVolatile(finalizedPayload, dropKeys));
  const normalizedBaseline = sortKeys(stripVolatile(baselineBody, dropKeys));

  if (!deepEqual(normalizedActual, normalizedBaseline)) {
    const diff = diffPaths(normalizedActual, normalizedBaseline);
    const diffPath = path.join(outDir, `${requestId}.diff.json`);
    fs.writeFileSync(diffPath, JSON.stringify({ diff }, null, 2));
    throw new Error(`providerPayload mismatch; diff saved to ${diffPath}`);
  }

  console.log('[dryrun-compare] ok');
  console.log('  sample:', samplePath);
  console.log('  baseline:', baselinePath);
  console.log('  output:', outPayloadPath);
}

main().catch((err) => {
  console.error('[dryrun-compare] failed:', err?.message || err);
  process.exit(1);
});
