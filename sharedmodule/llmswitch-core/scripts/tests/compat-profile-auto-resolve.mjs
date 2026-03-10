#!/usr/bin/env node

import assert from 'node:assert/strict';
import { runReqOutboundStage3Compat } from '../../dist/conversion/hub/pipeline/stages/req_outbound/req_outbound_stage3_compat/index.js';

async function runCompat(payload, options) {
  const {
    providerId,
    requestIdSuffix,
    compatibilityProfile,
    providerProtocol = 'openai-chat',
    entryEndpoint = '/v1/responses'
  } = options;
  return runReqOutboundStage3Compat({
    payload: structuredClone(payload),
    adapterContext: {
      requestId: `req_${Date.now()}_${requestIdSuffix}`,
      entryEndpoint,
      providerProtocol,
      providerId,
      ...(typeof compatibilityProfile === 'string' ? { compatibilityProfile } : {})
    }
  });
}

function pickAssistant(out) {
  return Array.isArray(out.messages)
    ? out.messages.find((msg) => msg && typeof msg === 'object' && msg.role === 'assistant')
    : undefined;
}

function sampleIflowPayload(withThinking = true) {
  const payload = {
    model: 'kimi-k2.5',
    stream: true,
    messages: [
      { role: 'user', content: 'run' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' }
          }
        ]
      }
    ]
  };
  if (withThinking) {
    payload.thinking = true;
  }
  return payload;
}

async function testIflowAutoProfileWithThinking() {
  const out = await runCompat(sampleIflowPayload(true), {
    providerId: 'iflow.1-186.kimi-k2.5',
    requestIdSuffix: 'iflow_thinking_true',
    compatibilityProfile: 'chat:iflow'
  });
  const assistant = pickAssistant(out);
  assert.ok(assistant, 'iflow explicit compat should keep assistant message');
  assert.equal(typeof assistant.reasoning_content, 'string', 'iflow explicit compat should inject reasoning_content');
  assert.equal(out?.thinking?.type, 'enabled', 'iflow explicit compat should normalize thinking=true to thinking.type=enabled');
  assert.ok(assistant.reasoning_content.length > 0, 'iflow reasoning_content should be non-empty');
}

async function testIflowAutoProfileWithoutThinkingField() {
  const out = await runCompat(sampleIflowPayload(false), {
    providerId: 'iflow.1-186.kimi-k2.5',
    requestIdSuffix: 'iflow_thinking_missing',
    compatibilityProfile: 'chat:iflow'
  });
  const assistant = pickAssistant(out);
  assert.ok(assistant, 'iflow explicit compat should keep assistant message when thinking field is absent');
  assert.equal(out?.thinking?.type, 'enabled', 'iflow explicit compat should force thinking.type=enabled when field is absent');
  assert.equal(typeof assistant.reasoning_content, 'string', 'iflow explicit compat should inject reasoning_content when thinking field is absent');
  assert.ok(assistant.reasoning_content.length > 0, 'iflow injected reasoning_content should be non-empty');
}

async function testIflowExplicitThinkingDisabled() {
  const payload = sampleIflowPayload(false);
  payload.thinking = false;
  const out = await runCompat(payload, {
    providerId: 'iflow.1-186.kimi-k2.5',
    requestIdSuffix: 'iflow_thinking_false',
    compatibilityProfile: 'chat:iflow'
  });
  const assistant = pickAssistant(out);
  assert.ok(assistant, 'iflow explicit compat should keep assistant message when thinking=false');
  assert.equal(out.temperature, 0.6, 'iflow explicit compat should follow non-thinking temperature default');
  assert.equal(
    Object.prototype.hasOwnProperty.call(assistant, 'reasoning_content'),
    false,
    'iflow explicit compat should not inject reasoning_content when thinking is explicitly disabled'
  );
}

async function testLmstudioAutoProfile() {
  const payload = {
    model: 'qwen3-coder-next-mlx',
    input: [
      {
        type: 'function_call',
        id: 'call_bad@id',
        call_id: 'call_bad@id',
        name: 'exec_command',
        arguments: '{"cmd":"pwd"}'
      },
      {
        type: 'function_call_output',
        id: 'call_bad@id',
        call_id: 'call_bad@id',
        output: 'ok'
      }
    ]
  };

  const out = await runReqOutboundStage3Compat({
    payload: structuredClone(payload),
    adapterContext: {
      requestId: `req_${Date.now()}_lmstudio`,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      providerId: 'lmstudio.key1.qwen3-coder-next-mlx',
      compatibilityProfile: 'chat:lmstudio'
    }
  });

  assert.ok(Array.isArray(out.input) && out.input.length === 2, 'lmstudio explicit compat should keep input array');
  const functionCall = out.input[0];
  const functionCallOutput = out.input[1];
  assert.equal(functionCall.type, 'function_call', 'first lmstudio item should stay function_call');
  assert.equal(functionCallOutput.type, 'function_call_output', 'second lmstudio item should stay function_call_output');
  assert.ok(String(functionCall.call_id).startsWith('call_'), 'lmstudio call_id should be normalized to call_*');
  assert.ok(String(functionCall.id).startsWith('fc_'), 'lmstudio function_call id should be normalized to fc_*');
  assert.ok(String(functionCallOutput.id).startsWith('fc_'), 'lmstudio function_call_output id should be normalized to fc_*');
}

async function testNoCompatDefaultsToPassthrough() {
  const payload = sampleIflowPayload(true);
  const out = await runCompat(payload, {
    providerId: 'iflow.1-186.kimi-k2.5',
    requestIdSuffix: 'iflow_no_compat'
  });

  const assistant = pickAssistant(out);
  assert.ok(assistant, 'passthrough path should keep assistant message');
  assert.equal(
    Object.prototype.hasOwnProperty.call(assistant, 'reasoning_content'),
    false,
    'missing compatibilityProfile should keep passthrough (no iflow transform)'
  );
  assert.equal(out.thinking, true, 'missing compatibilityProfile should keep original thinking flag');
}

async function testLmstudioNoCompatPassthrough() {
  const payload = {
    model: 'qwen3-coder-next-mlx',
    input: [
      {
        type: 'function_call',
        id: 'call_bad@id',
        call_id: 'call_bad@id',
        name: 'exec_command',
        arguments: '{"cmd":"pwd"}'
      }
    ]
  };
  const out = await runReqOutboundStage3Compat({
    payload: structuredClone(payload),
    adapterContext: {
      requestId: `req_${Date.now()}_lmstudio_no_compat`,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      providerId: 'lmstudio.key1.qwen3-coder-next-mlx'
    }
  });
  assert.equal(
    String(out?.input?.[0]?.id),
    'call_bad@id',
    'missing compatibilityProfile should keep lmstudio payload passthrough'
  );
}

async function main() {
  await testIflowAutoProfileWithThinking();
  await testIflowAutoProfileWithoutThinkingField();
  await testIflowExplicitThinkingDisabled();
  await testLmstudioAutoProfile();
  await testNoCompatDefaultsToPassthrough();
  await testLmstudioNoCompatPassthrough();
  console.log('[matrix:compat-profile-explicit-only] ok');
}

main().catch((err) => {
  console.error('[matrix:compat-profile-explicit-only] failed', err);
  process.exit(1);
});
