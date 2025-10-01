#!/usr/bin/env node

// Debug specific failing test cases
console.log('=== Debug Specific Failing Test Cases ===\n');

import { containsSensitiveData, sanitizeString, shouldSanitizeField } from '../config-engine/dist/utils/secret-sanitization.js';

// Test case 1: LM Studio API key not being redacted
console.log('1. Testing LM Studio API key pattern:');
const lmStudioKey = 'lm-studio-api-key-1234567890abcdef';
console.log('Value:', lmStudioKey);
console.log('containsSensitiveData result:', containsSensitiveData(lmStudioKey));

// Test case 2: Bearer token not being redacted
console.log('\n2. Testing Bearer token pattern:');
const bearerToken = 'Bearer token123456';
console.log('Value:', bearerToken);
console.log('containsSensitiveData result:', containsSensitiveData(bearerToken));

// Test case 3: Check field-based detection for bearer field
console.log('\n3. Testing bearer field detection:');
console.log('shouldSanitizeField for bearer field:', shouldSanitizeField('bearer', 'Bearer token123456'));

// Test case 4: Check field-based detection for apiKey field with LM Studio key
console.log('\n4. Testing apiKey field with LM Studio key:');
console.log('shouldSanitizeField for apiKey field:', shouldSanitizeField('apiKey', 'lm-studio-api-key-1234567890abcdef'));

// Test individual patterns
console.log('\n5. Testing individual regex patterns:');

// Test genericLongString pattern
const genericPattern = /[a-fA-F0-9]{32,}/g;
console.log('Generic long string pattern test:', genericPattern.test(lmStudioKey));

// Test token patterns
const bearerPattern = /Bearer\s+[a-zA-Z0-9_\-\.=]{32,}/gi;
console.log('Bearer pattern test:', bearerPattern.test(bearerToken));

// Test with a longer bearer token
const longBearerToken = 'Bearer token12345678901234567890123456789012';
console.log('Long bearer token test:', bearerPattern.test(longBearerToken));

// Test the secretKeys pattern
const secretKeysPattern = /"?(apiKey|api_key|secret|token|password|auth|credential)"?\s*[:=]\s*["']?[^"'\s,}]{8,}/gi;
console.log('Secret keys pattern test on "apiKey: lm-studio-api-key-1234567890abcdef":',
  secretKeysPattern.test('apiKey: lm-studio-api-key-1234567890abcdef'));

// Test sanitization directly
console.log('\n6. Testing direct sanitization:');
console.log('sanitizeString result for LM Studio key:', sanitizeString(lmStudioKey));
console.log('sanitizeString result for Bearer token:', sanitizeString(bearerToken));