#!/usr/bin/env node
/**
 * Virtual Router health + error-handling simulator
 *
 *  - 复用 sharedmodule/llmswitch-core 的 VirtualRouterEngine/ProviderErrorCenter
 *  - 注入不同错误类型（429/401/400/5xx/timeout/...），观察熔断与调度行为
 *  - 输出 JSON summary 以及逐步日志，供集成测试 / dry-run 分析
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const CORE_DIST = path.join(ROOT, 'sharedmodule', 'llmswitch-core', 'dist', 'v2', 'router', 'virtual-router');

async function loadCoreModule(rel) {
  const file = path.join(CORE_DIST, rel);
  return import(pathToFileURL(file).href);
}

const { VirtualRouterEngine } = await loadCoreModule('engine.js');
const { providerErrorCenter } = await loadCoreModule('error-center.js');
const { VirtualRouterError } = await loadCoreModule('types.js');

function parseArgs(argv) {
  const args = { out: null };
  const list = [...argv];
  while (list.length) {
    const cur = list.shift();
    if (cur === '--out' || cur === '--output') {
      args.out = list.shift() || null;
    } else if (cur === '--help' || cur === '-h') {
      args.help = true;
    }
  }
  return args;
}

function buildProviderProfile(providerKey, endpoint) {
  return {
    providerKey,
    providerType: 'openai',
    endpoint,
    auth: { type: 'apiKey', secretRef: providerKey },
    outboundProfile: 'openai-chat',
    compatibilityProfile: 'compat:passthrough',
    defaultModel: 'sim-model'
  };
}

function createRouterConfig() {
  const providers = {
    'alpha.sim-model': buildProviderProfile('alpha.sim-model', 'https://alpha.local/v1'),
    'bravo.sim-model': buildProviderProfile('bravo.sim-model', 'https://bravo.local/v1'),
    'charlie.sim-model': buildProviderProfile('charlie.sim-model', 'https://charlie.local/v1')
  };
  const routing = {
    default: Object.keys(providers),
    coding: ['bravo.sim-model', 'charlie.sim-model'],
    thinking: ['charlie.sim-model', 'alpha.sim-model']
  };
  return {
    routing,
    providers,
    classifier: {
      longContextThresholdTokens: 180000,
      thinkingKeywords: ['think', '考', 'reason'],
      backgroundKeywords: []
    },
    loadBalancing: { strategy: 'round-robin' },
    health: {
      failureThreshold: 2,
      cooldownMs: 5000,
      fatalCooldownMs: 60_000
    }
  };
}

const REQUEST_TEMPLATE = {
  model: 'sim-model',
  messages: [
    { role: 'system', content: 'integration-test' },
    { role: 'user', content: 'routecodex virtual-router health test' }
  ]
};

function cloneRequest(text) {
  return {
    ...REQUEST_TEMPLATE,
    messages: [
      REQUEST_TEMPLATE.messages[0],
      { role: 'user', content: text || REQUEST_TEMPLATE.messages[1].content }
    ]
  };
}

class VirtualRouterSimulator {
  constructor(config) {
    this.engine = new VirtualRouterEngine();
    this.engine.initialize(config);
    this.unsubscribe = providerErrorCenter.subscribe((event) => {
      this.engine.handleProviderFailure(event);
    });
    this.sequence = 0;
    this.history = [];
  }

  dispose() {
    this.unsubscribe?.();
  }

  log(stage, data) {
    const payload = { stage, timestamp: Date.now(), ...data };
    this.history.push(payload);
    const printable = JSON.stringify(payload);
    console.log(printable);
  }

  emitError(providerKey, signal) {
    const event = providerErrorCenter.emit({
      providerKey,
      routeName: signal?.routeName ?? 'default',
      ...signal
    });
    this.log('error', { providerKey, event });
    return event;
  }

  runRoute(label = 'default', text) {
    const requestId = `req_${++this.sequence}`;
    const request = cloneRequest(text ?? `scenario:${label}:${Date.now()}`);
    const metadata = {
      requestId,
      entryEndpoint: '/v1/chat/completions',
      processMode: 'chat',
      stream: false,
      direction: 'request',
      providerProtocol: 'openai-chat',
      routeHint: label
    };
    try {
      const result = this.engine.route(request, metadata);
      this.log('route', { label, providerKey: result.decision.providerKey, decision: result.decision });
      return result.decision.providerKey;
    } catch (error) {
      if (error instanceof VirtualRouterError) {
        this.log('route-error', { label, code: error.code, message: error.message });
      } else {
        this.log('route-error', { label, message: String(error) });
      }
      return null;
    }
  }

  snapshot(name) {
    const status = this.engine.getStatus();
    this.log('snapshot', { name, routes: status.routes, health: status.health });
    return status;
  }
}

async function runScenario(name, fn) {
  console.log(`\n=== Scenario: ${name} ===`);
  const simulator = new VirtualRouterSimulator(createRouterConfig());
  try {
    await fn(simulator);
    simulator.snapshot(name);
    return { name, status: 'ok', history: simulator.history };
  } catch (error) {
    simulator.snapshot(`${name}-failure`);
    console.error(`[scenario:${name}] failed:`, error);
    return { name, status: 'failed', error: error instanceof Error ? error.message : String(error), history: simulator.history };
  } finally {
    simulator.dispose();
  }
}

async function scenarioRateLimit(sim) {
  sim.runRoute('default');
  sim.emitError('alpha.sim-model', { statusCode: 429 });
  sim.emitError('alpha.sim-model', { statusCode: 429 });
  sim.runRoute('default');
}

async function scenarioAuthFatal(sim) {
  sim.runRoute('default');
  sim.emitError('bravo.sim-model', { statusCode: 401, fatal: true, cooldownOverrideMs: 120000 });
  sim.runRoute('default');
  sim.emitError('charlie.sim-model', { statusCode: 403, fatal: true, cooldownOverrideMs: 120000 });
  sim.runRoute('default');
}

async function scenarioClientError(sim) {
  sim.runRoute('default');
  sim.emitError('alpha.sim-model', { statusCode: 400, affectsHealth: false });
  sim.runRoute('default');
}

async function scenarioUpstream(sim) {
  sim.runRoute('default');
  sim.emitError('alpha.sim-model', { statusCode: 502 });
  sim.emitError('alpha.sim-model', { statusCode: 500 });
  sim.runRoute('default');
  sim.emitError('bravo.sim-model', { statusCode: 502 });
  sim.emitError('charlie.sim-model', { statusCode: 502 });
  sim.runRoute('default');
}

async function scenarioTimeout(sim) {
  sim.runRoute('default');
  sim.emitError('alpha.sim-model', { statusCode: 0, reason: 'timeout', retryable: true, affectsHealth: true, cooldownOverrideMs: 2000 });
  sim.runRoute('default');
  await new Promise((resolve) => setTimeout(resolve, 2100));
  sim.runRoute('default');
}

async function scenarioScheduler(sim) {
  sim.runRoute('thinking');
  sim.emitError('charlie.sim-model', { statusCode: 500 });
  sim.emitError('charlie.sim-model', { statusCode: 500 });
  sim.runRoute('thinking');
  sim.emitError('alpha.sim-model', { statusCode: 401, fatal: true, cooldownOverrideMs: 15000 });
  sim.emitError('bravo.sim-model', { statusCode: 401, fatal: true, cooldownOverrideMs: 15000 });
  sim.emitError('charlie.sim-model', { statusCode: 401, fatal: true, cooldownOverrideMs: 15000 });
  sim.runRoute('thinking');
}

async function scenarioRoutingDirectives(sim) {
  sim.runRoute('baseline', '普通请求');
  sim.runRoute('forced-thinking', '请仔细分析这个问题 <**thinking**>');
  sim.runRoute('forced-provider', '请强制使用这个provider <**charlie.sim-model**> 来回答');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/tests/virtual-router-health.mjs [--out summary.json]');
    return;
  }

  const scenarios = [
    ['rate-limit', scenarioRateLimit],
    ['auth-fatal', scenarioAuthFatal],
    ['client-error', scenarioClientError],
    ['upstream', scenarioUpstream],
    ['timeout', scenarioTimeout],
    ['scheduler', scenarioScheduler],
    ['routing-directives', scenarioRoutingDirectives]
  ];

  const summary = [];
  for (const [name, fn] of scenarios) {
    const result = await runScenario(name, fn);
    summary.push({
      name,
      status: result.status,
      lastHealth: result.history.filter((entry) => entry.stage === 'snapshot').slice(-1)[0]?.health ?? null
    });
  }

  if (args.out) {
    const outFile = path.resolve(process.cwd(), args.out);
    await fs.mkdir(path.dirname(outFile), { recursive: true });
    await fs.writeFile(outFile, JSON.stringify(summary, null, 2), 'utf-8');
    console.log(`Summary written to ${outFile}`);
  } else {
    console.log(JSON.stringify(summary, null, 2));
  }
}

main().catch((error) => {
  console.error('virtual-router-health failed:', error);
  process.exit(1);
});
