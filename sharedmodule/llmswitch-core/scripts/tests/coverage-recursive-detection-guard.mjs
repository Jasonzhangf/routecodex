#!/usr/bin/env node

import assert from 'node:assert/strict';

async function main() {
  // Importing the module registers the auto handler.
  await import('../../dist/servertool/handlers/recursive-detection-guard.js');

  const { listAutoServerToolHandlers } = await import('../../dist/servertool/registry.js');
  const entry = listAutoServerToolHandlers().find((e) => e?.name === 'recursive_detection_guard');
  assert.ok(entry && typeof entry.handler === 'function');

  const base = {
    choices: [{ message: { role: 'assistant', content: 'ok' } }]
  };

  const capturedChatRequest = {
    model: 'gpt-5.2',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    parameters: { stream: true, temperature: 0.2 }
  };

  const adapterContext = {
    requestId: 'req_guard',
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-responses',
    sessionId: 'sess_guard',
    capturedChatRequest
  };

  const toolCall = { id: 'call_1', name: 'shell', arguments: '{"command":["ls","-la"]}' };

  // Warm up: 9 consecutive identical calls should not trigger.
  for (let i = 0; i < 9; i += 1) {
    const plan = await entry.handler({
      base,
      toolCalls: [toolCall],
      adapterContext,
      requestId: `req_guard_${i}`,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      capabilities: { reenterPipeline: true, providerInvoker: false }
    });
    assert.equal(plan, null);
  }

  // Trigger on the 10th consecutive call.
  const plan = await entry.handler({
    base,
    toolCalls: [toolCall],
    adapterContext,
    requestId: 'req_guard_10',
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-responses',
    capabilities: { reenterPipeline: true, providerInvoker: false }
  });
  assert.ok(plan && plan.flowId === 'recursive_detection_guard');

  const finalized = await plan.finalize({});
  assert.ok(finalized && finalized.execution?.followup?.injection?.ops, 'expected followup injection plan');

  // Followup hops should reset the streak and skip.
  const skipped = await entry.handler({
    base,
    toolCalls: [toolCall],
    adapterContext: {
      ...adapterContext,
      __rt: { serverToolFollowup: true }
    },
    requestId: 'req_guard_followup',
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-responses',
    capabilities: { reenterPipeline: true, providerInvoker: false }
  });
  assert.equal(skipped, null);

  console.log('✅ coverage-recursive-detection-guard passed');
}

main().catch((e) => {
  console.error('❌ coverage-recursive-detection-guard failed:', e);
  process.exit(1);
});

