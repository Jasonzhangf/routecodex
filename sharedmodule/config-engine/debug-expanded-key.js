#!/usr/bin/env node

// Debug why 'expanded-key' is being detected as sensitive
console.log('=== Debug Why expanded-key is Sensitive ===\n');

import { containsSensitiveData, sanitizeString } from '../config-engine/dist/utils/secret-sanitization.js';

const expandedKey = 'expanded-key';
console.log('Testing string:', expandedKey);
console.log('containsSensitiveData result:', containsSensitiveData(expandedKey));

// Test each pattern individually
const { SECRET_PATTERNS } = '../config-engine/dist/utils/secret-sanitization.js';

console.log('\nTesting each pattern:');

// Test API key patterns
SECRET_PATTERNS.apiKey.forEach((pattern, index) => {
  pattern.lastIndex = 0;
  const matches = pattern.test(expandedKey);
  console.log(`API key pattern ${index}:`, matches);
  pattern.lastIndex = 0;
});

// Test token patterns
SECRET_PATTERNS.token.forEach((pattern, index) => {
  pattern.lastIndex = 0;
  const matches = pattern.test(expandedKey);
  console.log(`Token pattern ${index}:`, matches);
  pattern.lastIndex = 0;
});

// Test generic pattern
SECRET_PATTERNS.genericLongString.forEach((pattern, index) => {
  pattern.lastIndex = 0;
  const matches = pattern.test(expandedKey);
  console.log(`Generic pattern ${index}:`, matches);
  pattern.lastIndex = 0;
});

// Test secret keys pattern
SECRET_PATTERNS.secretKeys.forEach((pattern, index) => {
  pattern.lastIndex = 0;
  const matches = pattern.test(expandedKey);
  console.log(`Secret keys pattern ${index}:`, matches);
  pattern.lastIndex = 0;
});