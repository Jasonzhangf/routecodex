#!/usr/bin/env node

/**
 * OAuth Configuration Validation Script
 * 验证OAuth配置的正确性
 */

import fs from 'fs';
import path from 'path';

const CONFIG_FILES = [
  'config/oauth-providers.json',
  'config/merged-config.json'
];

const REQUIRED_OAUTH_FIELDS = {
  deviceCodeUrl: 'https://chat.qwen.ai/api/v1/oauth2/device/code',
  tokenUrl: 'https://chat.qwen.ai/api/v1/oauth2/token',
  clientId: 'f0304373b74a44d2b584a3fb70ca9e56',
  scopes: ['openid', 'profile', 'email', 'model.completion']
};

const EXPECTED_API_ENDPOINT = 'https://portal.qwen.ai/v1';

function loadConfig(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.log(`❌ Failed to load ${filePath}: ${error.message}`);
    return null;
  }
}

function validateOAuthConfig(config, configPath) {
  console.log(`\n=== Validating ${configPath} ===`);

  let isValid = true;
  const issues = [];

  // Check pipeline configuration
  if (config.pipeline && config.pipeline.provider && config.pipeline.provider.config) {
    const providerConfig = config.pipeline.provider.config;

    console.log('Checking pipeline provider config...');

    // Validate baseUrl
    if (providerConfig.baseUrl !== EXPECTED_API_ENDPOINT) {
      issues.push(`baseUrl mismatch: expected ${EXPECTED_API_ENDPOINT}, got ${providerConfig.baseUrl}`);
      isValid = false;
    } else {
      console.log('✅ baseUrl is correct');
    }

    // Validate OAuth configuration
    if (providerConfig.auth && providerConfig.auth.oauth) {
      const oauthConfig = providerConfig.auth.oauth;

      for (const [field, expectedValue] of Object.entries(REQUIRED_OAUTH_FIELDS)) {
        const actualValue = oauthConfig[field];

        if (actualValue === undefined) {
          issues.push(`Missing OAuth field: ${field}`);
          isValid = false;
        } else if (field === 'scopes' && Array.isArray(actualValue)) {
          const requiredScopes = REQUIRED_OAUTH_FIELDS.scopes;
          const missingScopes = requiredScopes.filter(scope => !actualValue.includes(scope));

          if (missingScopes.length > 0) {
            issues.push(`Missing OAuth scopes: ${missingScopes.join(', ')}`);
            isValid = false;
          } else {
            console.log(`✅ OAuth ${field} is correct`);
          }
        } else if (actualValue !== expectedValue) {
          issues.push(`OAuth ${field} mismatch: expected ${expectedValue}, got ${actualValue}`);
          isValid = false;
        } else {
          console.log(`✅ OAuth ${field} is correct`);
        }
      }
    } else {
      issues.push('Missing OAuth configuration in pipeline provider');
      isValid = false;
    }
  } else {
    issues.push('Missing pipeline provider configuration');
    isValid = false;
  }

  // Check providers configuration
  if (config.providers && config.providers.qwen) {
    const qwenConfig = config.providers.qwen;

    console.log('Checking providers.qwen config...');

    // Validate baseUrl
    if (qwenConfig.baseUrl !== EXPECTED_API_ENDPOINT) {
      issues.push(`qwen baseUrl mismatch: expected ${EXPECTED_API_ENDPOINT}, got ${qwenConfig.baseUrl}`);
      isValid = false;
    } else {
      console.log('✅ qwen baseUrl is correct');
    }

    // Validate OAuth configuration
    if (qwenConfig.auth && qwenConfig.auth.oauth) {
      const oauthConfig = qwenConfig.auth.oauth;

      for (const [field, expectedValue] of Object.entries(REQUIRED_OAUTH_FIELDS)) {
        const actualValue = oauthConfig[field];

        if (actualValue === undefined) {
          issues.push(`Missing qwen OAuth field: ${field}`);
          isValid = false;
        } else if (field === 'scopes' && Array.isArray(actualValue)) {
          const requiredScopes = REQUIRED_OAUTH_FIELDS.scopes;
          const missingScopes = requiredScopes.filter(scope => !actualValue.includes(scope));

          if (missingScopes.length > 0) {
            issues.push(`Missing qwen OAuth scopes: ${missingScopes.join(', ')}`);
            isValid = false;
          } else {
            console.log(`✅ qwen OAuth ${field} is correct`);
          }
        } else if (actualValue !== expectedValue) {
          issues.push(`qwen OAuth ${field} mismatch: expected ${expectedValue}, got ${actualValue}`);
          isValid = false;
        } else {
          console.log(`✅ qwen OAuth ${field} is correct`);
        }
      }
    } else {
      issues.push('Missing OAuth configuration in qwen provider');
      isValid = false;
    }
  } else {
    issues.push('Missing qwen provider configuration');
    isValid = false;
  }

  // Report issues
  if (issues.length > 0) {
    console.log('❌ Issues found:');
    issues.forEach(issue => console.log(`   - ${issue}`));
  } else {
    console.log('✅ Configuration is valid');
  }

  return isValid;
}

