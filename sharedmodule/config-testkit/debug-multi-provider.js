#!/usr/bin/env node

// Debug multi-provider configuration validation failures
console.log('=== Debug Multi-Provider Configuration Validation Failures ===\n');

import { CompatibilityEngine } from '../config-compat/dist/index.js';
import { BLACKBOX_TEST_CASES } from './dist/index.js';

// Test multi-provider validation case
console.log('Testing multi-provider validation case...');
const multiProviderTestCase = BLACKBOX_TEST_CASES[1]; // multi-provider-validation
console.log('Input config:', JSON.stringify(multiProviderTestCase.inputConfig, null, 2));

const engine = new CompatibilityEngine({ sanitizeOutput: false });
const result = await engine.processCompatibility(JSON.stringify(multiProviderTestCase.inputConfig));

console.log('\nResult:', JSON.stringify(result, null, 2));
console.log('\nisValid:', result.isValid);
console.log('Errors:', result.errors);

if (result.normalized) {
  console.log('\nNormalized config providers:', JSON.stringify(result.normalized.virtualrouter.providers, null, 2));

  // Check specific expected normalizations
  const openaiProvider = result.normalized.virtualrouter?.providers?.['openai-provider'];
  const lmstudioProvider = result.normalized.virtualrouter?.providers?.['lmstudio-provider'];

  console.log('\nOpenAI provider type:', openaiProvider?.type);
  console.log('Expected: openai-provider');

  console.log('\nLMStudio provider type:', lmstudioProvider?.type);
  console.log('Expected: lmstudio-http');

  // Compare with expected
  console.log('\n=== Expected vs Actual Providers ===');
  console.log('Expected providers:', JSON.stringify(multiProviderTestCase.expectedOutput.normalized.virtualrouter.providers, null, 2));
  console.log('Actual providers:', JSON.stringify(result.normalized.virtualrouter.providers, null, 2));
}

console.log('\n=== End Debug ===');