#!/usr/bin/env node
/**
 * Regression: OpenAI Responses tool_call_id must be preserved when present.
 *
 * Background:
 * - Some OpenAI-compatible upstreams (e.g. LM Studio) emit tool call ids as `call_*`.
 * - The id must remain stable across:
 *   provider response tool_call → client required_action → submit_tool_outputs.
 * - If the host rewrites ids (e.g. `call_*` → `fc_*`), upstream may terminate streams.
 */

import assert from 'node:assert/strict';
import { convertProviderResponse } from '../../dist/conversion/index.js';

async function main() {
  const providerResponse = {
    id: 'resp_toolcall_preserve',
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: 'lmstudio-qwen',
    output: [
      {
        id: 'fc_provider_1',
        type: 'function_call',
        status: 'completed',
        call_id: 'call_1234567890',
        name: 'exec_command',
        arguments: '{"command":"pwd"}'
      }
    ]
  };

  const ctx = {
    requestId: 'resp_test_req',
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-responses'
  };

  const converted = await convertProviderResponse({
    providerProtocol: 'openai-responses',
    providerResponse,
    context: ctx,
    entryEndpoint: '/v1/responses',
    wantsStream: false
  });

  const body = converted.body;
  assert.ok(body && typeof body === 'object', 'missing converted.body');
  assert.equal(body.object, 'response');
  assert.equal(body.status, 'requires_action');
  assert.equal(body.output?.[0]?.type, 'function_call');
  assert.equal(body.output?.[0]?.status, 'in_progress');
  assert.ok(
    typeof body.output?.[0]?.id === 'string' && body.output[0].id.startsWith('fc_'),
    `expected output[0].id to start with fc_, got ${JSON.stringify(body.output?.[0]?.id)}`
  );
  assert.equal(body.output?.[0]?.call_id, 'call_1234567890');
  assert.equal(body.required_action?.submit_tool_outputs?.tool_calls?.[0]?.id, 'call_1234567890');
  assert.equal(body.required_action?.submit_tool_outputs?.tool_calls?.[0]?.tool_call_id, 'call_1234567890');

  // eslint-disable-next-line no-console
  console.log('[matrix:responses-tool-call-id-preserve] ok');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[matrix:responses-tool-call-id-preserve] failed', err);
  process.exit(1);
});
