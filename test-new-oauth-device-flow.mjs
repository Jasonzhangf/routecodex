#!/usr/bin/env node

/**
 * Test OAuth Device Flow with PKCE
 * Generates a fresh OAuth token using the complete device flow
 */

import fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';
import crypto from 'crypto';

// Generate PKCE code verifier
function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

// Generate PKCE code challenge from verifier
function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

async function makeRequest(url, options = {}) {
  const { method = 'GET', headers = {}, body } = options;

  try {
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined
    });

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      data: response.ok ? await response.json() : null,
      error: response.ok ? null : await response.text()
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      statusText: 'Network Error',
      data: null,
      error: error.message
    };
  }
}

async function makeFormRequest(url, options = {}) {
  const { method = 'POST', headers = {}, body } = options;

  try {
    const formData = new URLSearchParams();
    if (body) {
      for (const [key, value] of Object.entries(body)) {
        formData.append(key, value);
      }
    }

    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...headers
      },
      body: formData.toString()
    });

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      data: response.ok ? await response.json() : null,
      error: response.ok ? null : await response.text()
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      statusText: 'Network Error',
      data: null,
      error: error.message
    };
  }
}

async function testOAuthDeviceFlow() {
  console.log('🔧 Testing OAuth Device Flow with PKCE...\n');

  const clientId = 'f0304373b74a44d2b584a3fb70ca9e56';
  const scope = 'openid profile email model.completion';

  try {
    // Step 1: Generate PKCE pair
    console.log('🔐 Step 1: Generate PKCE pair');
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    console.log('  - Code Verifier:', codeVerifier.substring(0, 20) + '...');
    console.log('  - Code Challenge:', codeChallenge.substring(0, 20) + '...');
    console.log('');

    // Step 2: Request device code
    console.log('📱 Step 2: Request device code');
    const deviceResult = await makeFormRequest('https://chat.qwen.ai/api/v1/oauth2/device/code', {
      method: 'POST',
      body: {
        client_id: clientId,
        scope: scope,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256'
      }
    });

    if (!deviceResult.ok) {
      console.log('❌ Device code request failed');
      console.log('  - Error:', deviceResult.error);
      return;
    }

    console.log('✅ Device code obtained');
    console.log('  - Device Code:', deviceResult.data.device_code.substring(0, 20) + '...');
    console.log('  - User Code:', deviceResult.data.user_code);
    console.log('  - Verification URI:', deviceResult.data.verification_uri);
    console.log('  - Verification URI Complete:', deviceResult.data.verification_uri_complete);
    console.log('  - Expires In:', deviceResult.data.expires_in, 'seconds');
    console.log('  - Interval:', deviceResult.data.interval, 'seconds');
    console.log('');

    const deviceCode = deviceResult.data.device_code;
    const userCode = deviceResult.data.user_code;
    const verificationUriComplete = deviceResult.data.verification_uri_complete;

    // Step 3: Instruct user to authenticate
    console.log('🌐 Step 3: User Authentication Required');
    console.log('⚠️  MANUAL ACTION REQUIRED:');
    console.log('');
    console.log('1. Open this URL in your browser:');
    console.log('   ', verificationUriComplete);
    console.log('');
    console.log('2. Enter this code when prompted:');
    console.log('   ', userCode);
    console.log('');
    console.log('3. Complete the authentication process');
    console.log('');
    console.log('4. Press Enter when you have completed authentication...');
    console.log('');

    // Wait for user to complete authentication
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    await new Promise((resolve) => {
      rl.question('Press Enter when authentication is complete...', resolve);
    });
    rl.close();
    console.log('');

    // Step 4: Poll for token
    console.log('⏳ Step 4: Polling for access token...');
    const maxAttempts = 30;
    const pollInterval = deviceResult.data.interval * 1000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      console.log(`  Attempt ${attempt}/${maxAttempts}...`);

      const tokenResult = await makeFormRequest('https://chat.qwen.ai/api/v1/oauth2/token', {
        method: 'POST',
        body: {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: clientId,
          device_code: deviceCode,
          code_verifier: codeVerifier
        }
      });

      if (tokenResult.ok) {
        console.log('✅ Access token obtained!');
        console.log('  - Access Token:', tokenResult.data.access_token.substring(0, 20) + '...');
        console.log('  - Refresh Token:', tokenResult.data.refresh_token ? 'Present' : 'Missing');
        console.log('  - Token Type:', tokenResult.data.token_type);
        console.log('  - Expires In:', tokenResult.data.expires_in, 'seconds');
        console.log('  - Scope:', tokenResult.data.scope);
        console.log('');

        // Step 5: Save token
        console.log('💾 Step 5: Saving token...');
        const tokenData = {
          status: 'success',
          access_token: tokenResult.data.access_token,
          refresh_token: tokenResult.data.refresh_token,
          token_type: tokenResult.data.token_type,
          expires_in: tokenResult.data.expires_in,
          scope: tokenResult.data.scope,
          resource_url: tokenResult.data.resource_url,
          code_verifier: codeVerifier,
          expires_at: new Date(Date.now() + tokenResult.data.expires_in * 1000).toISOString()
        };

        const tokenFile = path.join(homedir(), '.qwen/oauth_creds.json');
        await fs.mkdir(path.dirname(tokenFile), { recursive: true });
        await fs.writeFile(tokenFile, JSON.stringify(tokenData, null, 2));
        console.log('  - Token saved to:', tokenFile);
        console.log('');

        // Step 6: Test the token
        console.log('🧪 Step 6: Testing the new token...');

        const testResult = await makeRequest('https://chat.qwen.ai/api/v1/models', {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${tokenResult.data.access_token}`
          }
        });

        if (testResult.ok) {
          console.log('✅ Token test successful!');
          console.log('  - Available Models:', testResult.data.data?.length || 0);
          if (testResult.data.data && testResult.data.data.length > 0) {
            console.log('  - First Model:', testResult.data.data[0].id);
          }
        } else {
          console.log('❌ Token test failed:', testResult.error);
        }

        console.log('');
        console.log('🎉 OAuth Device Flow Test Complete!');
        return;
      } else {
        const errorData = JSON.parse(tokenResult.error);
        const errorType = errorData.error;

        if (errorType === 'authorization_pending') {
          console.log('  ⏳ Authorization pending...');
        } else if (errorType === 'slow_down') {
          console.log('  🐌 Slow down requested...');
          // Increase interval slightly
          await new Promise(resolve => setTimeout(resolve, pollInterval * 1.5));
          continue;
        } else if (errorType === 'expired_token') {
          console.log('  ⏰ Device code expired');
          console.log('❌ Please restart the authentication process');
          return;
        } else if (errorType === 'access_denied') {
          console.log('  🚫 Access denied by user');
          console.log('❌ Please restart the authentication process');
          return;
        } else {
          console.log('  ❌ Unexpected error:', errorType, errorData.error_description);
          return;
        }
      }

      // Wait before next attempt
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    console.log('❌ Token polling timeout');
    console.log('Please restart the authentication process');

  } catch (error) {
    console.error('❌ Test failed with error:', error);
    console.error('Stack:', error.stack);
  }
}

// Run the test
testOAuthDeviceFlow();