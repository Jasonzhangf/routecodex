#!/usr/bin/env node

// Debug nested object password sanitization
console.log('=== Debug Nested Object Password Sanitization ===\n');

import { containsSensitiveData, sanitizeObject, shouldSanitizeField } from '../config-engine/dist/utils/secret-sanitization.js';

const testPassword = 'secret123';
console.log('Testing password value:', testPassword);
console.log('containsSensitiveData result:', containsSensitiveData(testPassword));

// Test the field detection
console.log('\nField detection tests:');
console.log('shouldSanitizeField for password:', shouldSanitizeField('password', testPassword));
console.log('shouldSanitizeField for credentials:', shouldSanitizeField('credentials', testPassword));

// Test nested object structure
const config = {
  auth: {
    credentials: {
      username: 'user',
      password: 'secret123',
      tokens: {
        access: 'bearer-token-123',
        refresh: 'refresh-token-456'
      }
    }
  },
  safe: {
    data: 'public-info'
  }
};

console.log('\nTesting nested object:');
const sanitized = sanitizeObject(config);
console.log('Password value in sanitized object:', sanitized.auth.credentials.password);