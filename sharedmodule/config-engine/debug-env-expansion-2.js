#!/usr/bin/env node

// Debug environment variable expansion issue
console.log('=== Debug Environment Variable Expansion ===\n');

// Test the environment variable pattern exclusion
import { containsSensitiveData, sanitizeString } from '../config-engine/dist/utils/secret-sanitization.js';

// Set test environment variable
process.env.TEST_API_KEY = 'expanded-key';

const testString = '${TEST_API_KEY}';
console.log('Test string:', testString);
console.log('containsSensitiveData result:', containsSensitiveData(testString));
console.log('sanitizeString result:', sanitizeString(testString));

// Test the expandEnvVar function from compatibility engine
function expandEnvVar(str) {
  if (typeof str !== 'string') {
    return str;
  }

  return str.replace(/\$\{([^}]+)\}/g, (match, envVar) => {
    const envValue = process.env[envVar];
    return envValue !== undefined ? envValue : match;
  });
}

console.log('\nWith TEST_API_KEY set to "expanded-key":');
console.log('expandEnvVar result:', expandEnvVar(testString));
console.log('containsSensitiveData after expansion:', containsSensitiveData(expandEnvVar(testString)));