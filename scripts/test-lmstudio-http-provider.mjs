#!/usr/bin/env node

// Bottom-layer test for LM Studio HTTP provider (LMStudioProviderSimple)
// Requires LM Studio REST API at LMSTUDIO_BASE_URL (e.g., http://192.168.99.149:1234)

import process from 'node:process';

function getenv(name, def) { const v = process.env[name]; return (v !== undefined && v !== '') ? v : def; }

const BASE_URL = getenv('LMSTUDIO_BASE_URL', 'http://192.168.99.149:1234');
const MODEL = getenv('LMSTUDIO_MODEL', 'gpt-oss-20b-mlx');
const API_KEY = getenv('LMSTUDIO_API_KEY', ''); // LM Studio REST may not require a key; leave empty if not

async function main() {
  const { LMStudioProviderSimple } = await import('../dist/modules/pipeline/modules/provider/lmstudio-provider-simple.js');
  const { PipelineDebugLogger } = await import('../dist/modules/pipeline/utils/debug-logger.js');

  const debugCenter = { logDebug:()=>{}, logError:()=>{}, logModule:()=>{}, processDebugEvent:()=>{}, getLogs:()=>[] };
  const errorHandlingCenter = { handleError: async ()=>{}, createContext:()=>({}), getStatistics:()=>({}) };
  const logger = new PipelineDebugLogger(debugCenter, { enableConsoleLogging: true, logLevel: 'basic' });
  const dependencies = { errorHandlingCenter, debugCenter, logger };

  const providerConfig = {
    type: 'lmstudio-http',
    config: {
      baseUrl: BASE_URL,
      auth: { type: 'apikey', ...(API_KEY ? { apiKey: API_KEY } : {}) }
    }
  };

  const provider = new LMStudioProviderSimple(providerConfig, dependencies);
  console.log('Initializing LMStudioProviderSimple with', providerConfig.config);
  await provider.initialize();

  const request = {
    model: MODEL,
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: '请用中文问好，并附上一句英文问候。' }
    ],
    max_tokens: 128,
    temperature: 0.2
  };

  console.log('Sending provider.processIncoming...');
  const resp = await provider.processIncoming(request);
  console.log('Status:', resp.status);
  console.log('Body (truncated):', JSON.stringify(resp.data).slice(0, 800));
}

main().catch((e) => {
  console.error('LM Studio HTTP provider test failed:', e?.message || e);
  process.exit(1);
});

