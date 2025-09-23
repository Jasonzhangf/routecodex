#!/usr/bin/env node

// Provider-level LM Studio test (bottom layer)
// Uses compiled classes from dist to call LMStudioSDKProvider directly.
// Assumes LM Studio is running on ws://127.0.0.1:5507 (or LMSTUDIO_BASE_URL env).

import process from 'node:process';

function getenv(name, def) { const v = process.env[name]; return (v !== undefined && v !== '') ? v : def; }

const BASE_URL = getenv('LMSTUDIO_BASE_URL', 'ws://127.0.0.1:5507');
const MODEL = getenv('LMSTUDIO_MODEL', 'gpt-oss-20b-mlx');

async function main() {
  // Import compiled provider + logger
  const { LMStudioSDKProvider } = await import('../dist/modules/pipeline/modules/provider/lmstudio-sdk-provider.js');
  const { PipelineDebugLogger } = await import('../dist/modules/pipeline/utils/debug-logger.js');

  // Minimal centers for dependencies; DebugEventBus is used inside logger
  const debugCenter = {
    logDebug: () => {}, logError: () => {}, logModule: () => {}, processDebugEvent: () => {}, getLogs: () => []
  };
  const errorHandlingCenter = { handleError: async () => {}, createContext: () => ({}), getStatistics: () => ({}) };
  const logger = new PipelineDebugLogger(debugCenter, { enableConsoleLogging: true, logLevel: 'basic' });
  const dependencies = { errorHandlingCenter, debugCenter, logger };

  const providerConfig = { type: 'lmstudio-sdk', config: { baseUrl: BASE_URL, model: MODEL, maxTokens: 256 } };
  const provider = new LMStudioSDKProvider(providerConfig, dependencies);
  console.log('Initializing LMStudioSDKProvider with', providerConfig);
  await provider.initialize();

  const request = {
    model: MODEL,
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: '请简单自我介绍一下，并说“你好LM Studio”' }
    ],
    max_tokens: 128,
    temperature: 0.2
  };
  console.log('Sending request to provider.processIncoming...');
  const resp = await provider.processIncoming(request);
  console.log('Provider response status:', resp.status);
  console.log('Provider response (truncated):', JSON.stringify(resp.data).slice(0, 800));
}

main().catch((e) => {
  console.error('Provider test failed:', e?.message || e);
  process.exit(1);
});

