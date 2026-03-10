#!/usr/bin/env node
/**
 * Regression: iFlow/Kimi request compat should align with iflow-cli defaults.
 * - thinking missing => compat should enable thinking and repair reasoning_content
 * - thinking enabled => assistant tool-call messages get reasoning_content
 */

import assert from 'node:assert/strict';
import { runReqOutboundStage3CompatWithNative } from '../../dist/router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';

function applyRequestCompat(profile, payload, options = {}) {
  const adapterContext = options?.adapterContext && typeof options.adapterContext === 'object'
    ? options.adapterContext
    : {};
  return runReqOutboundStage3CompatWithNative({
    payload,
    explicitProfile: profile,
    adapterContext
  });
}

function buildPayload(thinkingMode) {
  const payload = {
    model: 'kimi-k2.5',
    stream: true,
    max_tokens: 8192,
    messages: [
      { role: 'user', content: 'run a command' },
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
  if (thinkingMode === 'enabled') payload.thinking = true;
  if (thinkingMode === 'disabled') payload.thinking = false;
  return payload;
}

function getAssistant(out) {
  return out.messages.find((m) => m && typeof m === 'object' && m.role === 'assistant');
}

function assertCommonKimiDefaults(out, expectedTemperature, label) {
  assert.equal(out.top_p, 0.95, label + ': expected top_p=0.95');
  assert.equal(out.temperature, expectedTemperature, label + ': expected temperature=' + expectedTemperature);
  assert.equal(out.n, 1, label + ': expected n=1');
  assert.equal(out.presence_penalty, 0, label + ': expected presence_penalty=0');
  assert.equal(out.frequency_penalty, 0, label + ': expected frequency_penalty=0');
  assert.equal(out.max_new_tokens, 8192, label + ': expected max_new_tokens mirrored from max_tokens');
}

function assertInjected(out, label) {
  assert.ok(out && typeof out === 'object', label + ': missing output payload');
  assert.ok(Array.isArray(out.messages), label + ': expected messages array');
  const assistant = getAssistant(out);
  assert.ok(assistant, label + ': missing assistant message');
  assert.ok(
    Array.isArray(assistant.tool_calls) && assistant.tool_calls.length === 1,
    label + ': missing assistant tool_calls'
  );
  assert.equal(typeof assistant.reasoning_content, 'string', label + ': expected reasoning_content injected');
  assert.ok(assistant.reasoning_content.length > 0, label + ': expected non-empty reasoning_content');
}

function assertNotInjected(out, label) {
  const assistant = getAssistant(out);
  assert.ok(assistant, label + ': missing assistant message');
  assert.equal(
    Object.prototype.hasOwnProperty.call(assistant, 'reasoning_content'),
    false,
    label + ': reasoning_content should stay absent'
  );
}

function assertThinkingEnabled(out, label) {
  assert.ok(out && typeof out === 'object', label + ': missing output payload');
  assert.ok(out.thinking && typeof out.thinking === 'object', label + ': expected thinking object');
  assert.equal(out.thinking.type, 'enabled', label + ': expected thinking.type=enabled');
}

async function main() {
  const enabled = applyRequestCompat('chat:iflow', buildPayload('enabled'), {
    adapterContext: { providerProtocol: 'openai-chat' }
  }).payload;
  assertCommonKimiDefaults(enabled, 1, 'thinking=true');
  assertThinkingEnabled(enabled, 'thinking=true');
  assertInjected(enabled, 'thinking=true');

  const implicit = applyRequestCompat('chat:iflow', buildPayload('implicit'), {
    adapterContext: { providerProtocol: 'openai-chat' }
  }).payload;
  assertCommonKimiDefaults(implicit, 1, 'thinking missing');
  assertThinkingEnabled(implicit, 'thinking missing');
  assertInjected(implicit, 'thinking missing');

  const disabled = applyRequestCompat('chat:iflow', buildPayload('disabled'), {
    adapterContext: { providerProtocol: 'openai-chat' }
  }).payload;
  assertCommonKimiDefaults(disabled, 0.6, 'thinking=false');
  assert.equal(disabled.thinking, false, 'thinking=false should preserve explicit false');
  assertNotInjected(disabled, 'thinking=false');

  const controlPayload = buildPayload('implicit');
  controlPayload.model = 'qwen3-coder-plus';
  const control = applyRequestCompat('chat:iflow', controlPayload, {
    adapterContext: { providerProtocol: 'openai-chat' }
  }).payload;
  assert.equal(control.model, 'qwen3-coder-plus', 'control: model should stay unchanged');
  assert.equal(control.max_new_tokens, undefined, 'control: max_new_tokens should not be injected');
  assert.equal(control.thinking, undefined, 'control: thinking should not be auto-injected');

  console.log('[matrix:compat-iflow-thinking-reasoning-content] ok');
}

main().catch((err) => {
  console.error('[matrix:compat-iflow-thinking-reasoning-content] failed', err);
  process.exit(1);
});
