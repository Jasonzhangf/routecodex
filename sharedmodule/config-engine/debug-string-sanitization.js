#!/usr/bin/env node

import { sanitizeString, SECRET_PATTERNS } from '../config-engine/dist/utils/secret-sanitization.js';

console.log('=== Debug String Sanitization ===\n');

const testString = 'API key: sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx234yz567';
console.log('Original string:', testString);

// Test all patterns
console.log('\nTesting all patterns:');

Object.entries(SECRET_PATTERNS).forEach(([category, patterns]) => {
  console.log(`\n${category} patterns:`);
  patterns.forEach((pattern, index) => {
    console.log(`  Pattern ${index}:`, pattern);
    const matches = testString.match(pattern);
    console.log(`  Matches:`, matches);
    if (matches) {
      const replaced = testString.replace(pattern, '***REDACTED***');
      console.log(`  After replacement:`, replaced);
    }
  });
});

// Test full sanitization
console.log('\nFull sanitization result:');
const sanitized = sanitizeString(testString);
console.log('Sanitized:', sanitized);