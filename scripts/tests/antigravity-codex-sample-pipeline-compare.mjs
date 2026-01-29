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
  if (diffs.length >= 40) return diffs;
  if (a === b) return diffs;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') {
    diffs.push(prefix || '(root)');
    return diffs;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (diffs.length >= 40) break;
    diffPaths(a[key], b[key], prefix ? `${prefix}.${key}` : key, diffs);
  }
  return diffs;
}

async function runPipeline(distRoot, sampleDoc, configPath, outputLabel) {
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

  const payload = extractResponsesBody(sampleDoc);
  if (!payload || typeof payload !== 'object') {
    throw new Error(`[${outputLabel}] sample did not contain a JSON request body`);
  }

  const requestId = sampleDoc?.requestId || `dryrun_${Date.now()}_${outputLabel}`;
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
      processMode: 'passthrough'
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
    throw new Error(`[${outputLabel}] HubPipeline did not produce providerPayload`);
  }

  const target = result?.target || {};
  const providerKey = target.providerKey || '';
  const runtime = (artifacts?.targetRuntime && providerKey && artifacts.targetRuntime[providerKey]) || null;
  if (!runtime) {
    throw new Error(`[${outputLabel}] missing runtime config for providerKey=${providerKey}`);
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

  return {
    providerPayload,
    finalizedPayload,
    target
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const samplePath = args.sample || args._[0];
  if (!samplePath) throw new Error('Missing --sample <file.json>');

  const configPath = args.config || path.join(os.homedir(), '.routecodex', 'config.json');
  const outDir = args.out || path.join(process.cwd(), 'test-results', 'antigravity-pipeline-compare');
  fs.mkdirSync(outDir, { recursive: true });

  const leftDist = args.leftDist || path.join(process.cwd(), 'dist');
  const rightDist = args.rightDist || '/opt/homebrew/lib/node_modules/@jsonstudio/rcc/dist';

  const sampleDoc = readJson(samplePath);
  const left = await runPipeline(leftDist, sampleDoc, configPath, 'left');
  const right = await runPipeline(rightDist, sampleDoc, configPath, 'right');

  const dropKeys = new Set(['requestId', 'metadata', 'action', 'session_id', 'sessionId']);
  const normalizedLeft = sortKeys(stripVolatile(left.finalizedPayload, dropKeys));
  const normalizedRight = sortKeys(stripVolatile(right.finalizedPayload, dropKeys));

  const leftOut = path.join(outDir, 'left.finalized.json');
  const rightOut = path.join(outDir, 'right.finalized.json');
  fs.writeFileSync(leftOut, JSON.stringify(left.finalizedPayload, null, 2));
  fs.writeFileSync(rightOut, JSON.stringify(right.finalizedPayload, null, 2));

  if (!deepEqual(normalizedLeft, normalizedRight)) {
    const diff = diffPaths(normalizedLeft, normalizedRight);
    const diffPath = path.join(outDir, 'diff.json');
    fs.writeFileSync(diffPath, JSON.stringify({ diff }, null, 2));
    throw new Error(`pipeline mismatch; diff saved to ${diffPath}`);
  }

  console.log('[pipeline-compare] ok');
  console.log('  sample:', samplePath);
  console.log('  left dist:', leftDist);
  console.log('  right dist:', rightDist);
  console.log('  left out:', leftOut);
  console.log('  right out:', rightOut);
}

main().catch((err) => {
  console.error('[pipeline-compare] failed:', err?.message || err);
  process.exit(1);
});
