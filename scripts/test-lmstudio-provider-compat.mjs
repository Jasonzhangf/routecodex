#!/usr/bin/env node

// Real integration test (no mocks) for LM Studio Compatibility + Provider
// Usage:
//   LMSTUDIO_BASE_URL=http://localhost:1234 \
//   LMSTUDIO_API_KEY=your-key \
//   LMSTUDIO_MODEL=your-model \
//   node scripts/test-lmstudio-provider-compat.mjs

import process from 'node:process';

// Import compiled JS from dist
import { LMStudioCompatibility } from '../dist/modules/pipeline/modules/compatibility/lmstudio-compatibility.js';
import { LMStudioProvider } from '../dist/modules/pipeline/modules/provider/lmstudio-provider.js';
import { PipelineDebugLogger } from '../dist/modules/pipeline/utils/debug-logger.js';

function getEnv(name, fallback) {
  const v = process.env[name];
  if (v && v.trim()) return v.trim();
  return fallback;
}

const baseUrl = getEnv('LMSTUDIO_BASE_URL', 'http://localhost:1234');
const apiKey = getEnv('LMSTUDIO_API_KEY', '');
const model = getEnv('LMSTUDIO_MODEL', 'llama2-7b-chat');

if (!apiKey) {
  console.error('Missing LMSTUDIO_API_KEY environment variable.');
  process.exit(1);
}

// Minimal dependency adapters for logger integration
const debugCenter = {
  logDebug: (_module, _message, _data) => {},
  logError: (_module, _error, _context) => {},
  logModule: (_module, _action, _data) => {},
  processDebugEvent: (_event) => {},
  getLogs: (_module) => []
};

const errorHandlingCenter = {
  handleError: async (error, context) => {
    console.error('[errorHandlingCenter] Error:', error?.message || error, 'Context:', context);
  },
  createContext: (module, action, data) => ({ module, action, data }),
  getStatistics: () => ({})
};

const logger = new PipelineDebugLogger(debugCenter, { enableConsoleLogging: true, logLevel: 'basic' });
const dependencies = { errorHandlingCenter, debugCenter, logger };

(async () => {
  try {
    // Initialize compatibility
    const compat = new LMStudioCompatibility(
      { type: 'lmstudio-compatibility', config: { toolsEnabled: true, customRules: [] } },
      dependencies
    );
    await compat.initialize();

    // Initialize provider
    const provider = new LMStudioProvider(
      { type: 'lmstudio-http', config: { baseUrl, auth: { type: 'apikey', apiKey } } },
      dependencies
    );
    await provider.initialize();

    // Build OpenAI-like request
    const request = {
      model,
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Say hello from LM Studio.' }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'echo',
            description: 'Echo back provided text',
            parameters: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text']
            }
          }
        }
      ],
      max_tokens: 256,
      temperature: 0.2
    };

    console.log('--- Compatibility: processIncoming() ---');
    const transformedRequest = await compat.processIncoming(request);
    console.log('Transformed request:', JSON.stringify(transformedRequest, null, 2));

    console.log('--- Provider: processIncoming() ---');
    const providerResponse = await provider.processIncoming(transformedRequest);
    console.log('Raw provider response (enveloped):', JSON.stringify(providerResponse, null, 2));

    console.log('--- Compatibility: processOutgoing() ---');
    const finalResponse = await compat.processOutgoing(providerResponse.data);
    console.log('Final response:', JSON.stringify(finalResponse, null, 2));

    console.log('\n✅ LM Studio provider + compatibility test completed successfully.');
  } catch (err) {
    console.error('\n❌ LM Studio provider + compatibility test failed:', err?.message || err);
    process.exit(1);
  }
})();

