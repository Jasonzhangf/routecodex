#!/usr/bin/env node
/**
 * Responses provider dry-run harness powered by the unified debug module.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { createDebugToolkit } = await import(
  pathToFileURL(path.join(ROOT, 'dist/debug/index.js')).href
);

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

const legacyCompatFields = [];
if (typeof providerDef.compatibility_profile === 'string') legacyCompatFields.push('compatibility_profile');
if (typeof providerDef.compat === 'string') legacyCompatFields.push('compat');
if (providerDef.compatibility && typeof providerDef.compatibility === 'object') {
  if (typeof providerDef.compatibility.profile === 'string') legacyCompatFields.push('compatibility.profile');
  if (typeof providerDef.compatibility.id === 'string') legacyCompatFields.push('compatibility.id');
}
if (legacyCompatFields.length > 0) {
  usage(`Provider "${providerId}" uses legacy compatibility field(s): ${legacyCompatFields.join(', ')}. Rename to "compatibilityProfile".`);
}
const compatProfile =
  (typeof providerDef.compatibilityProfile === 'string' && providerDef.compatibilityProfile.trim()) ||
  undefined;

const runtime = {
  runtimeKey: `${providerId}.dry`,
  providerId,
  providerKey: `${providerId}.dry`,
  providerType: (providerDef.type || 'openai').toLowerCase(),
  endpoint: providerDef.baseURL || providerDef.baseUrl || providerDef.endpoint || 'https://example.local/v1',
  auth: {
    type: 'apikey',
    value: apiKey
  },
  compatibilityProfile: compatProfile,
  outboundProfile: providerDef.type === 'responses' ? 'openai-responses' : 'openai-chat',
  defaultModel: modelId
};

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
const metadata = {
  requestId: `dry-run-${Date.now()}`,
  providerId: runtime.providerId,
  providerKey: runtime.providerKey,
  providerType: runtime.providerType,
  providerProtocol: runtime.outboundProfile === 'openai-responses' ? 'openai-responses' : 'openai-chat',
  routeName: 'default',
  target: {
    providerKey: `${runtime.providerId}.dry.${modelId}`,
    providerType: runtime.providerType,
    compatibilityProfile: runtime.compatibilityProfile,
    runtimeKey: runtime.runtimeKey,
    modelId
  },
  metadata: {
    stream: false
  }
};

const toolkit = createDebugToolkit({ snapshotDirectory: path.join(ROOT, 'logs', 'debug') });
const dryRunner = toolkit.dryRunner;

const result = await dryRunner.runProviderPreprocess({
  runtime,
  request,
  metadata,
  sessionId: process.env.DRY_RUN_SESSION_ID
});

const body = result.processed?.data || result.processed;
console.log('--- Sanitized request body ---');
console.log(JSON.stringify(body, null, 2));
