#!/usr/bin/env node
/**
 * Responses provider dry-run harness.
 * Loads a provider config (default ~/.routecodex/provider/c4m/config.v1.json),
 * instantiates the Responses provider, and runs preprocessRequest to inspect
 * the sanitized payload (before HTTP send). Useful for verifying compatibility
 * stripping (e.g. max_output_tokens) without touching upstream APIs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const ProviderFactory = (await import(pathToFileURL(
  path.join(ROOT, 'dist/providers/core/runtime/provider-factory.js')
).href)).ProviderFactory;
const { attachProviderRuntimeMetadata, extractProviderRuntimeMetadata } = await import(pathToFileURL(
  path.join(ROOT, 'dist/providers/core/runtime/provider-runtime-metadata.js')
).href);

function usage(err) {
  const msg = err ? `❌ ${err}\n` : '';
  console.log(`${msg}Usage: node scripts/tests/responses-provider-dry-run.mjs [configPath] [providerId.modelId]`);
  process.exit(err ? 1 : 0);
}

const args = process.argv.slice(2);
const configPath = args[0] || path.join(process.env.HOME || '~', '.routecodex', 'provider', 'c4m', 'config.v1.json');
if (!fs.existsSync(configPath)) usage(`Config file not found: ${configPath}`);
const providerTarget = args[1] || 'c4m.gpt-5.1';
const [providerId, modelId = 'gpt-5.1'] = providerTarget.split('.');

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const providerDef = config?.virtualrouter?.providers?.[providerId];
if (!providerDef) usage(`Provider "${providerId}" not found in config`);
const auth = providerDef.auth || {};
const apiKey = auth.apiKey || auth.value || process.env.DRY_RUN_API_KEY || 'dry-run-key';

const runtime = {
  runtimeKey: `${providerId}.dry`,
  providerId,
  providerKey: `${providerId}.dry`,
  keyAlias: 'dry',
  providerType: (providerDef.type || 'openai').toLowerCase(),
  endpoint: providerDef.baseURL || providerDef.baseUrl || providerDef.endpoint || 'https://example.local/v1',
  auth: {
    type: 'apikey',
    value: apiKey
  },
  compatibilityProfile: providerDef.compat || 'default',
  outboundProfile: providerDef.type === 'responses' ? 'openai-responses' : 'openai-chat',
  defaultModel: modelId
};

const dependencies = {
  logger: {
    logModule: (module, event, data) => {
      if (process.env.DRY_LOG_VERBOSE === '1') {
        console.log(`[${module}] ${event}`, data || '');
      }
    },
    logError: (error, ctx) => console.error('[dry-run] logError', error.message, ctx || {}),
    logInfo: (msg, data) => {
      if (process.env.DRY_LOG_VERBOSE === '1') {
        console.log('[dry-run]', msg, data || {});
      }
    },
    logProviderRequest: () => {},
    logProviderResponse: () => {}
  },
  errorHandlingCenter: {
    handleError: () => {}
  },
  debugCenter: {
    log: () => {}
  }
};

const provider = ProviderFactory.createProviderFromRuntime(runtime, dependencies);
await provider.initialize();

function buildSampleRequest() {
  return {
    data: {
      model: modelId,
      input: [
        {
          role: 'system',
          content: [{ type: 'input_text', text: 'dry-run system prompt' }]
        },
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'hello from dry-run' }]
        }
      ],
      max_output_tokens: 9999,
      temperature: 0.6
    },
    metadata: {
      entryEndpoint: '/v1/messages',
      stream: false
    }
  };
}

const request = buildSampleRequest();
attachProviderRuntimeMetadata(request, {
  requestId: `dry-run-${Date.now()}`,
  providerId: runtime.providerId,
  providerKey: runtime.providerKey,
  providerType: runtime.providerType,
  providerProtocol: runtime.outboundProfile === 'openai-responses' ? 'openai-responses' : 'openai-chat',
  routeName: 'default',
  target: {
    providerKey: `${runtime.providerId}.${runtime.keyAlias}.${modelId}`,
    providerType: runtime.providerType,
    compatibilityProfile: runtime.compatibilityProfile,
    runtimeKey: runtime.runtimeKey,
    modelId
  },
  metadata: {
    stream: false
  }
});

console.log('runtime metadata detected before preprocess:', extractProviderRuntimeMetadata(request));
if (typeof provider.createContext === 'function') {
  provider.createContext(request);
}
const processed = await provider.preprocessRequest(request);
console.log('runtime metadata after preprocess:', extractProviderRuntimeMetadata(processed));
const body = processed?.data || processed;
console.log('--- Sanitized request body ---');
console.log(JSON.stringify(body, null, 2));
