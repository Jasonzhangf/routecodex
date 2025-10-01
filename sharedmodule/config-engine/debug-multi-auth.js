#!/usr/bin/env node

import { shouldSanitizeField, containsSensitiveData, sanitizeObject } from '../config-engine/dist/utils/secret-sanitization.js';

console.log('=== Debug Multi-Auth Array Sanitization ===\n');

const testConfig = {
  'provider1': {
    id: 'provider1',
    type: 'openai',
    enabled: true,
    apiKey: ['sk-key1', 'sk-key2', 'sk-key3'],
    auth: {
      bearer: 'Bearer token123456'
    }
  }
};

console.log('Testing field detection:');
console.log('shouldSanitizeField("apiKey", ["sk-key1", "sk-key2", "sk-key3"]):', shouldSanitizeField('apiKey', ['sk-key1', 'sk-key2', 'sk-key3']));
console.log('shouldSanitizeField("bearer", "Bearer token123456"):', shouldSanitizeField('bearer', 'Bearer token123456'));

console.log('\nTesting array content detection:');
const testArray = ['sk-key1', 'sk-key2', 'sk-key3'];
console.log('Array:', testArray);
console.log('containsSensitiveData("sk-key1"):', containsSensitiveData('sk-key1'));
console.log('containsSensitiveData("sk-key2"):', containsSensitiveData('sk-key2'));
console.log('containsSensitiveData("sk-key3"):', containsSensitiveData('sk-key3'));

console.log('\nTesting sanitization:');
const sanitized = sanitizeObject(testConfig);
console.log('Original:', JSON.stringify(testConfig, null, 2));
console.log('Sanitized:', JSON.stringify(sanitized, null, 2));

console.log('\nExpected: apiKey array should be completely redacted');
console.log('Expected: auth.bearer should be redacted');