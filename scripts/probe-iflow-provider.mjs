#!/usr/bin/env node
// Direct provider test (no server): use OpenAIStandard provider with iFlow profile (OAuth)

import os from 'os';
import path from 'path';
import fs from 'fs/promises';

const tokenFile = process.env.IFLOW_TOKEN_FILE || path.join(os.homedir(), '.routecodex', 'tokens', 'iflow-default.json');
const baseUrl = process.env.IFLOW_BASE_URL || 'https://api.iflow.ai/v1';
const model = process.env.IFLOW_MODEL || 'kimi';
const text = process.env.TEXT || 'hello from provider probe';

async function loadLocalToken() {
  try { const txt = await fs.readFile(tokenFile, 'utf-8'); return JSON.parse(txt); } catch { return null; }
}

function isExpired(tok) {
  if (!tok) return true;
  const exp = Number(tok.expires_at || 0);
  if (!exp) return false;
  const skew = 5 * 60 * 1000; // 5min buffer
  return Date.now() >= (exp - skew);
}

async function run() {
  // 1) Build V2 provider config
  const cfg = {
    type: 'openai-standard',
    config: {
      providerType: 'iflow',
      baseUrl,
      auth: {
        type: 'oauth',
        clientId: process.env.IFLOW_CLIENT_ID || 'iflow-desktop-client',
        tokenUrl: 'https://iflow.cn/oauth/token',
        deviceCodeUrl: 'https://iflow.cn/oauth/device/code',
        scopes: ['openid','profile','email','api'],
        tokenFile,
      },
      overrides: {}
    }
  };

  // 2) Ensure valid token via module-provided OAuth strategy (device-code)
  let tok0 = await loadLocalToken();
  if (process.env.IFLOW_FORCE_OAUTH === '1' || !tok0 || isExpired(tok0)) {
    console.log(`[iflow] obtaining token via device-code flow... (${tokenFile})`);
    const { createProviderOAuthStrategy } = await import('../dist/modules/pipeline/modules/provider/v2/config/provider-oauth-configs.js');
    const strat = createProviderOAuthStrategy('iflow', {
      flowType: 'device_code',
      endpoints: { deviceCodeUrl: 'https://iflow.cn/oauth/device/code', tokenUrl: 'https://iflow.cn/oauth/token', userInfoUrl: 'https://iflow.cn/api/oauth/getUserInfo' },
      client: { clientId: process.env.IFLOW_CLIENT_ID || 'iflow-desktop-client', scopes: ['openid','profile','email','api'] },
      tokenFile
    });
    const tok = await strat.authenticate({ openBrowser: true });
    await strat.saveToken(tok);
    console.log('[iflow] token saved');
  } else {
    console.log('[iflow] using existing local token');
  }

  // 3) Create provider and send a chat request
  const { OpenAIStandard } = await import('../dist/modules/pipeline/modules/provider/v2/core/openai-standard.js');
  const provider = new OpenAIStandard(cfg, {});
  await provider.initialize();
  const body = { model, messages: [{ role:'user', content:text }], stream:false };
  const out = await provider.sendRequest(body);
  const payload = (out && typeof out==='object' && 'data' in out) ? out.data : out;
  console.log(JSON.stringify(payload, null, 2));
}

run().catch(err => { console.error(err); process.exit(1); });
