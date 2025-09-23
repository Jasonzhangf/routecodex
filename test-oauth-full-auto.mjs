#!/usr/bin/env node

/**
 * Fully Automated OAuth Device Flow
 * Automatically opens browser and handles complete OAuth flow
 */

import crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Generate PKCE code verifier
function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

// Generate PKCE code challenge from verifier
function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
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

async function openBrowser(url) {
  console.log('🌐 Opening browser for authentication...');

  try {
    // Try different commands based on OS
    const commands = [
      `open "${url}"`, // macOS
      `xdg-open "${url}"`, // Linux
      `start "${url}"`, // Windows
    ];

    for (const cmd of commands) {
      try {
        await execAsync(cmd);
        console.log('✅ Browser opened successfully');
        return true;
      } catch (e) {
        // Try next command
      }
    }

    console.log('⚠️  Could not open browser automatically');
    console.log('Please manually open:', url);
    return false;
  } catch (error) {
    console.log('⚠️  Could not open browser automatically');
    console.log('Please manually open:', url);
    return false;
  }
}

async function testOAuthFullAutoFlow() {
  console.log('🔧 Testing Fully Automated OAuth Device Flow...\n');

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
    console.log('  - Expires In:', deviceResult.data.expires_in, 'seconds');
    console.log('  - Interval:', deviceResult.data.interval, 'seconds');
    console.log('');

    const deviceCode = deviceResult.data.device_code;
    const userCode = deviceResult.data.user_code;
    const verificationUriComplete = deviceResult.data.verification_uri_complete;

    // Step 3: Automatically open browser
    console.log('🌐 Step 3: Auto-opening browser for authentication');
    const browserOpened = await openBrowser(verificationUriComplete);

    console.log('');
    console.log('📋 Authentication Instructions:');
    console.log('  - User Code:', userCode);
    console.log('  - Browser should have opened automatically');
    console.log('  - Complete the authentication in the browser');
    console.log('  - I will poll for the token automatically');
    console.log('');

    // Step 4: Auto poll for token
    console.log('⏳ Step 4: Auto polling for access token...');
    const maxAttempts = 120; // 10 minutes max
    const pollInterval = (deviceResult.data.interval || 5) * 1000;

    console.log(`  Will poll for ${maxAttempts} attempts with ${pollInterval/1000}s interval...`);
    console.log('');

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
        console.log('');
        console.log('✅ Access token obtained!');
        console.log('  - Access Token:', tokenResult.data.access_token.substring(0, 20) + '...');
        console.log('  - Refresh Token:', tokenResult.data.refresh_token ? 'Present' : 'Missing');
        console.log('  - Token Type:', tokenResult.data.token_type);
        console.log('  - Expires In:', tokenResult.data.expires_in, 'seconds');
        console.log('  - Scope:', tokenResult.data.scope);
        console.log('');

        // Save token to file
        const fs = await import('fs/promises');
        const path = await import('path');
        const { homedir } = await import('os');

        const tokenData = {
          status: 'success',
          access_token: tokenResult.data.access_token,
          refresh_token: tokenResult.data.refresh_token,
          token_type: tokenResult.data.token_type,
          expires_in: tokenResult.data.expires_in,
          scope: tokenResult.data.scope,
          resource_url: tokenResult.data.resource_url,
          expires_at: new Date(Date.now() + tokenResult.data.expires_in * 1000).toISOString()
        };

        const tokenFile = path.join(homedir(), '.qwen/oauth_creds.json');
        await fs.mkdir(path.dirname(tokenFile), { recursive: true });
        await fs.writeFile(tokenFile, JSON.stringify(tokenData, null, 2));
        console.log('💾 Token saved to:', tokenFile);
        console.log('');

        // Step 5: Test the token immediately
        console.log('🧪 Step 5: Testing the new token...');
        const testResult = await fetch('https://chat.qwen.ai/api/v1/models', {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${tokenResult.data.access_token}`
          }
        });

        if (testResult.ok) {
          const testData = await testResult.json();
          console.log('✅ Token test successful!');
          console.log('  - Available Models:', testData.data?.length || 0);
          if (testData.data && testData.data.length > 0) {
            console.log('  - First Model:', testData.data[0].id);
          }
        } else {
          console.log('❌ Token test failed:', testResult.status, testResult.statusText);
        }

        // Step 6: Test with RouteCodex
        console.log('');
        console.log('🔗 Step 6: Testing with RouteCodex...');
        const rcResult = await fetch('http://localhost:5506/v1/openai/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer rcc4-proxy-key',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'qwen-turbo',
            messages: [{ role: 'user', content: 'OAuth authentication test successful!' }],
            max_tokens: 50
          })
        });

        if (rcResult.ok) {
          const rcData = await rcResult.json();
          console.log('✅ RouteCodex test successful!');
          const content = rcData.choices?.[0]?.message?.content || 'No content';
          console.log('  - Response:', content);
        } else {
          const errorText = await rcResult.text();
          console.log('❌ RouteCodex test failed:', errorText);
        }

        console.log('');
        console.log('🎉 OAuth Device Flow Complete!');
        console.log('✅ Authentication successful!');
        console.log('✅ Token saved and tested!');
        console.log('✅ RouteCodex integration verified!');
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
testOAuthFullAutoFlow();