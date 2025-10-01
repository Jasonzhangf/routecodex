#!/usr/bin/env node

// Debug expandEnvVar function
console.log('=== Debug expandEnvVar Function ===\n');

// Test the expandEnvVar function directly
function expandEnvVar(str) {
  if (typeof str !== 'string') {
    return str;
  }

  return str.replace(/\$\{([^}]+)\}/g, (match, envVar) => {
    const envValue = process.env[envVar];
    return envValue !== undefined ? envValue : match;
  });
}

// Set test environment variable
process.env.TEST_API_KEY = 'expanded-key';

// Test expansion
const testString = '${TEST_API_KEY}';
console.log('Test string:', testString);
console.log('Expanded result:', expandEnvVar(testString));

// Test with real environment variable
console.log('\nWith TEST_API_KEY set to "expanded-key":');
console.log('Expanded result:', expandEnvVar(testString));

// Test mixed content
const mixedString = 'API key: ${TEST_API_KEY} and other content';
console.log('\nMixed content:', mixedString);
console.log('Expanded result:', expandEnvVar(mixedString));