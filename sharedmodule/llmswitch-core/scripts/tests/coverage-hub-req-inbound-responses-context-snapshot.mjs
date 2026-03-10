#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(
    repoRoot,
    'dist',
    'conversion',
    'hub',
    'pipeline',
    'stages',
    'req_inbound',
    'req_inbound_stage3_context_capture',
    'responses-context-snapshot.js'
  )
).href;
const storeUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'conversion', 'shared', 'responses-conversation-store.js')
).href;

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

function makeRawRequest(options = {}) {
  const withTools = options.withTools !== false;
  const withToolOutput = options.withToolOutput !== false;
  const request = {
    model: 'gpt-test',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }]
      }
    ]
  };

  if (withToolOutput) {
    request.input.push({
      type: 'function_call_output',
      id: 'fc_1',
      call_id: 'call_1',
      output: 'ok'
    });
  }

  if (withTools) {
    request.tools = [
      {
        type: 'function',
        name: 'exec_command',
        description: 'run command',
        parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] }
      }
    ];
  }

  if ('metadata' in options) {
    request.metadata = options.metadata;
  }

  return request;
}

function makeAdapterContext(overrides = {}) {
  return {
    requestId: 'req_ctx_1',
    providerProtocol: 'openai-responses',
    entryEndpoint: '/v1/responses',
    toolCallIdStyle: 'fc',
    ...overrides
  };
}

async function main() {
  const { captureResponsesContextSnapshot } = await importFresh('hub-req-inbound-responses-context-snapshot');
  const storeMod = await import(storeUrl);
  assert.equal(typeof captureResponsesContextSnapshot, 'function');

  {
    const context = captureResponsesContextSnapshot({
      rawRequest: makeRawRequest({ withTools: true, withToolOutput: true }),
      adapterContext: makeAdapterContext({ requestId: 'req_ctx_1', toolCallIdStyle: ' preserve ' })
    });
    assert.equal(context.toolCallIdStyle, 'preserve');
    assert.equal(context.metadata.toolCallIdStyle, 'preserve');
    assert.ok(Array.isArray(context.toolsNormalized));
    assert.ok(Array.isArray(context.__captured_tool_results));
    assert.equal(storeMod.responsesConversationStore.requestMap.has('req_ctx_1'), true);
    storeMod.clearResponsesConversationByRequestId('req_ctx_1');
  }

  {
    const context = captureResponsesContextSnapshot({
      rawRequest: makeRawRequest({ metadata: { source: 'test' } }),
      adapterContext: makeAdapterContext({ requestId: 'req_ctx_2', toolCallIdStyle: 'fc' })
    });
    assert.equal(context.toolCallIdStyle, 'fc');
    assert.equal(context.metadata.toolCallIdStyle, 'fc');
    assert.equal(storeMod.responsesConversationStore.requestMap.has('req_ctx_2'), true);
    storeMod.clearResponsesConversationByRequestId('req_ctx_2');
  }

  {
    const context = captureResponsesContextSnapshot({
      rawRequest: makeRawRequest({ withTools: false, withToolOutput: false }),
      adapterContext: makeAdapterContext({ requestId: '   ', toolCallIdStyle: '??' })
    });
    assert.equal(context.toolCallIdStyle, undefined);
    assert.equal(context.toolsNormalized, undefined);
    assert.equal(context.__captured_tool_results, undefined);
  }

  {
    const context = captureResponsesContextSnapshot({
      rawRequest: { model: 'gpt-test', input: 'ages' },
      adapterContext: makeAdapterContext({ requestId: 'req_ctx_text', toolCallIdStyle: 'fc' })
    });
    assert.ok(Array.isArray(context.input));
    assert.equal(context.input.length, 1);
    assert.equal(storeMod.responsesConversationStore.requestMap.has('req_ctx_text'), true);
    storeMod.clearResponsesConversationByRequestId('req_ctx_text');
  }

  {
    assert.throws(
      () =>
        captureResponsesContextSnapshot({
          rawRequest: { model: 'gpt-test', input: [] },
          adapterContext: makeAdapterContext({ requestId: 'req_ctx_3', toolCallIdStyle: 'fc' })
        }),
      /Responses payload produced no chat messages/
    );
    assert.equal(storeMod.responsesConversationStore.requestMap.has('req_ctx_3'), false);
  }

  {
    const context = captureResponsesContextSnapshot({
      rawRequest: makeRawRequest({ withTools: false, withToolOutput: false }),
      adapterContext: makeAdapterContext({ requestId: undefined, toolCallIdStyle: 123 })
    });
    assert.equal(context.toolCallIdStyle, undefined);
    assert.equal(typeof context, 'object');
  }

  console.log('✅ coverage-hub-req-inbound-responses-context-snapshot passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-req-inbound-responses-context-snapshot failed:', error);
  process.exit(1);
});
