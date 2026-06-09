#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

function safeJson(value) {
  try { return JSON.stringify(value); } catch { return undefined; }
}

function normalizeForCompare(value) {
  try {
    return JSON.parse(JSON.stringify(value, (_k, v) => {
      if (typeof v === 'function') return undefined;
      if (v === undefined) return null;
      return v;
    }));
  } catch {
    return value;
  }
}

function deepEqual(a, b) {
  assert.deepEqual(normalizeForCompare(a), normalizeForCompare(b));
}

function score(pass, total) {
  return total === 0 ? 1 : pass / total;
}

async function loadModules() {
  const bridgeActions = await import('../../dist/conversion/bridge-actions.js');
  const bridgeInstructions = await import('../../dist/conversion/bridge-instructions.js');
  const bridgeMessageUtils = await import('../../dist/conversion/bridge-message-utils.js');
  const bridgePolicies = await import('../../dist/conversion/bridge-policies.js');
  const nativeBridgePolicy = await import('../../dist/native/router-hotpath/native-hub-bridge-policy-semantics.js');
  const runtimeMetadata = await import('../../dist/conversion/runtime-metadata.js');
  const compactionDetect = await import('../../dist/conversion/compaction-detect.js');
  const mcpInjection = await import('../../dist/conversion/mcp-injection.js');
  return {
    bridgeActions,
    bridgeInstructions,
    bridgeMessageUtils,
    bridgePolicies,
    nativeBridgePolicy,
    runtimeMetadata,
    compactionDetect,
    mcpInjection
  };
}

async function main() {
  const modules = await loadModules();
  let passed = 0;
  let total = 0;

  const bump = (fn) => {
    total += 1;
    try {
      fn();
      passed += 1;
    } catch (err) {
      throw err;
    }
  };

  // bridge-instructions
  bump(() => {
    const payload = {
      input: [
        { role: 'system', content: [{ type: 'text', text: 'sys' }] },
        { role: 'user', content: [{ type: 'text', text: 'hi' }] }
      ]
    };
    const instr = modules.bridgeInstructions.ensureBridgeInstructions(payload);
    assert.equal(instr, 'sys');
    assert.ok(!payload.input.find((e) => e.role === 'system'));
  });

  // bridge-message-utils
  bump(() => {
    const out = modules.bridgeMessageUtils.coerceBridgeRole('assistant');
    assert.equal(out, 'assistant');
  });

  bump(() => {
    const messages = modules.bridgeMessageUtils.convertBridgeInputToChatMessages({
      input: [
        { type: 'message', role: 'user', content: 'hi' },
        { type: 'function_call', call_id: 'call_1', name: 'exec_command', arguments: { cmd: 'pwd' } },
        { type: 'function_call_output', tool_call_id: 'call_1', output: 'ok' }
      ]
    });
    assert.ok(Array.isArray(messages));
  });

  bump(() => {
    const messages = modules.bridgeMessageUtils.convertBridgeInputToChatMessages({
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'see image' },
            { type: 'image_url', image_url: { url: 'https://example.com/img.png', detail: 'low' } }
          ]
        },
        { type: 'function_call', call_id: 'call_1', name: 'exec_command', arguments: { cmd: 'pwd' } },
        { type: 'function_call_output', tool_call_id: 'call_1', output: { ok: true } }
      ]
    });
    assert.ok(Array.isArray(messages));
    const hasImage = messages.some((msg) =>
      Array.isArray(msg.content) && msg.content.some((block) => block && block.type === 'image_url')
    );
    assert.ok(hasImage);
    const hasToolCall = messages.some((msg) => Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0);
    assert.ok(hasToolCall);
  });

  bump(() => {
    const build = modules.bridgeMessageUtils.convertMessagesToBridgeInput({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' }
      ]
    });
    assert.ok(Array.isArray(build.input));
  });

  // bridge-policies
  bump(() => {
    const policy = modules.bridgePolicies.resolveBridgePolicy({ protocol: 'openai-chat' });
    if (policy) {
      const actions = modules.bridgePolicies.resolvePolicyActions(policy, 'request_inbound');
      assert.ok(actions === undefined || Array.isArray(actions));
    }
  });

  // native protocol field allowlists
  bump(() => {
    const allowlists = modules.nativeBridgePolicy.resolveHubProtocolAllowlistsWithNative();
    assert.ok(Array.isArray(allowlists.openaiChatAllowedFields));
    assert.ok(allowlists.openaiChatAllowedFields.includes('messages'));
  });

  // runtime-metadata
  bump(() => {
    const meta = modules.runtimeMetadata.ensureRuntimeMetadata({});
    assert.ok(meta && typeof meta === 'object');
  });

  // compaction-detect
  bump(() => {
    const should = modules.compactionDetect.isCompactionRequest({
      messages: [{ role: 'user', content: 'Context checkpoint compaction: please summarize.' }]
    });
    assert.equal(typeof should, 'boolean');
  });

  // mcp-injection
  bump(() => {
    const tools = modules.mcpInjection.injectMcpToolsForChat([], ['context7']);
    assert.ok(Array.isArray(tools));
  });

  const ratio = score(passed, total);
  if (ratio < 0.95) {
    throw new Error(`bridge/protocol blackbox coverage ${ratio.toFixed(3)} < 0.95 (${passed}/${total})`);
  }
  console.log(`✅ coverage-bridge-protocol-blackbox passed ${passed}/${total} (${(ratio * 100).toFixed(1)}%)`);
}

main().catch((err) => {
  console.error('❌ coverage-bridge-protocol-blackbox failed:', err);
  process.exit(1);
});
