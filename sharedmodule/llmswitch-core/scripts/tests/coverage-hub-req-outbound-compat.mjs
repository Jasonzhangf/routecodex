#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const nativeModuleUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'native', 'router-hotpath', 'native-hub-pipeline-req-outbound-semantics.js')
).href;

async function importNativeFresh(tag) {
  return import(`${nativeModuleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

async function main() {
  const nativeMod = await importNativeFresh('hub-req-outbound-compat-native');
  const { runReqOutboundStage3CompatWithNative, runRespInboundStage3CompatWithNative } = nativeMod;
  assert.equal(typeof runReqOutboundStage3CompatWithNative, 'function');
  assert.equal(typeof runRespInboundStage3CompatWithNative, 'function');

  {
    const result = runReqOutboundStage3CompatWithNative({
      payload: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hello-native' }]
      },
      adapterContext: {
        requestId: 'req_outbound_compat_cov_native_1',
        providerProtocol: 'openai-chat'
      }
    });
    assert.equal(result.nativeApplied, true);
    assert.equal(result.appliedProfile, undefined);
  }

  {
    const result = runReqOutboundStage3CompatWithNative({
      payload: {
        model: 'gpt-test',
        max_tokens: 200,
        instructions: '<b>native-crs</b>',
        temperature: 0.2,
        tools: [
          {
            type: 'function',
            function: {
              name: 'exec_command',
              parameters: { type: 'object', properties: { cmd: { type: 'string' } } }
            }
          }
        ],
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }]
      },
      adapterContext: {
        requestId: 'req_outbound_compat_cov_native_2',
        providerProtocol: 'openai-responses',
        compatibilityProfile: 'responses:crs'
      }
    });
    assert.equal(result.nativeApplied, true);
    assert.equal(result.appliedProfile, 'responses:crs');
    assert.equal(result.payload.max_tokens, 200);
    assert.equal(result.payload.instructions, '<b>native-crs</b>');
    assert.equal(result.payload.temperature, undefined);
    assert.equal(result.payload.tools?.[0]?.type, 'function');
    assert.equal(result.payload.tools?.[0]?.name, 'exec_command');
    assert.equal(result.payload.tools?.[0]?.function, undefined);
    assert.equal(result.payload.input?.[0]?.role, 'user');
  }

  {
    const result = runReqOutboundStage3CompatWithNative({
      payload: {
        model: 'gpt-4.1',
        tool_choice: { type: 'function', function: { name: 'exec_command' } },
        input: [
          { type: 'function_call', call_id: 'shell#1', name: 'exec_command', arguments: { cmd: 'pwd' } },
          { type: 'function_call_output', id: 'result-item-1', output: 'ok' }
        ]
      },
      adapterContext: {
        requestId: 'req_outbound_compat_cov_native_3',
        providerProtocol: 'openai-responses',
        compatibilityProfile: 'chat:lmstudio'
      }
    });
    assert.equal(result.nativeApplied, true);
    assert.equal(result.appliedProfile, 'chat:lmstudio');
    assert.equal(result.payload.tool_choice, undefined);
    assert.equal(result.payload.input?.[0]?.call_id, 'call_shell_1');
    assert.equal(result.payload.input?.[0]?.id, 'fc_shell_1');
    assert.equal(result.payload.input?.[1]?.call_id, 'call_result-item-1');
    assert.equal(result.payload.input?.[1]?.id, 'fc_result-item-1');
  }

  {
    const result = runReqOutboundStage3CompatWithNative({
      payload: {
        requestId: 'gemini_native_req_1',
        web_search: { enabled: true },
        tools: [
          {
            functionDeclarations: [{ name: 'web_search' }, { name: 'exec_command' }]
          },
          {
            googleSearch: { dynamicRetrievalConfig: { mode: 'MODE_DYNAMIC' } }
          }
        ]
      },
      adapterContext: {
        requestId: 'req_outbound_compat_cov_native_4',
        providerProtocol: 'gemini-chat',
        compatibilityProfile: 'chat:gemini',
        routeId: 'search-primary'
      }
    });
    assert.equal(result.nativeApplied, true);
    assert.equal(result.appliedProfile, 'chat:gemini');
    assert.equal(result.payload.web_search, undefined);
    assert.equal(result.payload.tools?.[0]?.functionDeclarations?.[0]?.name, 'web_search');
    assert.equal(result.payload.tools?.[1]?.googleSearch?.dynamicRetrievalConfig?.mode, 'MODE_DYNAMIC');
  }

  {
    const result = runReqOutboundStage3CompatWithNative({
      payload: {
        id: 'dead-profile-request',
        max_tokens: 200,
        instructions: 'must not be transformed by removed profile',
        input: []
      },
      adapterContext: {
        requestId: 'req_outbound_compat_cov_native_dead_profile',
        providerProtocol: 'openai-responses',
        compatibilityProfile: 'responses:c4m'
      }
    });
    assert.equal(result.nativeApplied, true);
    assert.equal(result.appliedProfile, undefined);
    assert.equal(result.payload.max_tokens, 200);
    assert.equal(result.payload.instructions, 'must not be transformed by removed profile');
  }

  {
    const result = runRespInboundStage3CompatWithNative({
      payload: {
        id: 'resp-native-1',
        object: 'response',
        output: []
      },
      adapterContext: {
        requestId: 'req_resp_inbound_compat_cov_native_1',
        providerProtocol: 'openai-responses'
      }
    });
    assert.equal(result.nativeApplied, true);
    assert.equal(result.appliedProfile, undefined);
  }

  {
    const result = runRespInboundStage3CompatWithNative({
      payload: {
        object: 'response',
        id: 'resp_lmstudio_1',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: '• waiting...\\n<|tool_calls_section_begin|>\\n<|tool_call_begin|> functions.exec_command:66 <|tool_call_argument_begin|> {"cmd":"pwd"} <|tool_call_end|>\\n<|tool_calls_section_end|>\\n'
              }
            ]
          }
        ]
      },
      adapterContext: {
        requestId: 'req_resp_inbound_compat_cov_native_2',
        providerProtocol: 'openai-responses',
        compatibilityProfile: 'chat:lmstudio'
      }
    });
    assert.equal(result.nativeApplied, true);
    assert.equal(result.appliedProfile, 'chat:lmstudio');
    assert.equal(result.payload.output?.[0]?.type, 'function_call');
    assert.equal(result.payload.output?.[0]?.name, 'exec_command');
    assert.equal(result.payload.output?.[0]?.call_id, 'call_1');
    assert.equal(result.payload.output?.[0]?.id, 'fc_1');
  }

  {
    const result = runRespInboundStage3CompatWithNative({
      payload: {
        object: 'response',
        id: 'resp_minimax_tool_text_1',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: '<function_calls>{"tool_calls":[{"name":"exec_command","arguments":{"cmd":"pwd"}}]}</function_calls>'
              }
            ]
          }
        ]
      },
      adapterContext: {
        requestId: 'req_resp_inbound_compat_cov_native_3',
        providerProtocol: 'openai-responses',
        compatibilityProfile: 'chat:minimax'
      }
    });
    assert.equal(result.nativeApplied, true);
    assert.equal(result.appliedProfile, 'chat:minimax');
    assert.equal(result.payload.output?.[0]?.type, 'function_call');
    assert.equal(result.payload.output?.[0]?.name, 'exec_command');
  }

  console.log('✅ coverage-hub-req-outbound-compat passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-req-outbound-compat failed:', error);
  process.exit(1);
});