function validateTokenFormat() {
  console.log('\n=== Validating Token Format ===');

  const tokenFiles = [
    path.join(process.env.HOME, '.routecodex', 'tokens', 'qwen-token.json'),
    './qwen-token.json',
    path.join(process.env.HOME, '.qwen', 'oauth_creds.json')
  ];

  for (const tokenFile of tokenFiles) {
    if (fs.existsSync(tokenFile)) {
      console.log(`\nChecking token file: ${tokenFile}`);

      try {
        const tokenData = JSON.parse(fs.readFileSync(tokenFile, 'utf-8'));

        const requiredFields = ['access_token', 'token_type', 'expires_in', 'scope'];
        const optionalFields = ['refresh_token', 'expires_at', 'created_at', 'provider', 'client_id'];

        const missingFields = requiredFields.filter(field => !tokenData[field]);
        const presentOptionalFields = optionalFields.filter(field => tokenData[field]);

        if (missingFields.length === 0) {
          console.log('✅ All required fields present');

          if (presentOptionalFields.length >= 3) {
            console.log('✅ Good CLIProxyAPI compatibility');
          } else {
            console.log('⚠️  Limited CLIProxyAPI compatibility');
          }

          // Check if token is expired
          if (tokenData.expires_at) {
            const isExpired = tokenData.expires_at <= Date.now();
            console.log(`Token expired: ${isExpired ? 'Yes' : 'No'}`);
          }

        } else {
          console.log(`❌ Missing required fields: ${missingFields.join(', ')}`);
        }

      } catch (error) {
        console.log(`❌ Failed to parse token file: ${error.message}`);
      }
    }
  }
}

function checkSourceCodeConsistency() {
  console.log('\n=== Checking Source Code Consistency ===');

  const sourceFiles = [
    'src/modules/pipeline/modules/provider/qwen-provider.ts'
  ];

  for (const sourceFile of sourceFiles) {
    if (fs.existsSync(sourceFile)) {
      console.log(`\nChecking source file: ${sourceFile}`);

      const content = fs.readFileSync(sourceFile, 'utf-8');

      // Check for hardcoded endpoints
      const hardcodedEndpoints = content.match(/https:\/\/[^'"\s]+/g) || [];
      const problematicEndpoints = hardcodedEndpoints.filter(endpoint =>
        endpoint.includes('portal.qwen.ai') || endpoint.includes('chat.qwen.ai')
      );

      if (problematicEndpoints.length > 0) {
        console.log('Found hardcoded endpoints:');
        problematicEndpoints.forEach(endpoint => console.log(`   - ${endpoint}`));
      } else {
        console.log('✅ No problematic hardcoded endpoints found');
      }

      // Check for OAuth configuration
      const hasOAuthConfig = content.includes('oauth') && content.includes('deviceCodeUrl');
      console.log(`OAuth configuration present: ${hasOAuthConfig ? 'Yes' : 'No'}`);

      // Check for PKCE support
      const hasPKCESupport = content.includes('code_challenge') && content.includes('code_verifier');
      console.log(`PKCE support present: ${hasPKCESupport ? 'Yes' : 'No'}`);

    } else {
      console.log(`⚠️  Source file not found: ${sourceFile}`);
    }
  }
}

async function main() {
  console.log('🔍 OAuth Configuration Validation');
  console.log('================================');

  let allValid = true;

  // Validate all config files
  for (const configPath of CONFIG_FILES) {
    if (fs.existsSync(configPath)) {
      const config = loadConfig(configPath);
      if (config) {
        const isValid = validateOAuthConfig(config, configPath);
        allValid = allValid && isValid;
      }
    } else {
      console.log(`⚠️  Config file not found: ${configPath}`);
    }
  }

  // Validate token format
  validateTokenFormat();

  // Check source code consistency
  checkSourceCodeConsistency();

  console.log('\n=== Validation Summary ===');
  if (allValid) {
    console.log('✅ All configurations are valid');
  } else {
    console.log('❌ Some configurations have issues');
  }

  console.log('\n💡 Recommendations:');
  console.log('1. Ensure all OAuth endpoints are correct');
  console.log('2. Use consistent API endpoints across all configurations');
  console.log('3. Verify token format includes CLIProxyAPI compatibility fields');
  console.log('4. Test OAuth flow with real authentication');
  console.log('5. Monitor token refresh behavior in production');

  console.log('\n🎯 Expected Configuration:');
  console.log(`API Endpoint: ${EXPECTED_API_ENDPOINT}`);
  console.log(`Device Code URL: ${REQUIRED_OAUTH_FIELDS.deviceCodeUrl}`);
  console.log(`Token URL: ${REQUIRED_OAUTH_FIELDS.tokenUrl}`);
  console.log(`Client ID: ${REQUIRED_OAUTH_FIELDS.clientId}`);
  console.log(`Scopes: ${REQUIRED_OAUTH_FIELDS.scopes.join(', ')}`);
}

// Run validation
main().catch(error => {
  console.error('❌ Validation failed:', error);
  process.exit(1);
});