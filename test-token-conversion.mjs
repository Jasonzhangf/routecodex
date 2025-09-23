#!/usr/bin/env node

/**
 * Token Conversion Test
 * Convert existing token to CLIProxyAPI format and test
 */

import { QwenTokenStorage } from './dist/modules/pipeline/modules/provider/qwen-oauth.js';

// Convert existing token to CLIProxyAPI format
const existingToken = {
  accessToken: "dLovSoe0rTXTbSwa8HOuFW14eMVU629Adk0GEpV2mpK8sl8JJaHvSI9wEO_wtbM1UapxrERqLS5I9Dq7IZTfuw",
  refreshToken: "aN3r9Z3uLU5nCfApUAlVyIeqO5EalIEZWKLIqHcbbgSnUaMElxTnWRCcdUvz3z2tDgFtP7YkKWsxa3zkpFIv_g",
  tokenExpiry: 1757771457925,
  lastRefresh: 1757749857925,
  provider: "undefined",
  resource_url: "portal.qwen.ai"
};

// Convert to CLIProxyAPI format
const cliProxyAPIToken = {
  access_token: existingToken.accessToken,
  refresh_token: existingToken.refreshToken,
  last_refresh: new Date(existingToken.lastRefresh).toISOString(),
  resource_url: existingToken.resource_url,
  email: "",
  type: "qwen",
  expired: new Date(existingToken.tokenExpiry).toISOString()
};

console.log('Original token format:');
console.log(JSON.stringify(existingToken, null, 2));
console.log('\nCLIProxyAPI format:');
console.log(JSON.stringify(cliProxyAPIToken, null, 2));

// Create token storage instance
const tokenStorage = QwenTokenStorage.fromJSON(cliProxyAPIToken);
console.log('\nToken storage created:');
console.log('Is expired:', tokenStorage.isExpired());
console.log('Auth header:', tokenStorage.getAuthorizationHeader());

// Test API call with this token
async function testToken() {
  try {
    const response = await fetch('https://portal.qwen.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': tokenStorage.getAuthorizationHeader(),
        'User-Agent': 'google-api-nodejs-client/9.15.1',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        model: 'qwen3-coder-plus',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 10
      })
    });

    console.log('\nAPI Test Response:');
    console.log('Status:', response.status);

    if (response.ok) {
      const data = await response.json();
      console.log('Success! Response:', data.choices?.[0]?.message?.content);
    } else {
      const errorText = await response.text();
      console.log('Error:', errorText);
    }
  } catch (error) {
    console.error('Network error:', error.message);
  }
}

testToken();