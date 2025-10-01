#!/usr/bin/env node

// Debug basic configuration validation failures
console.log('=== Debug Basic Configuration Validation Failures ===\n');

import { CompatibilityEngine } from '../config-compat/dist/index.js';
import { BLACKBOX_TEST_CASES } from './dist/index.js';

// Test basic validation case
console.log('Testing basic validation case...');
const basicTestCase = BLACKBOX_TEST_CASES[0]; // basic-validation
console.log('Input config:', JSON.stringify(basicTestCase.inputConfig, null, 2));

const engine = new CompatibilityEngine({ sanitizeOutput: false });
const result = await engine.processCompatibility(JSON.stringify(basicTestCase.inputConfig));

console.log('\nResult:', JSON.stringify(result, null, 2));
console.log('\nisValid:', result.isValid);
console.log('Errors:', result.errors);

if (result.normalized) {
  console.log('\nNormalized config:', JSON.stringify(result.normalized, null, 2));

  // Check specific expected normalizations
  const openaiProvider = result.normalized.virtualrouter?.providers?.['openai-provider'];
  console.log('\nOpenAI provider type:', openaiProvider?.type);
  console.log('Expected: openai-provider');

  // Compare with expected
  console.log('\n=== Expected vs Actual ===');
  console.log('Expected providers:', JSON.stringify(basicTestCase.expectedOutput.normalized.virtualrouter.providers, null, 2));
  console.log('Actual providers:', JSON.stringify(result.normalized.virtualrouter.providers, null, 2));
}

console.log('\n=== End Debug ===');