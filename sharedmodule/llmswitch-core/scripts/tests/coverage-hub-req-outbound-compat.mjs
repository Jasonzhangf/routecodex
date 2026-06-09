#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const nativeModuleUrl = pathToFileURL(
  path.join(
    repoRoot,
    'dist',
    'native',
    'router-hotpath',
    'native-hub-pipeline-req-outbound-semantics.js'
  )
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
  }

  {
    const result = runReqOutboundStage3CompatWithNative({
      payload: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hello-native-profile' }]
      },
      adapterContext: {
        requestId: 'req_outbound_compat_cov_native_2',
        providerProtocol: 'openai-chat',
        compatibilityProfile: 'tabglm-claude-code'
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
        instructions: '<b>native-c4m</b>',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }]
      },
      adapterContext: {
        requestId: 'req_outbound_compat_cov_native_3',
        providerProtocol: 'openai-responses',
        compatibilityProfile: 'responses:c4m'
      }
    });
    assert.equal(result.nativeApplied, true);
    assert.equal(result.appliedProfile, 'responses:c4m');
    assert.equal(result.payload.max_tokens, undefined);
    assert.equal(result.payload.instructions, undefined);
    assert.equal(result.payload.input?.[0]?.role, 'system');
  }

  {
    const result = runReqOutboundStage3CompatWithNative({
      payload: {
        system: [{ type: 'text', text: 'legacy system' }],
        messages: [{ role: 'user', content: 'hello' }]
      },
      adapterContext: {
        requestId: 'req_outbound_compat_cov_native_4',
        providerProtocol: 'anthropic-messages',
        compatibilityProfile: 'chat:claude-code'
      }
    });
    assert.equal(result.nativeApplied, true);
    assert.equal(result.appliedProfile, 'chat:claude-code');
    assert.equal(result.payload.system?.[0]?.text, "You are Claude Code, Anthropic's official CLI for Claude.");
    assert.equal(result.payload.messages?.[0]?.role, 'user');
  }

  {
    const result = runReqOutboundStage3CompatWithNative({
      payload: {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello-qwen-native' }],
        max_tokens: 128,
        tools: [{ type: 'function', function: { name: 'exec_command', description: 'ignored' } }]
      },
      adapterContext: {
        requestId: 'req_outbound_compat_cov_native_5',
        providerProtocol: 'openai-chat',
        compatibilityProfile: 'chat:qwen'
      }
    });
    assert.equal(result.nativeApplied, true);
    assert.equal(result.appliedProfile, 'chat:qwen');
    assert.equal(result.payload.model, 'coder-model');
    assert.equal(result.payload.messages?.[0]?.content, 'hello-qwen-native');
    assert.equal(result.payload.max_tokens, 128);
    assert.equal(result.payload.tools?.[0]?.function?.name, 'exec_command');
  }

  {
    const result = runReqOutboundStage3CompatWithNative({
      payload: {
        model: 'deepseek-chat',
        chat_session_id: 'sess_native_ds_1',
        messages: [
          { role: 'system', content: 'follow contract' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' } }]
          },
          { role: 'user', content: 'run' }
        ],
        tools: [{ type: 'function', function: { name: 'exec_command', description: 'run shell' } }]
      },
      adapterContext: {
        requestId: 'req_outbound_compat_cov_native_deepseek_1',
        providerProtocol: 'openai-chat',
        compatibilityProfile: 'chat:deepseek-web',
        routeId: 'search-primary'
      }
    });
    assert.equal(result.nativeApplied, true);
    assert.equal(result.appliedProfile, 'chat:deepseek-web');
    assert.equal(result.payload.search_enabled, true);
    assert.equal(result.payload.thinking_enabled, false);
    assert.equal(typeof result.payload.prompt, 'string');
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
        requestId: 'req_outbound_compat_cov_native_gemini_1',
        providerProtocol: 'gemini-chat',
        compatibilityProfile: 'chat:gemini',
        routeId: 'search-primary'
      }
    });
    assert.equal(result.nativeApplied, true);
    assert.equal(result.appliedProfile, 'chat:gemini');
    assert.equal(result.payload.web_search, undefined);
    assert.equal(result.payload.tools?.[0]?.functionDeclarations?.[0]?.name, 'web_search');
  }

  {
    const result = runReqOutboundStage3CompatWithNative({
      payload: {
        model: 'gpt-4.1',
        tool_choice: { type: 'function', function: { name: 'exec_command' } },
        input: [
          { type: 'function_call', call_id: 'shell#1', name: 'exec_command', arguments: { cmd: 'pwd' } },
          { type: 'function_call_output', id: 'output-1', output: 'ok' }
        ]
      },
      adapterContext: {
        requestId: 'req_outbound_compat_cov_native_6',
        providerProtocol: 'openai-responses',
        compatibilityProfile: 'chat:lmstudio'
      }
    });
    assert.equal(result.nativeApplied, true);
    assert.equal(result.appliedProfile, 'chat:lmstudio');
    assert.equal(result.payload.tool_choice, undefined);
    assert.equal(result.payload.input?.[0]?.call_id, 'call_shell_1');
    assert.equal(result.payload.input?.[0]?.id, 'fc_shell_1');
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
  }

  {
    const result = runRespInboundStage3CompatWithNative({
      payload: {
        id: 'resp-native-2',
        object: 'response',
        output: []
      },
      adapterContext: {
        requestId: 'req_resp_inbound_compat_cov_native_2',
        providerProtocol: 'openai-responses',
        compatibilityProfile: 'chat:iflow'
      }
    });
    assert.equal(result.nativeApplied, true);
    assert.equal(result.appliedProfile, undefined);
  }

  {
    const result = runRespInboundStage3CompatWithNative({
      payload: {
        id: 'resp-native-3',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'native-choice' }]
          }
        ]
      },
      adapterContext: {
        requestId: 'req_resp_inbound_compat_cov_native_3',
        providerProtocol: 'openai-responses',
        compatibilityProfile: 'responses:output2choices-test'
      }
    });
    assert.equal(result.nativeApplied, true);
    assert.equal(result.appliedProfile, 'responses:output2choices-test');
    assert.equal(result.payload.choices?.[0]?.message?.content, 'native-choice');
    assert.equal(result.payload.request_id, 'req_resp_inbound_compat_cov_native_3');
  }

  {
    const result = runRespInboundStage3CompatWithNative({
      payload: {
        id: 'resp-native-4',
        output_text: 'ok'
      },
      adapterContext: {
        requestId: 'req_resp_inbound_compat_cov_native_4',
        providerProtocol: 'openai-responses',
        compatibilityProfile: 'responses:c4m'
      }
    });
    assert.equal(result.nativeApplied, true);
    assert.equal(result.appliedProfile, 'responses:c4m');
    assert.equal(result.rateLimitDetected, undefined);
  }

  {
    const result = runRespInboundStage3CompatWithNative({
      payload: {
        id: 'resp-native-5',
        output_text: 'The Codex-For.ME service is available, but you have reached the request limit'
      },
      adapterContext: {
        requestId: 'req_resp_inbound_compat_cov_native_5',
        providerProtocol: 'openai-responses',
        compatibilityProfile: 'responses:c4m'
      }
    });
    assert.equal(result.nativeApplied, true);
    assert.equal(result.appliedProfile, 'responses:c4m');
    assert.equal(result.rateLimitDetected, true);
  }

  {
    const result = runRespInboundStage3CompatWithNative({
      payload: {
        id: 'resp-native-6',
        output: []
      },
      adapterContext: {
        requestId: 'req_resp_inbound_compat_cov_native_6',
        providerProtocol: 'anthropic-messages',
        compatibilityProfile: 'chat:claude-code'
      }
    });
    assert.equal(result.nativeApplied, true);
    assert.equal(result.appliedProfile, 'chat:claude-code');
  }

  {
    const result = runRespInboundStage3CompatWithNative({
      payload: {
        data: {
          id: 'qwen_resp_native_1',
          model: 'qwen3-plus',
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'native-qwen-response',
                tool_calls: [{ function: { name: 'exec_command', arguments: { cmd: 'pwd' } } }]
              },
              finish_reason: 'tool_calls'
            }
          ]
        }
      },
      adapterContext: {
        requestId: 'req_resp_inbound_compat_cov_native_7',
        providerProtocol: 'openai-chat',
        compatibilityProfile: 'chat:qwen'
      }
    });
    assert.equal(result.nativeApplied, true);
    assert.equal(result.appliedProfile, 'chat:qwen');
    assert.equal(result.payload.object, 'chat.completion');
    assert.equal(result.payload.choices?.[0]?.message?.content, 'native-qwen-response');
    assert.equal(result.payload.choices?.[0]?.finish_reason, 'tool_calls');
  }

  {
    const result = runRespInboundStage3CompatWithNative({
      payload: {
        code: 0,
        msg: '',
        data: {
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                tool_calls: [],
                content:
                  '<function_calls>{"tool_calls":[{"id":"call_native_ds_1","type":"function","function":{"name":"shell_command","arguments":{"command":"pwd","cwd":"/tmp"}}}]}</function_calls>'
              }
            }
          ]
        }
      },
      adapterContext: {
        requestId: 'req_resp_inbound_compat_cov_native_8',
        providerProtocol: 'openai-chat',
        compatibilityProfile: 'chat:deepseek-web'
      }
    });
    assert.equal(result.nativeApplied, true);
    assert.equal(result.appliedProfile, 'chat:deepseek-web');
    assert.equal(result.payload.choices?.[0]?.finish_reason, 'tool_calls');
    assert.equal(result.payload.metadata?.deepseek?.toolCallState, 'text_tool_calls');
  }

  console.log('✅ coverage-hub-req-outbound-compat passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-req-outbound-compat failed:', error);
  process.exit(1);
});
