#!/usr/bin/env node

/**
 * Debug multiple codex samples to understand their format
 */

import { AjvSchemaMapper } from './dist/core/schema-mapper.js';
import fs from 'fs/promises';

const schemaMapper = new AjvSchemaMapper();

async function debugSamples() {
  try {
    const sampleFiles = [
      '/Users/fanzhang/.routecodex/codex-samples/provider-out-openai_1760308489841_iq4xix.json',
      '/Users/fanzhang/.routecodex/codex-samples/provider-out-openai_1760308493268_rt2rg9.json',
      '/Users/fanzhang/.routecodex/codex-samples/pipeline-in-anth_1760308489823.json'
    ];

    for (const samplePath of sampleFiles) {
      console.log('\n' + '='.repeat(60));
      console.log('🧪 Testing sample:', samplePath.split('/').pop());

      const content = await fs.readFile(samplePath, 'utf-8');
      const data = JSON.parse(content);
      const actualData = data.data || data;

      console.log('Sample keys:', Object.keys(actualData));

      // Check if it looks like a request or response
      const isRequestLike = actualData.model && actualData.messages;
      const isResponseLike = actualData.choices && actualData.id;

      console.log('Detected format:', isRequestLike ? 'REQUEST' : isResponseLike ? 'RESPONSE' : 'UNKNOWN');

      if (isRequestLike) {
        // Test as OpenAI request
        const validation = schemaMapper.validateOpenAIRequest(actualData);
        console.log('OpenAI request valid:', validation.valid);
        if (!validation.valid) {
          console.log('First few errors:', validation.errors.slice(0, 2).map(e => e.message));
        }
      } else if (isResponseLike) {
        // Test as OpenAI response
        const validation = schemaMapper.validateOpenAIResponse(actualData);
        console.log('OpenAI response valid:', validation.valid);
        if (!validation.valid) {
          console.log('First few errors:', validation.errors.slice(0, 2).map(e => e.message));
        }
      } else {
        console.log('Cannot determine format - testing both:');

        const requestValidation = schemaMapper.validateOpenAIRequest(actualData);
        const responseValidation = schemaMapper.validateOpenAIResponse(actualData);

        console.log('As request - valid:', requestValidation.valid);
        console.log('As response - valid:', responseValidation.valid);

        if (!requestValidation.valid) {
          console.log('Request errors:', requestValidation.errors.slice(0, 2).map(e => e.message));
        }
        if (!responseValidation.valid) {
          console.log('Response errors:', responseValidation.errors.slice(0, 2).map(e => e.message));
        }
      }
    }

  } catch (error) {
    console.error('Error:', error);
  }
}

debugSamples();