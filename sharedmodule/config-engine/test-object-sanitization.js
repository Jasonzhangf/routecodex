#!/usr/bin/env node

// Test object sanitization with the updated logic
console.log('=== Testing Object Sanitization with Updated Logic ===\n');

import { sanitizeObject } from '../config-engine/dist/utils/secret-sanitization.js';

// Test case 1: LM Studio API key in apiKey field
console.log('1. Testing LM Studio API key in apiKey field:');
const testObj1 = {
  apiKey: 'lm-studio-api-key-1234567890abcdef'
};

const sanitized1 = sanitizeObject(testObj1);
console.log('Original:', JSON.stringify(testObj1));
console.log('Sanitized:', JSON.stringify(sanitized1));
console.log('apiKey redacted:', sanitized1.apiKey === '***REDACTED***');

// Test case 2: Bearer token in bearer field
console.log('\n2. Testing Bearer token in bearer field:');
const testObj2 = {
  auth: {
    bearer: 'Bearer token123456'
  }
};

const sanitized2 = sanitizeObject(testObj2);
console.log('Original:', JSON.stringify(testObj2));
console.log('Sanitized:', JSON.stringify(sanitized2));
console.log('bearer redacted:', sanitized2.auth.bearer === '***REDACTED***');

// Test case 3: Non-sensitive value in sensitive field (should be preserved)
console.log('\n3. Testing non-sensitive value in sensitive field:');
const testObj3 = {
  apiKey: 'expanded-key' // This should be redacted now due to the fix
};

const sanitized3 = sanitizeObject(testObj3);
console.log('Original:', JSON.stringify(testObj3));
console.log('Sanitized:', JSON.stringify(sanitized3));
console.log('apiKey redacted:', sanitized3.apiKey === '***REDACTED***');

// Test case 4: Sensitive value in non-sensitive field (should be preserved)
console.log('\n4. Testing sensitive value in non-sensitive field:');
const testObj4 = {
  normalField: 'sk-proj-abc123def456ghi789jkl'
};

const sanitized4 = sanitizeObject(testObj4);
console.log('Original:', JSON.stringify(testObj4));
console.log('Sanitized:', JSON.stringify(sanitized4));
console.log('Normal field preserved:', sanitized4.normalField === 'sk-proj-abc123def456ghi789jkl');

// Test case 5: Password field (always redacted)
console.log('\n5. Testing password field:');
const testObj5 = {
  credentials: {
    password: 'secret123'
  }
};

const sanitized5 = sanitizeObject(testObj5);
console.log('Original:', JSON.stringify(testObj5));
console.log('Sanitized:', JSON.stringify(sanitized5));
console.log('Password redacted:', sanitized5.credentials.password === '***REDACTED***');