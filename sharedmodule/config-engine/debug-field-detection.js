#!/usr/bin/env node

// Debug field detection for 'apiKey'
console.log('=== Debug Field Detection for apiKey ===\n');

import { shouldSanitizeField } from '../config-engine/dist/utils/secret-sanitization.js';

const fieldValue = 'expanded-key';
console.log('Testing field name: apiKey');
console.log('Field value:', fieldValue);
console.log('shouldSanitizeField result:', shouldSanitizeField('apiKey', fieldValue));

// Test variations
console.log('\nTesting variations:');
console.log('apiKey (lowercase):', shouldSanitizeField('apikey', fieldValue));
console.log('API_KEY (uppercase):', shouldSanitizeField('API_KEY', fieldValue));
console.log('api_key (snake_case):', shouldSanitizeField('api_key', fieldValue));