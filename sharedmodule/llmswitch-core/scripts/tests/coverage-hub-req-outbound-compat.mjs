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
    'req_outbound',
    'req_outbound_stage3_compat',
    'index.js'
  )
).href;
const nativeModuleUrl = pathToFileURL(
  path.join(
    repoRoot,
    'dist',
    'router',
    'virtual-router',
    'engine-selection',
    'native-hub-pipeline-req-outbound-semantics.js'
  )
).href;

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

async function importNativeFresh(tag) {
  return import(`${nativeModuleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

async function main() {
  const mod = await importFresh('hub-req-outbound-compat');
  const { runReqOutboundStage3Compat, runRespInboundStageCompatResponse } = mod;
  const nativeMod = await importNativeFresh('hub-req-outbound-compat-native');
  const { runReqOutboundStage3CompatWithNative, runRespInboundStage3CompatWithNative } = nativeMod;
  assert.equal(typeof runReqOutboundStage3Compat, 'function');
  assert.equal(typeof runRespInboundStageCompatResponse, 'function');
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
    assert.equal(result.payload.model, 'qwen3-coder-plus');
    assert.equal(result.payload.input?.[0]?.content?.[0]?.text, 'hello-qwen-native');
    assert.equal(result.payload.parameters?.max_output_tokens, 128);
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
        model: 'gemini-2.5-pro',
        requestId: 'agent-123',
        userAgent: 'antigravity',
        web_search: { enabled: true },
        tools: [
          {
            functionDeclarations: [
              { name: 'exec_command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } },
              { name: 'view_image', parameters: { type: 'object' } }
            ]
          }
        ],
        contents: [
          {
            parts: [
              { functionCall: { name: 'mcp__context7__query-docs', args: { libraryId: '/x/y', query: 'q' } } },
              { functionCall: { name: 'exec_command', args: { cmd: 'pwd' } } },
              { functionCall: { name: 'write_stdin', args: { session_id: 1, text: 'abc' } } }
            ]
          }
        ],
        metadata: { x: 1 },
        stream: true,
        sessionId: 'sess-1'
      },
      adapterContext: {
        requestId: 'req_outbound_compat_cov_native_gemini_cli_1',
        providerProtocol: 'gemini-chat',
        compatibilityProfile: 'chat:gemini-cli',
        routeId: 'coding-primary'
      }
    });
    assert.equal(result.nativeApplied, true);
    assert.equal(result.appliedProfile, 'chat:gemini-cli');
    assert.equal(result.payload.request?.tools?.[0]?.functionDeclarations?.[0]?.name, 'exec_command');
    assert.equal(result.payload.request?.contents?.[0]?.parts?.[0]?.functionCall?.name, 'mcp__context7__query_docs');
    assert.equal(result.payload.request?.contents?.[0]?.parts?.[1]?.functionCall?.args?.command, 'pwd');
    assert.equal(result.payload.request?.contents?.[0]?.parts?.[1]?.functionCall?.args?.cmd, undefined);
    assert.equal(result.payload.request?.contents?.[0]?.parts?.[2]?.functionCall?.args?.chars, 'abc');
    assert.equal(result.payload.request?.metadata, undefined);
    assert.equal(result.payload.request?.stream, undefined);
    assert.equal(result.payload.request?.sessionId, undefined);
  }

  {
    const reqA = runReqOutboundStage3CompatWithNative({
      payload: {
        requestId: 'agent-native-sig-1',
        userAgent: 'antigravity',
        contents: [
          { role: 'user', parts: [{ text: 'native signature seed' }] },
          { role: 'assistant', parts: [{ functionCall: { name: 'exec_command', args: { cmd: 'pwd' } } }] }
        ]
      },
      adapterContext: {
        requestId: 'req_outbound_compat_cov_native_gemini_cli_sig_1',
        providerProtocol: 'gemini-chat',
        compatibilityProfile: 'chat:gemini-cli',
        providerId: 'antigravity',
        providerKey: 'antigravity.alpha.gemini-2.5',
        runtimeKey: 'antigravity.alpha',
        routeId: 'coding-primary'
      }
    });
    assert.equal(reqA.appliedProfile, 'chat:gemini-cli');
    assert.equal(
      reqA.payload.request?.contents?.[1]?.parts?.[0]?.thoughtSignature,
      undefined
    );

    const cached = runRespInboundStage3CompatWithNative({
      payload: {
        request_id: 'req_outbound_compat_cov_native_gemini_cli_sig_1',
        candidates: [
          {
            content: {
              parts: [
                {
                  thoughtSignature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
                }
              ]
            }
          }
        ]
      },
      adapterContext: {
        requestId: 'req_outbound_compat_cov_native_gemini_cli_sig_1',
        providerProtocol: 'gemini-chat',
        compatibilityProfile: 'chat:gemini-cli',
        providerId: 'antigravity',
        providerKey: 'antigravity.alpha.gemini-2.5',
        runtimeKey: 'antigravity.alpha',
        routeId: 'coding-primary'
      }
    });
    assert.equal(cached.appliedProfile, 'chat:gemini-cli');

    const reqB = runReqOutboundStage3CompatWithNative({
      payload: {
        requestId: 'agent-native-sig-2',
        userAgent: 'antigravity',
        contents: [
          { role: 'user', parts: [{ text: 'native signature seed' }] },
          { role: 'assistant', parts: [{ functionCall: { name: 'exec_command', args: { cmd: 'pwd' } } }] }
        ]
      },
      adapterContext: {
        requestId: 'req_outbound_compat_cov_native_gemini_cli_sig_2',
        providerProtocol: 'gemini-chat',
        compatibilityProfile: 'chat:gemini-cli',
        providerId: 'antigravity',
        providerKey: 'antigravity.alpha.gemini-2.5',
        runtimeKey: 'antigravity.alpha',
        routeId: 'coding-primary'
      }
    });
    assert.equal(
      reqB.payload.request?.contents?.[1]?.parts?.[0]?.thoughtSignature,
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    );
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
    assert.equal(result.payload.tool_choice, 'required');
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

  {
    const stageEvents = [];
    const payload = await runReqOutboundStage3Compat({
      payload: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hello' }]
      },
      adapterContext: {
        requestId: 'req_outbound_compat_cov_1',
        providerProtocol: 'openai-chat',
        compatibilityProfile: 'tabglm-claude-code'
      },
      stageRecorder: {
        record(stage, value) {
          stageEvents.push({ stage, value });
          return undefined;
        }
      }
    });
    assert.equal(typeof payload, 'object');
    assert.equal(stageEvents.length, 1);
    assert.equal(stageEvents[0]?.value?.profile, 'tabglm-claude-code');
  }

  {
    const stageEvents = [];
    const payload = await runReqOutboundStage3Compat({
      payload: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'fallback' }]
      },
      adapterContext: {
        requestId: 'req_outbound_compat_cov_3',
        providerProtocol: 'openai-chat'
      },
      stageRecorder: {
        record(stage, value) {
          stageEvents.push({ stage, value });
          return undefined;
        }
      }
    });
    assert.equal(typeof payload, 'object');
    assert.equal(stageEvents.length, 1);
    assert.equal(stageEvents[0]?.value?.profile, 'passthrough');
  }

  {
    const stageEvents = [];
    const payload = runRespInboundStageCompatResponse({
      payload: {
        id: 'resp_1',
        object: 'response',
        output: []
      },
      adapterContext: {
        requestId: 'req_outbound_compat_cov_2',
        providerProtocol: 'openai-responses'
      },
      stageRecorder: {
        record(stage, value) {
          stageEvents.push({ stage, value });
          return undefined;
        }
      }
    });
    assert.equal(typeof payload, 'object');
    assert.equal(stageEvents.length, 1);
    assert.equal(stageEvents[0]?.value?.profile, 'passthrough');
  }

  {
    const stageEvents = [];
    const payload = runRespInboundStageCompatResponse({
      payload: {
        id: 'resp_2',
        object: 'response',
        output: []
      },
      adapterContext: {
        requestId: 'req_outbound_compat_cov_4',
        providerProtocol: 'openai-responses',
        compatibilityProfile: 'chat:iflow'
      },
      stageRecorder: {
        record(stage, value) {
          stageEvents.push({ stage, value });
          return undefined;
        }
      }
    });
    assert.equal(typeof payload, 'object');
    assert.equal(stageEvents.length, 1);
    assert.equal(stageEvents[0]?.value?.profile, 'chat:iflow');
  }

  {
    const stageEvents = [];
    const payload = await runReqOutboundStage3Compat({
      payload: {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello-stage-qwen' }]
      },
      adapterContext: {
        requestId: 'req_outbound_compat_cov_6',
        providerProtocol: 'openai-chat',
        compatibilityProfile: 'chat:qwen'
      },
      stageRecorder: {
        record(stage, value) {
          stageEvents.push({ stage, value });
          return undefined;
        }
      }
    });
    assert.equal(payload.model, 'qwen3-coder-plus');
    assert.equal(stageEvents.length, 1);
    assert.equal(stageEvents[0]?.value?.profile, 'chat:qwen');
  }

  {
    const stageEvents = [];
    const payload = await runReqOutboundStage3Compat({
      payload: {
        model: 'gpt-4.1',
        tool_choice: { type: 'function', function: { name: 'exec_command' } }
      },
      adapterContext: {
        requestId: 'req_outbound_compat_cov_7',
        providerProtocol: 'openai-chat',
        compatibilityProfile: 'chat:lmstudio'
      },
      stageRecorder: {
        record(stage, value) {
          stageEvents.push({ stage, value });
          return undefined;
        }
      }
    });
    assert.equal(payload.tool_choice, 'required');
    assert.equal(stageEvents.length, 1);
    assert.equal(stageEvents[0]?.value?.profile, 'chat:lmstudio');
  }

  {
    const stageEvents = [];
    const payload = await runReqOutboundStage3Compat({
      payload: {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'hello-stage-deepseek' }],
        tools: [{ type: 'function', function: { name: 'exec_command', description: 'run shell' } }]
      },
      adapterContext: {
        requestId: 'req_outbound_compat_cov_8',
        providerProtocol: 'openai-chat',
        compatibilityProfile: 'chat:deepseek-web',
        routeId: 'search-primary'
      },
      stageRecorder: {
        record(stage, value) {
          stageEvents.push({ stage, value });
          return undefined;
        }
      }
    });
    assert.equal(payload.search_enabled, true);
    assert.equal(payload.thinking_enabled, false);
    assert.equal(stageEvents.length, 1);
    assert.equal(stageEvents[0]?.value?.profile, 'chat:deepseek-web');
  }

  {
    const stageEvents = [];
    const payload = await runReqOutboundStage3Compat({
      payload: {
        requestId: 'gemini_stage_req_1',
        web_search: { enabled: true }
      },
      adapterContext: {
        requestId: 'req_outbound_compat_cov_9',
        providerProtocol: 'gemini-chat',
        compatibilityProfile: 'chat:gemini',
        routeId: 'search-primary'
      },
      stageRecorder: {
        record(stage, value) {
          stageEvents.push({ stage, value });
          return undefined;
        }
      }
    });
    assert.equal(payload.tools?.[0]?.googleSearch != null, true);
    assert.equal(stageEvents.length, 1);
    assert.equal(stageEvents[0]?.value?.profile, 'chat:gemini');
  }

  {
    const stageEvents = [];
    const payload = await runReqOutboundStage3Compat({
      payload: {
        model: 'gemini-2.5-pro',
        tools: [{ functionDeclarations: [{ name: 'exec_command', parameters: { type: 'object' } }] }],
        contents: [{ parts: [{ functionCall: { name: 'exec_command', args: { cmd: 'pwd' } } }] }]
      },
      adapterContext: {
        requestId: 'req_outbound_compat_cov_10',
        providerProtocol: 'gemini-chat',
        compatibilityProfile: 'chat:gemini-cli',
        routeId: 'coding-primary'
      },
      stageRecorder: {
        record(stage, value) {
          stageEvents.push({ stage, value });
          return undefined;
        }
      }
    });
    assert.equal(payload.request?.tools?.[0]?.functionDeclarations?.[0]?.name, 'exec_command');
    assert.equal(payload.request?.contents?.[0]?.parts?.[0]?.functionCall?.args?.command, 'pwd');
    assert.equal(stageEvents.length, 1);
    assert.equal(stageEvents[0]?.value?.profile, 'chat:gemini-cli');
  }

  {
    const payload = runRespInboundStageCompatResponse({
      payload: {
        request_id: 'req_outbound_compat_cov_stage_gemini_cli_1',
        candidates: [
          {
            content: {
              parts: [
                {
                  thoughtSignature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
                }
              ]
            }
          }
        ]
      },
      adapterContext: {
        requestId: 'req_outbound_compat_cov_stage_gemini_cli_1',
        providerProtocol: 'gemini-chat',
        compatibilityProfile: 'chat:gemini-cli',
        providerId: 'antigravity',
        providerKey: 'antigravity.alpha.gemini-2.5',
        runtimeKey: 'antigravity.alpha',
        routeId: 'coding-primary'
      }
    });
    assert.equal(payload.request_id, 'req_outbound_compat_cov_stage_gemini_cli_1');
  }

  {
    assert.throws(
      () =>
        runRespInboundStageCompatResponse({
          payload: {
            id: 'resp_3',
            output_text: 'The Codex-For.ME service is available, but you have reached the request limit'
          },
          adapterContext: {
            requestId: 'req_outbound_compat_cov_5',
            providerProtocol: 'openai-responses',
            compatibilityProfile: 'responses:c4m'
          }
        }),
      (error) =>
        error &&
        error.code === 'ERR_COMPAT_RATE_LIMIT_DETECTED' &&
        error.statusCode === 429
    );
  }

  console.log('✅ coverage-hub-req-outbound-compat passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-req-outbound-compat failed:', error);
  process.exit(1);
});
