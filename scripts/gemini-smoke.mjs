#!/usr/bin/env node
import { GeminiHttpProvider } from '../dist/providers/core/runtime/gemini-http-provider.js';
import { fileURLToPath } from 'url';

const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!apiKey) {
  console.error('Set GEMINI_API_KEY to run this smoke test');
  process.exit(1);
}

const config = {
  type: 'gemini-http-provider',
  config: {
    providerType: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
    auth: { type: 'apikey', headerName: 'x-goog-api-key', apiKey },
    overrides: { maxRetries: 0 }
  }
};

const dependencies = {
  logger: { logModule: () => {}, logProviderRequest: () => {} },
  errorHandlingCenter: { handleError: async () => {} }
};

const provider = new GeminiHttpProvider(config, dependencies);
await provider.initialize();

const request = {
  data: {
    model: config.config.model,
    messages: [{ role: 'user', content: 'Say hi in one word.' }]
  }
};

const res = await provider.sendRequest(request);
console.log('[gemini-smoke] status:', res?.status || 200);
console.log('[gemini-smoke] body snippet:', JSON.stringify(res?.data || res).slice(0, 500));
