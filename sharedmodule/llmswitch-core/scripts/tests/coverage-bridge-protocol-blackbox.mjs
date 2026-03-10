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
  const bridgeId = await import('../../dist/conversion/bridge-id-utils.js');
  const bridgeInstructions = await import('../../dist/conversion/bridge-instructions.js');
  const bridgeMessageUtils = await import('../../dist/conversion/bridge-message-utils.js');
  const bridgeMetadata = await import('../../dist/conversion/bridge-metadata.js');
  const bridgePolicies = await import('../../dist/conversion/bridge-policies.js');
  const metadataPassthrough = await import('../../dist/conversion/metadata-passthrough.js');
  const protocolAllowlists = await import('../../dist/conversion/protocol-field-allowlists.js');
  const protocolState = await import('../../dist/conversion/protocol-state.js');
  const payloadBudget = await import('../../dist/conversion/payload-budget.js');
  const runtimeMetadata = await import('../../dist/conversion/runtime-metadata.js');
  const compactionDetect = await import('../../dist/conversion/compaction-detect.js');
  const jsonish = await import('../../dist/conversion/jsonish.js');
  const media = await import('../../dist/conversion/media.js');
  const mcpInjection = await import('../../dist/conversion/mcp-injection.js');
  const argsMapping = await import('../../dist/conversion/args-mapping.js');
  return {
    bridgeActions,
    bridgeId,
    bridgeInstructions,
    bridgeMessageUtils,
    bridgeMetadata,
    bridgePolicies,
    metadataPassthrough,
    protocolAllowlists,
    protocolState,
    payloadBudget,
    runtimeMetadata,
    compactionDetect,
    jsonish,
    media,
    mcpInjection,
    argsMapping
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

  // args-mapping
  bump(() => {
    const input = { cmd: 'ls', cwd: '/tmp', extra: 'x' };
    const schema = {
      type: 'object',
      properties: {
        command: { type: 'string', 'x-aliases': ['cmd'] },
        cwd: { type: 'string' }
      },
      required: ['command'],
      additionalProperties: true
    };
    const out = modules.argsMapping.normalizeArgsBySchema(input, schema);
    assert.equal(typeof out.ok, 'boolean');
  });

  bump(() => {
    const tools = [
      { type: 'function', function: { name: 'exec_command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } } }
    ];
    const out = modules.argsMapping.normalizeTools(tools);
    assert.ok(Array.isArray(out));
  });

  // bridge-id-utils
  bump(() => {
    const id = modules.bridgeId.normalizeFunctionCallId({ callId: 'call_1' });
    assert.ok(typeof id === 'string' && id.length > 0);
  });

  bump(() => {
    const id = modules.bridgeId.normalizeFunctionCallOutputId({ callId: 'call_1' });
    assert.ok(typeof id === 'string' && id.length > 0);
  });

  bump(() => {
    const id = modules.bridgeId.normalizeResponsesCallId({ callId: 'call_1' });
    assert.ok(typeof id === 'string' && id.length > 0);
  });

  bump(() => {
    const id = modules.bridgeId.clampResponsesInputItemId('item_1234567890');
    assert.ok(typeof id === 'string');
  });

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
        { type: 'function_call', name: 'exec_command', arguments: { cmd: 'pwd' } },
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
        { type: 'function_call', name: 'exec_command', arguments: { cmd: 'pwd' } },
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

  // bridge-metadata
  bump(() => {
    const protocol = modules.bridgeMetadata.resolveBridgeMetadataNativeProtocol();
    assert.equal(protocol, 'openai-responses');
  });

  // bridge-policies
  bump(() => {
    const policy = modules.bridgePolicies.resolveBridgePolicy({ protocol: 'openai-chat' });
    if (policy) {
      const actions = modules.bridgePolicies.resolvePolicyActions(policy, 'request_inbound');
      assert.ok(actions === undefined || Array.isArray(actions));
    }
  });

  // metadata-passthrough
  bump(() => {
    const metadata = { foo: 'bar', __rcc_passthrough_x: 'keep' };
    const out = modules.metadataPassthrough.extractMetadataPassthrough(metadata, {
      prefix: '__rcc_passthrough_',
      keys: ['x']
    });
    assert.ok(typeof out === 'object');
  });

  // protocol-field-allowlists
  bump(() => {
    assert.ok(Array.isArray(modules.protocolAllowlists.OPENAI_CHAT_ALLOWED_FIELDS));
  });

  // protocol-state
  bump(() => {
    const metadata = { protocolState: {} };
    const node = modules.protocolState.ensureProtocolState(metadata, 'openai-chat');
    assert.ok(node && typeof node === 'object');
  });

  bump(() => {
    const metadata = { protocolState: { 'openai-chat': { a: 1 } } };
    const node = modules.protocolState.getProtocolState(metadata, 'openai-chat');
    assert.deepEqual(node, { a: 1 });
  });

  // payload-budget
  bump(() => {
    const budget = modules.payloadBudget.resolveBudgetForModelSync('gpt-4');
    assert.ok(typeof budget.allowedBytes === 'number');
  });

  bump(() => {
    const chat = { messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }] };
    const out = modules.payloadBudget.enforceChatBudget(chat, 'gpt-4');
    assert.ok(out && typeof out === 'object');
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

  // jsonish
  bump(() => {
    const out = modules.jsonish.parseLenient('{"a":1}');
    assert.deepEqual(out, { a: 1 });
  });

  // media
  bump(() => {
    const out = modules.media.isImagePath('file:///tmp/image.png');
    assert.equal(typeof out, 'boolean');
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
