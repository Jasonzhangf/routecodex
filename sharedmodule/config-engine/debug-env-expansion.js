#!/usr/bin/env node

// Debug environment variable expansion
import { containsSensitiveData, sanitizeString } from '../config-engine/dist/utils/secret-sanitization.js';

console.log('=== Debug Environment Variable Expansion ===\n');

// Test environment variable pattern
const envVarString = '${TEST_API_KEY}';
console.log('Testing environment variable pattern:', envVarString);
console.log('containsSensitiveData result:', containsSensitiveData(envVarString));
console.log('sanitizeString result:', sanitizeString(envVarString));

// Test with actual environment variable
process.env.TEST_API_KEY = 'expanded-key';
console.log('\nWith TEST_API_KEY set to "expanded-key":');
console.log('containsSensitiveData result:', containsSensitiveData(envVarString));
console.log('sanitizeString result:', sanitizeString(envVarString));

// Test mixed content
const mixedString = 'API key: ${TEST_API_KEY} and other content';
console.log('\nTesting mixed content:', mixedString);
console.log('containsSensitiveData result:', containsSensitiveData(mixedString));
console.log('sanitizeString result:', sanitizeString(mixedString));