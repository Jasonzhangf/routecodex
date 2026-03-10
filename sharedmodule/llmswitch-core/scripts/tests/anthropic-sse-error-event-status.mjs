#!/usr/bin/env node
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { convertProviderResponse } from '../../dist/conversion/index.js';

function buildAnthropicErrorSse() {
  return [
    'event: error',
    'data: {"type":"error","error":{"message":"Operation failed","code":500},"request_id":"20260215191233803bd81ea6f04c14"}',
    '',
    ''
  ].join('\n');
}

async function main() {
  const providerResponse = {
    __sse_responses: Readable.from([buildAnthropicErrorSse()])
  };
  const context = {
    requestId: 'req_anthropic_sse_error_500',
    entryEndpoint: '/v1/messages',
    providerProtocol: 'anthropic-messages'
  };

  let caught = null;
  try {
    await convertProviderResponse({
      providerProtocol: 'anthropic-messages',
      providerResponse,
      context,
      entryEndpoint: '/v1/messages',
      wantsStream: false
    });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught, 'expected anthropic SSE error event to throw');
  const err = caught;
  assert.equal(err?.code, 'SSE_DECODE_ERROR', 'error code should remain SSE_DECODE_ERROR');
  assert.equal(err?.status, 500, 'top-level status should be 500');
  assert.equal(err?.statusCode, 500, 'top-level statusCode should be 500');
  assert.equal(err?.upstreamCode, '500', 'top-level upstreamCode should be extracted');
  assert.equal(err?.details?.status, 500, 'details.status should be 500');
  assert.equal(err?.details?.statusCode, 500, 'details.statusCode should be 500');
  assert.equal(err?.details?.upstreamStatus, 500, 'details.upstreamStatus should be 500');
  assert.equal(err?.details?.upstreamCode, '500', 'details.upstreamCode should be extracted');
  assert.match(
    String(err?.message || ''),
    /Anthropic SSE error event \[500\] Operation failed/u,
    'error message should preserve upstream payload context'
  );

  // eslint-disable-next-line no-console
  console.log('[matrix:anthropic-sse-error-event-status] ok');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[matrix:anthropic-sse-error-event-status] failed', err);
  process.exit(1);
});
