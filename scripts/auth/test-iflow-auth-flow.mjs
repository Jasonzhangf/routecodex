#!/usr/bin/env node

// iFlow OAuth end-to-end validation script (real device flow)
// - Ensures token file exists or triggers device flow
// - Saves refreshed tokens
// - Sends a real chat request to verify access

import process from 'node:process';

const getenv = (name, def) => {
  const value = process.env[name];
  return value !== undefined && value !== '' ? value : def;
};

const TOKEN_FILE = getenv('IFLOW_TOKEN_FILE', `${process.env.HOME || ''}/.iflow/oauth_creds.json`);
const CREDENTIALS_FILE = getenv('IFLOW_CREDENTIALS_FILE', `${process.env.HOME || ''}/.iflow/credentials.json`);
const CLIENT_ID = getenv('IFLOW_CLIENT_ID', '10009311001');
const CLIENT_SECRET = getenv('IFLOW_CLIENT_SECRET', '4Z3YjXycVsQvyGF1etiNlIBB4RsqSDtW');
const DEVICE_CODE_URL = getenv('IFLOW_DEVICE_CODE_URL', 'https://iflow.cn/oauth/device/code');
const TOKEN_URL = getenv('IFLOW_TOKEN_URL', 'https://iflow.cn/oauth/token');
const SCOPES = getenv('IFLOW_SCOPES', 'openid profile api');
const BASE_URL = getenv('IFLOW_BASE_URL', 'https://api.iflow.cn/v1');
const TEST_MODEL = getenv('IFLOW_TEST_MODEL', 'iflow-pro');
const OPEN_BROWSER = getenv('IFLOW_OPEN_BROWSER', 'true') !== 'false';

async function main() {
  const { iFlowProvider } = await import('../../dist/modules/pipeline/modules/provider/iflow-provider.js');
  const { PipelineDebugLogger } = await import('../../dist/modules/pipeline/utils/debug-logger.js');

  const debugCenter = { logDebug:()=>{}, logError:()=>{}, logModule:()=>{}, processDebugEvent:()=>{}, getLogs:()=>[] };
  const errorHandlingCenter = { handleError: async ()=>{}, createContext:()=>({}), getStatistics:()=>({}) };
  const logger = new PipelineDebugLogger(debugCenter, { enableConsoleLogging: true, logLevel: 'basic' });
  const dependencies = { errorHandlingCenter, debugCenter, logger };

  const providerConfig = {
    type: 'iflow-http',
    config: {
      baseUrl: BASE_URL,
      auth: {
        oauth: {
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          tokenUrl: TOKEN_URL,
          deviceCodeUrl: DEVICE_CODE_URL,
          scopes: SCOPES.split(/\s+/),
          tokenFile: TOKEN_FILE,
          credentialsFile: CREDENTIALS_FILE
        }
      }
    }
  };

  const provider = new iFlowProvider(providerConfig, dependencies);
  provider.setTestMode(!OPEN_BROWSER);

  console.log('[iFlow] Using token file:', TOKEN_FILE);

  try {
    await provider.initialize();
  } catch (error) {
    console.error('[iFlow] Initialization failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const request = {
    model: TEST_MODEL,
    messages: [
      { role: 'user', content: '你好，请给我一句鼓励的话。' }
    ],
    temperature: 0.7,
    max_tokens: 64
  };

  console.log('[iFlow] Sending validation request...');
  try {
    const response = await provider.processIncoming(request);
    console.log('[iFlow] Response status:', response.status);
    if (response.status !== 200) {
      console.error('[iFlow] Validation failed with status', response.status, response.data);
      process.exit(1);
    }
    console.log('[iFlow] Validation OK.');
  } catch (error) {
    console.error('[iFlow] Validation error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('[iFlow] Test failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
