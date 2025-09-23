#!/usr/bin/env node

// Qwen HTTP Provider bottom-layer test with local token file (no real network used by provider impl).

import fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';

function getenv(name, def) { const v = process.env[name]; return (v !== undefined && v !== '') ? v : def; }

const BASE_URL = getenv('QWEN_BASE_URL', 'https://portal.qwen.ai/v1');
const MODEL = getenv('QWEN_MODEL', 'qwen3-coder-plus');
const TOKEN_FILE = getenv('QWEN_TOKEN_FILE', path.join(homedir(), '.qwen', 'oauth_creds.json'));

async function ensureTokenFile(p) {
  try {
    await fs.access(p);
    return;
  } catch {
    if (process.env.ALLOW_DUMMY_QWEN_TOKEN === '1') {
      const dir = path.dirname(p);
      await fs.mkdir(dir, { recursive: true });
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const token = {
        access_token: 'dummy_access_token',
        refresh_token: 'dummy_refresh_token',
        last_refresh: new Date().toISOString(),
        resource_url: 'portal.qwen.ai',
        email: 'dummy@example.com',
        type: 'qwen',
        expired: future
      };
      await fs.writeFile(p, JSON.stringify(token, null, 2));
    } else {
      throw new Error(`Token file not found at ${p}. Run scripts/auth/test-qwen-auth-flow.mjs to authenticate.`);
    }
  }
}

async function main() {
  const { QwenProvider } = await import('../dist/modules/pipeline/modules/provider/qwen-provider.js');
  const { PipelineDebugLogger } = await import('../dist/modules/pipeline/utils/debug-logger.js');
  await ensureTokenFile(TOKEN_FILE);

  const debugCenter = { logDebug:()=>{}, logError:()=>{}, logModule:()=>{}, processDebugEvent:()=>{}, getLogs:()=>[] };
  const errorHandlingCenter = { handleError: async ()=>{}, createContext:()=>({}), getStatistics:()=>({}) };
  const logger = new PipelineDebugLogger(debugCenter, { enableConsoleLogging: true, logLevel: 'basic' });
  const dependencies = { errorHandlingCenter, debugCenter, logger };

  const providerConfig = {
    type: 'qwen-provider',
    config: {
      baseUrl: BASE_URL,
      auth: {
        type: 'oauth',
        oauth: {
          clientId: 'f0304373b74a44d2b584a3fb70ca9e56',
          deviceCodeUrl: 'https://chat.qwen.ai/api/v1/oauth2/device/code',
          tokenUrl: 'https://chat.qwen.ai/api/v1/oauth2/token',
          scopes: ['openid','profile','email','model.completion'],
          tokenFile: TOKEN_FILE
        }
      },
      models: { [MODEL]: { maxTokens: 32768 } }
    }
  };

  const provider = new QwenProvider(providerConfig, dependencies);
  console.log('Initializing QwenHTTPProvider with', providerConfig.config);
  await provider.initialize();

  const request = {
    model: MODEL,
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: '用一句中文回应。' }
    ],
    temperature: 0.2,
    max_tokens: 128
  };
  console.log('Sending provider.processIncoming...');
  const resp = await provider.processIncoming(request);
  console.log('Response (truncated):', JSON.stringify(resp).slice(0, 500));
}

main().catch((e) => {
  console.error('Qwen HTTP provider test failed:', e?.message || e);
  process.exit(1);
});
