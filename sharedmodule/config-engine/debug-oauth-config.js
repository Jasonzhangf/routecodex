#!/usr/bin/env node

// Debug OAuth token sanitization configuration validation failure
console.log('=== Debug OAuth Token Sanitization Configuration Validation ===\n');

import { CompatibilityEngine } from '../config-compat/dist/index.js';

const configWithOAuth = {
  version: '1.0.0',
  virtualrouter: {
    inputProtocol: 'openai',
    outputProtocol: 'openai',
    providers: {
      'iflow-provider': {
        id: 'iflow-provider',
        type: 'iflow',
        enabled: true,
        auth: {
          type: 'oauth',
          device: {
            clientId: 'test-client-id',
            deviceCodeUrl: 'https://api.example.com/device',
            tokenUrl: 'https://api.example.com/token',
            scopes: ['read', 'write'],
            tokenFile: '/path/to/token'
          }
        },
        models: {
          'test-model': {
            maxTokens: 4000
          }
        }
      }
    },
    routing: {
      default: ['iflow-provider.test-model'],
      thinking: ['iflow-provider.test-model'],
      coding: ['iflow-provider.test-model'],
      longcontext: ['iflow-provider.test-model'],
      tools: ['iflow-provider.test-model'],
      vision: ['iflow-provider.test-model'],
      websearch: ['iflow-provider.test-model'],
      background: ['iflow-provider.test-model']
    }
  }
};

try {
  console.log('Testing OAuth configuration with sanitization enabled...');
  const engine = new CompatibilityEngine({ sanitizeOutput: true });
  const result = await engine.processCompatibility(JSON.stringify(configWithOAuth));

  console.log('Result:', JSON.stringify(result, null, 2));
  console.log('\nisValid:', result.isValid);
  console.log('Errors:', result.errors);

  if (result.normalized) {
    const providerConfig = result.normalized.virtualrouter?.providers?.['iflow-provider'];
    console.log('\nProvider config oauth section:', JSON.stringify(providerConfig?.oauth, null, 2));
  }

} catch (error) {
  console.error('Error:', error);
}