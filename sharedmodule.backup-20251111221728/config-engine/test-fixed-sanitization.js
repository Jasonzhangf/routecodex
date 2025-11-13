#!/usr/bin/env node

// Test the fixed secret sanitization
console.log('=== Testing Fixed Secret Sanitization ===\n');

import { sanitizeObject, shouldSanitizeField, containsSensitiveData } from '../config-engine/dist/utils/secret-sanitization.js';

// Test case that should now work: apiKey field with non-sensitive value
const testObj = {
  apiKey: 'expanded-key', // This should NOT be redacted anymore
  normalField: 'some value',
  secretApiKey: 'sk-proj-abc123def456ghi789jkl' // This should still be redacted
};

console.log('Testing object:', JSON.stringify(testObj, null, 2));
console.log('shouldSanitizeField for apiKey:', shouldSanitizeField('apiKey', 'expanded-key'));
console.log('containsSensitiveData for expanded-key:', containsSensitiveData('expanded-key'));
console.log('shouldSanitizeField for secretApiKey:', shouldSanitizeField('secretApiKey', 'sk-proj-abc123def456ghi789jkl'));
console.log('containsSensitiveData for sk-proj-abc123def456ghi789jkl:', containsSensitiveData('sk-proj-abc123def456ghi789jkl'));

const sanitized = sanitizeObject(testObj);
console.log('\nSanitized result:', JSON.stringify(sanitized, null, 2));

// Check specific values
const apiKeyValue = sanitized.apiKey;
const secretApiKeyValue = sanitized.secretApiKey;
const normalFieldValue = sanitized.normalField;

console.log('\nResults:');
console.log('apiKey value:', apiKeyValue, '(should be "expanded-key")');
console.log('secretApiKey value:', secretApiKeyValue, '(should be "***REDACTED***")');
console.log('normalField value:', normalFieldValue, '(should be "some value")');

// Success criteria
const success = apiKeyValue === 'expanded-key' &&
                secretApiKeyValue === '***REDACTED***' &&
                normalFieldValue === 'some value';

console.log('\nTest result:', success ? 'SUCCESS' : 'FAILED');