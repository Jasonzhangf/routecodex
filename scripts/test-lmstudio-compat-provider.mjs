#!/usr/bin/env node

// Compatibility + Provider LM Studio test (middle + bottom layers)
// Transforms OpenAI-style request via LMStudioCompatibility then sends to LMStudioSDKProvider.

import process from 'node:process';

function getenv(name, def) { const v = process.env[name]; return (v !== undefined && v !== '') ? v : def; }

const BASE_URL = getenv('LMSTUDIO_BASE_URL', 'ws://127.0.0.1:5507');
const MODEL = getenv('LMSTUDIO_MODEL', 'gpt-oss-20b-mlx');

async function main() {
  const { LMStudioCompatibility } = await import('../dist/modules/pipeline/modules/compatibility/lmstudio-compatibility.js');
  const { LMStudioProviderSimple } = await import('../dist/modules/pipeline/modules/provider/lmstudio-provider-simple.js');
  const { PipelineDebugLogger } = await import('../dist/modules/pipeline/utils/debug-logger.js');

  const debugCenter = { logDebug:()=>{}, logError:()=>{}, logModule:()=>{}, processDebugEvent:()=>{}, getLogs:()=>[] };
  const errorHandlingCenter = { handleError: async ()=>{}, createContext:()=>({}), getStatistics:()=>({}) };
  const logger = new PipelineDebugLogger(debugCenter, { enableConsoleLogging: true, logLevel: 'basic' });
  const dependencies = { errorHandlingCenter, debugCenter, logger };

  const compat = new LMStudioCompatibility({ type: 'lmstudio-compatibility', config: { toolsEnabled: true } }, dependencies);
  await compat.initialize();

  const providerConfig = { type: 'lmstudio-http', config: { baseUrl: BASE_URL, auth: { type: 'apikey' } } };
  const provider = new LMStudioProviderSimple(providerConfig, dependencies);
  await provider.initialize();

  const openaiRequest = {
    model: MODEL,
    messages: [
      { role: 'system', content: '你是乐于助人的助手。' },
      { role: 'user', content: '请简要用中文问好，并附上一句英文问候。' }
    ],
    temperature: 0.2,
    max_tokens: 128
  };

  console.log('Transforming request via LMStudioCompatibility...');
  const transformed = await compat.processIncoming(openaiRequest);
  console.log('Sending to LMStudioSDKProvider...');
  const providerResp = await provider.processIncoming(transformed);
  console.log('Provider response (truncated):', JSON.stringify(providerResp.data).slice(0, 800));
}

main().catch((e) => {
  console.error('Compat+Provider test failed:', e?.message || e);
  process.exit(1);
});
