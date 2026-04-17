#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

async function importModule(relativePath) {
  return import(path.resolve(repoRoot, 'dist', relativePath));
}

let reportProviderErrorToRouterPolicyRef;
let setVirtualRouterPolicyRuntimeRouterHooksRef;
let VirtualRouterErrorRef;

async function main() {
  const { VirtualRouterEngine } = await importModule('router/virtual-router/engine.js');
  const {
    reportProviderErrorToRouterPolicy,
    setVirtualRouterPolicyRuntimeRouterHooks
  } = await importModule('router/virtual-router/provider-runtime-ingress.js');
  const { VirtualRouterError } = await importModule('router/virtual-router/types.js');
  reportProviderErrorToRouterPolicyRef = reportProviderErrorToRouterPolicy;
  setVirtualRouterPolicyRuntimeRouterHooksRef = setVirtualRouterPolicyRuntimeRouterHooks;
  VirtualRouterErrorRef = VirtualRouterError;

  const engine = new VirtualRouterEngine();
  engine.initialize(buildTestConfig());
  setVirtualRouterPolicyRuntimeRouterHooksRef(engine, {
    handleProviderError: (event) => {
      engine.handleProviderError(event);
    }
  });

  const request = buildRequest();
  const metadata = buildMetadata();

  console.log('\n[baseline] round-robin across four providers');
  for (let i = 0; i < 4; i += 1) {
    logRoute(engine, request, metadata, `baseline#${i + 1}`);
  }

  console.log('\n[rate_limit] simulate 429s for provider p2');
  emitProviderError('p2', {
    code: 'ERR_UPSTREAM_429_RATE_LIMIT',
    status: 429,
    recoverable: true
  });
  emitProviderError('p2', {
    code: 'ERR_UPSTREAM_429_RATE_LIMIT',
    status: 429,
    recoverable: true
  });
  for (let i = 0; i < 4; i += 1) {
    logRoute(engine, request, metadata, `post429#${i + 1}`);
  }

  console.log('\n[auth] simulate 401 for provider p3 (immediate fatal)');
  emitProviderError('p3', {
    code: 'ERR_UPSTREAM_401_AUTH',
    status: 401,
    recoverable: false
  });
  logRoute(engine, request, metadata, 'after401');

  console.log('\n[client_error] simulate 400 (should not blacklist provider p1)');
  emitProviderError('p1', {
    code: 'ERR_CLIENT_400',
    status: 400,
    recoverable: false
  });
  logRoute(engine, request, metadata, 'clientError#1');

  console.log('\n[server_error] trigger failures on remaining providers to exhaust pool');
  emitProviderError('p1', {
    code: 'ERR_UPSTREAM_503',
    status: 503,
    recoverable: false
  });
  emitProviderError('p1', {
    code: 'ERR_UPSTREAM_503',
    status: 503,
    recoverable: false
  });
  emitProviderError('p4', {
    code: 'ERR_UPSTREAM_503',
    status: 503,
    recoverable: false
  });
  emitProviderError('p4', {
    code: 'ERR_UPSTREAM_503',
    status: 503,
    recoverable: false
  });
  try {
    logRoute(engine, request, metadata, 'exhaustion');
  } catch (error) {
    if (error instanceof VirtualRouterErrorRef) {
      console.error('[virtual-router] all providers unavailable, translate to HTTP 503', error.details);
    } else {
      throw error;
    }
  }
}

function buildTestConfig() {
  const providers = ['p1', 'p2', 'p3', 'p4'].reduce((acc, key) => {
    acc[key] = {
      providerKey: key,
      providerType: 'openai',
      endpoint: `https://example.com/${key}`,
      auth: { type: 'apiKey', secretRef: `TEST_${key.toUpperCase()}` },
      outboundProfile: 'openai-chat',
      compatibilityProfile: 'default',
      modelId: 'gpt-test'
    };
    return acc;
  }, {});
  return {
    routing: {
      default: [
        {
          id: 'health-primary',
          priority: 100,
          targets: Object.keys(providers)
        }
      ]
    },
    providers,
    classifier: {},
    loadBalancing: { strategy: 'round-robin' },
    health: { failureThreshold: 2, cooldownMs: 30_000, fatalCooldownMs: 120_000 }
  };
}

function buildRequest() {
  return {
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'ping' }],
    tools: [],
    parameters: {},
    metadata: {}
  };
}

function buildMetadata() {
  return {
    requestId: 'req_health_demo',
    entryEndpoint: '/v1/chat/completions',
    processMode: 'chat',
    stream: false,
    direction: 'request'
  };
}

function logRoute(engine, request, metadata, label) {
  const { decision } = engine.route(request, metadata);
  console.log(`${label}: route=${decision.routeName} provider=${decision.providerKey}`);
}

function emitProviderError(providerKey, override) {
  reportProviderErrorToRouterPolicyRef({
    code: override.code,
    message: override.code,
    stage: override.stage || 'http.response',
    status: override.status,
    recoverable: override.recoverable,
    runtime: {
      requestId: 'req_health_demo',
      routeName: 'default',
      providerKey,
      providerType: 'openai',
      providerProtocol: 'openai-chat',
      pipelineId: 'pipeline-default'
    },
    timestamp: Date.now()
  });
}

main().catch((error) => {
  console.error('[virtual-router-health] failed', error);
  process.exitCode = 1;
});
