#!/usr/bin/env node

// End-to-end Qwen OAuth authentication test (REAL, no mocks)
// - Loads token from TOKEN_FILE; if expired tries refresh
// - If refresh fails or 401 encountered, initiates device flow and polls until confirmed
// - Saves new token and validates by sending a real request to Qwen chat/completions

import process from 'node:process';

function getenv(name, def) { const v = process.env[name]; return (v !== undefined && v !== '') ? v : def; }

const TOKEN_FILE = getenv('QWEN_TOKEN_FILE', `${process.env.HOME || ''}/.qwen/oauth_creds.json`);
const CLIENT_ID = getenv('QWEN_CLIENT_ID', 'f0304373b74a44d2b584a3fb70ca9e56');
const DEVICE_CODE_URL = getenv('QWEN_DEVICE_CODE_URL', 'https://chat.qwen.ai/api/v1/oauth2/device/code');
const TOKEN_URL = getenv('QWEN_TOKEN_URL', 'https://chat.qwen.ai/api/v1/oauth2/token');
const SCOPES = getenv('QWEN_SCOPES', 'openid profile email model.completion');
const BASE_URL = getenv('QWEN_BASE_URL', 'https://portal.qwen.ai/v1');
const OPEN_BROWSER = getenv('QWEN_OPEN_BROWSER', 'true') !== 'false';

async function main() {
  const { QwenOAuth } = await import('../../dist/modules/pipeline/modules/provider/qwen-oauth.js');
  const { QwenProvider } = await import('../../dist/modules/pipeline/modules/provider/qwen-provider.js');
  const { PipelineDebugLogger } = await import('../../dist/modules/pipeline/utils/debug-logger.js');

  const oauth = new QwenOAuth({ tokenFile: TOKEN_FILE, httpClient: fetch });
  console.log('[AUTH] Using token file:', TOKEN_FILE);

  let storage = await oauth.loadToken();
  if (!storage) {
    console.log('[AUTH] No token found. Starting device flow...');
    await oauth.completeOAuthFlow(OPEN_BROWSER);
    storage = await oauth.loadToken();
    if (!storage) throw new Error('Failed to obtain token');
    console.log('[AUTH] Token acquired.');
  } else if (storage.isExpired()) {
    console.log('[AUTH] Token expired. Attempting refresh...');
    try {
      await oauth.refreshTokensWithRetry(storage.refresh_token);
      await oauth.saveToken();
      storage = await oauth.loadToken();
      if (!storage || storage.isExpired()) throw new Error('Token refresh failed');
      console.log('[AUTH] Token refreshed.');
    } catch (refreshError) {
      console.log('[AUTH] Refresh failed, starting interactive OAuth flow...');
      await oauth.completeOAuthFlow(OPEN_BROWSER);
      storage = await oauth.loadToken();
      if (!storage || storage.isExpired()) throw new Error('Interactive OAuth flow did not produce a valid token');
      console.log('[AUTH] Token refreshed via OAuth flow.');
    }
  } else {
    console.log('[AUTH] Token is valid until:', storage.expired);
  }

  // Now validate via real provider call
  const debugCenter = { logDebug:()=>{}, logError:()=>{}, logModule:()=>{}, processDebugEvent:()=>{}, getLogs:()=>[] };
  const errorHandlingCenter = { handleError: async ()=>{}, createContext:()=>({}), getStatistics:()=>({}) };
  const logger = new PipelineDebugLogger(debugCenter, { enableConsoleLogging: true, logLevel: 'basic' });
  const dependencies = { errorHandlingCenter, debugCenter, logger };

  const provider = new QwenProvider({
    type: 'qwen-provider',
    config: {
      baseUrl: BASE_URL,
      auth: {
        type: 'oauth',
        oauth: {
          clientId: CLIENT_ID,
          deviceCodeUrl: DEVICE_CODE_URL,
          tokenUrl: TOKEN_URL,
          scopes: SCOPES.split(/\s+/),
          tokenFile: TOKEN_FILE
        }
      },
      models: { 'qwen3-coder-plus': { maxTokens: 32768 } }
    }
  }, dependencies);

  await provider.initialize();

  const request = {
    model: 'qwen3-coder-plus',
    messages: [ { role: 'user', content: '用一句中文问好' } ],
    max_tokens: 64,
    temperature: 0.1
  };

  console.log('[AUTH] Sending validation request to Qwen...');
  const resp = await provider.processIncoming(request);
  console.log('[AUTH] Response status:', resp.status);
  if (resp.status !== 200) throw new Error('Validation request failed');
  console.log('[AUTH] Validation OK (received chat.completion).');
}

main().catch((e) => {
  console.error('[AUTH] Test failed:', e?.message || e);
  process.exit(1);
});
