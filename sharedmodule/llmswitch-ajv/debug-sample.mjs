#!/usr/bin/env node

/**
 * Debug specific codex sample validation
 */

import { AjvSchemaMapper } from './dist/core/schema-mapper.js';
import fs from 'fs/promises';

const schemaMapper = new AjvSchemaMapper();

async function debugSample() {
  try {
    // Load one of the failing samples
    const samplePath = '/Users/fanzhang/.routecodex/codex-samples/provider-out-openai_1760308489888_vxb9ut.json';
    const content = await fs.readFile(samplePath, 'utf-8');
    const data = JSON.parse(content);

    console.log('🧪 Testing sample:', samplePath);
    console.log('Sample type: data in file');
    console.log('Sample keys:', Object.keys(data));

    // Test validation
    const validation = schemaMapper.validateOpenAIResponse(data);
    console.log('Valid:', validation.valid);

    if (!validation.valid) {
      console.log('\n❌ Validation errors:');
      validation.errors.forEach((error, index) => {
        console.log(`${index + 1}. ${error.instancePath || 'root'}: ${error.message}`);
        console.log(`   Schema path: ${error.schemaPath}`);
        console.log(`   Value: ${JSON.stringify(error.data)}`);
      });
    }

    // Try with just the data field if it exists
    if (data.data) {
      console.log('\n🧪 Testing data.data field:');
      const dataValidation = schemaMapper.validateOpenAIResponse(data.data);
      console.log('Data valid:', dataValidation.valid);

      if (!dataValidation.valid) {
        console.log('\n❌ Data validation errors:');
        dataValidation.errors.forEach((error, index) => {
          console.log(`${index + 1}. ${error.instancePath || 'root'}: ${error.message}`);
          console.log(`   Schema path: ${error.schemaPath}`);
          console.log(`   Value: ${JSON.stringify(error.data)}`);
        });
      }
    }

  } catch (error) {
    console.error('Error:', error);
  }
}

debugSample();