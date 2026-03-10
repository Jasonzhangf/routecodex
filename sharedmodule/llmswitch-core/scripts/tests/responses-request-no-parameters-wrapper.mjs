#!/usr/bin/env node
/**
 * Regression: buildResponsesRequestFromChat must NOT emit a top-level `parameters` object
 * in the outbound `/v1/responses` request, because some upstream providers reject it.
 *
 * Instead, supported keys from `chat.parameters` / `ctx.parameters` must be flattened into
 * the top-level request fields.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

async function loadBridge() {
  return import(pathToFileURL(path.join(repoRoot, 'dist', 'conversion', 'responses', 'responses-openai-bridge.js')).href);
}

async function main() {
  const { buildResponsesRequestFromChat } = await loadBridge();

  const chatPayload = {
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hi' }],
    parameters: {
      temperature: 0.2,
      max_tokens: 123
    }
  };

  const built = buildResponsesRequestFromChat(chatPayload, { stream: false });
  const req = built.request;

  assert.ok(req && typeof req === 'object', 'expected request object');
  assert.equal((req).model, 'gpt-test', 'expected model');
  assert.ok(!('parameters' in req), 'expected no top-level parameters object');
  assert.equal((req).temperature, 0.2, 'expected temperature flattened');
  assert.equal((req).max_output_tokens, 123, 'expected max_tokens mapped to max_output_tokens');

  console.log('✅ responses request must not include parameters wrapper regression passed');
}

main().catch((err) => {
  console.error('❌ responses request parameters wrapper regression failed:', err);
  process.exit(1);
});

