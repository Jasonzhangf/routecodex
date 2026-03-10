#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  runReqOutboundStage3CompatWithNative,
  runRespInboundStage3CompatWithNative
} from '../../dist/router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';

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

function applyResponseCompat(profile, payload, options = {}) {
  const adapterContext = options?.adapterContext && typeof options.adapterContext === 'object'
    ? options.adapterContext
    : {};
  return runRespInboundStage3CompatWithNative({
    payload,
    explicitProfile: profile,
    adapterContext
  });
}

async function main() {
  // Responses-like request (openai-responses): keep array-form `input` by default (modern LM Studio supports it).
  {
    const req = {
      input: [
        { type: 'function_call', id: 'call_123', name: 'exec_command', arguments: '{}' },
        { type: 'function_call_output', tool_call_id: 'call_123', output: 'ok' }
      ],
      metadata: {}
    };
    const out = applyRequestCompat('chat:lmstudio', req, {
      adapterContext: { providerProtocol: 'openai-responses' }
    });
    assert.equal(out.appliedProfile, 'chat:lmstudio');
    assert.ok(Array.isArray(out.payload.input), 'expected payload.input to remain an array');
    assert.equal(out.payload.input[0].type, 'function_call');
    assert.equal(out.payload.input[0].call_id, 'call_123');
    assert.equal(out.payload.input[0].id, 'fc_123');
    assert.equal(out.payload.input[1].type, 'function_call_output');
    assert.equal(out.payload.input[1].tool_call_id, 'call_123');
    assert.equal(out.payload.input[1].call_id, 'call_123');
    assert.equal(out.payload.input[1].id, 'fc_123');
  }

  // Responses-like request: message objects may not carry explicit type="message"; compat must preserve them.
  {
    const req = {
      instructions: 'Follow tool calling.',
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'Please call exec_command.' }]
        }
      ]
    };
    const out = applyRequestCompat('chat:lmstudio', req, {
      adapterContext: { providerProtocol: 'openai-responses' }
    });
    assert.equal(out.appliedProfile, 'chat:lmstudio');
    assert.ok(Array.isArray(out.payload.input), 'expected payload.input to remain an array');
    assert.equal(out.payload.instructions, 'Follow tool calling.');
    assert.equal(out.payload.input[0].role, 'user');
    assert.equal(out.payload.input[0].content[0].type, 'input_text');
    assert.ok(String(out.payload.input[0].content[0].text).includes('Please call exec_command.'));
  }

  // Responses-like response: function_call item has only id; normalize should mirror into call_id.
  {
    const resp = {
      object: 'response',
      id: 'resp_1',
      output: [{ type: 'function_call', id: 'call_777', name: 'exec_command', arguments: '{}' }]
    };
    const out = applyResponseCompat('chat:lmstudio', resp, {
      adapterContext: { providerProtocol: 'openai-responses' }
    });
    assert.equal(out.appliedProfile, 'chat:lmstudio');
    assert.equal(out.payload.output[0].call_id, 'call_777');
    assert.equal(out.payload.output[0].id, 'call_777');
  }

  // Responses-like response: if both id and call_id exist, do not overwrite (LM Studio may use id=fc_* and call_id=call_*).
  {
    const resp = {
      object: 'response',
      id: 'resp_2',
      output: [{ type: 'function_call', id: 'fc_item_1', call_id: 'call_1', name: 'exec_command', arguments: '{}' }]
    };
    const out = applyResponseCompat('chat:lmstudio', resp, {
      adapterContext: { providerProtocol: 'openai-responses' }
    });
    assert.equal(out.appliedProfile, 'chat:lmstudio');
    assert.equal(out.payload.output[0].id, 'fc_item_1');
    assert.equal(out.payload.output[0].call_id, 'call_1');
  }

  // Responses-like response: harvest Qwen tool-call tokens emitted as plain text into canonical output function_call items.
  {
    const resp = {
      object: 'response',
      id: 'resp_3',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text:
                '• waiting...\n' +
                '<|tool_calls_section_begin|>\n' +
                '<|tool_call_begin|> functions.exec_command:66 <|tool_call_argument_begin|> {"cmd":"pwd"} <|tool_call_end|>\n' +
                '<|tool_calls_section_end|>\n'
            }
          ]
        }
      ]
    };
    const out = applyResponseCompat('chat:lmstudio', resp, {
      adapterContext: { providerProtocol: 'openai-responses' }
    });
    assert.equal(out.appliedProfile, 'chat:lmstudio');
    assert.equal(out.payload.output[0].type, 'function_call');
    assert.ok(String(out.payload.output[0].call_id || '').startsWith('call_'));
    assert.ok(String(out.payload.output[0].id || '').startsWith('fc_'));
    assert.equal(out.payload.output[0].name, 'exec_command');
    assert.ok(String(out.payload.output[0].arguments || '').includes('"cmd"'));
    assert.ok(String(out.payload.output[0].arguments || '').includes('pwd'));
  }

  // Chat tool message: mirror tool_call_id ↔ call_id.
  {
    const chat = {
      messages: [{ role: 'tool', tool_call_id: 'call_abc', content: 'ok' }]
    };
    const out = applyRequestCompat('chat:lmstudio', chat, {
      adapterContext: { providerProtocol: 'openai-chat' }
    });
    assert.equal(out.appliedProfile, 'chat:lmstudio');
    assert.equal(out.payload.messages[0].tool_call_id, 'call_abc');
    assert.equal(out.payload.messages[0].call_id, 'call_abc');
  }

  console.log('✅ compat-lmstudio-tool-call-ids passed');
}

main().catch((e) => {
  console.error('❌ compat-lmstudio-tool-call-ids failed:', e);
  process.exit(1);
});
