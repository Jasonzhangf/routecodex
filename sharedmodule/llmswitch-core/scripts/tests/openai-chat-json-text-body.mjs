#!/usr/bin/env node
/**
 * Regression: some upstreams mislabel JSON bodies (wrong Content-Type),
 * causing HTTP clients to surface provider responses as plain strings.
 *
 * Hub response pipeline must best-effort parse JSON strings before semantic mapping.
 */

import assert from 'node:assert/strict';
import { convertProviderResponse } from '../../dist/conversion/index.js';

async function main() {
  const chatCompletion = {
    id: 'chatcmpl_text_json',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'kimi-k2.5',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'ok' }
      }
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  };

  const ctx = {
    requestId: 'req_text_json_1',
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-chat'
  };

  for (const variant of [
    { name: 'plain', body: JSON.stringify(chatCompletion) },
    { name: 'anti-xssi prefix', body: `)]}',\n${JSON.stringify(chatCompletion)}` },
    { name: 'data prefix', body: `data: ${JSON.stringify(chatCompletion)}` }
  ]) {
    const converted = await convertProviderResponse({
      providerProtocol: 'openai-chat',
      providerResponse: variant.body,
      context: { ...ctx, requestId: `req_text_json_${variant.name.replaceAll(' ', '_')}` },
      entryEndpoint: '/v1/responses',
      wantsStream: false
    });

    const body = converted.body;
    assert.ok(body && typeof body === 'object', `[${variant.name}] missing converted.body`);
    assert.equal(body.object, 'response', `[${variant.name}] should remap to responses for /v1/responses`);
    assert.equal(body.status, 'completed', `[${variant.name}] status should be completed`);
    assert.equal(body.output?.[0]?.type, 'message', `[${variant.name}] output[0].type should be message`);
    assert.equal(body.output?.[0]?.content?.[0]?.type, 'output_text', `[${variant.name}] content[0].type should be output_text`);
    assert.equal(body.output?.[0]?.content?.[0]?.text, 'ok', `[${variant.name}] output text mismatch`);
  }

  // eslint-disable-next-line no-console
  console.log('[matrix:openai-chat-json-text-body] ok');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[matrix:openai-chat-json-text-body] failed', err);
  process.exit(1);
});
