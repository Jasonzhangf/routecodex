#!/usr/bin/env node

/**
 * Debug script to test secret sanitization patterns
 */

import { sanitizeString, containsSensitiveData, SECRET_PATTERNS } from './src/utils/secret-sanitization.js';

console.log('=== Secret Sanitization Debug Test ===\n');

// Test 1: Check API key length requirements
const shortApiKey = 'sk-abc123def456'; // 15 chars
const longApiKey = 'sk-abc123def456ghijklmnopqrstuvwxyz1234567890abcdef'; // 51 chars

console.log('1. Testing API key length requirements:');
console.log(`Short API key (${shortApiKey.length} chars):`, shortApiKey);
console.log(`Long API key (${longApiKey.length} chars):`, longApiKey);

console.log('\n2. Testing containsSensitiveData:');
console.log('Short API key contains sensitive data:', containsSensitiveData(shortApiKey));
console.log('Long API key contains sensitive data:', containsSensitiveData(longApiKey));

console.log('\n3. Testing sanitizeString:');
console.log('Short API key sanitized:', sanitizeString(shortApiKey));
console.log('Long API key sanitized:', sanitizeString(longApiKey));

// Test 4: Test individual patterns
console.log('\n4. Testing individual patterns:');
const apiKeyPattern = SECRET_PATTERNS.apiKey[0]; // /sk-[a-zA-Z0-9]{10,}/g
console.log('API Key pattern:', apiKeyPattern);
console.log('Short API key matches pattern:', apiKeyPattern.test(shortApiKey));
console.log('Long API key matches pattern:', apiKeyPattern.test(longApiKey));

// Test 5: Test other patterns
const testCases = [
  { name: 'Bearer token', value: 'Bearer abc123def456ghijklmnopqrstuvwxyz1234567890abcdef' },
  { name: 'GitHub token', value: 'ghp_abc123def456ghijklmnopqrstuvwxyz123456' },
  { name: 'URL with credentials', value: 'https://user:password@example.com' },
  { name: 'Password field', value: '"password": "secret123"' },
  { name: 'Generic long string', value: 'abc123def456ghijklmnopqrstuvwxyz1234567890abcdef' }
];

console.log('\n5. Testing other patterns:');
testCases.forEach(({ name, value }) => {
  console.log(`${name}:`);
  console.log(`  Original: ${value}`);
  console.log(`  Contains sensitive: ${containsSensitiveData(value)}`);
  console.log(`  Sanitized: ${sanitizeString(value)}`);
  console.log();
});