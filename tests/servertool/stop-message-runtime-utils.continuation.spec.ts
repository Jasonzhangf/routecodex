import { describe, expect, test } from '@jest/globals';

import {
  getCapturedRequest,
  hasCompactionFlag,
  resolveBdWorkingDirectoryForRecord,
  resolveClientConnectionState,
  resolveDefaultStopMessageSnapshot,
  resolveEntryEndpoint,
  resolveImplicitGeminiStopMessageSnapshot,
  resolveRuntimeStopMessageStateFromAdapterContext,
  resolveStopMessageFollowupToolContentMaxChars,
  resolveStopMessageFollowupProviderKey,
  resolveStateKey
} from '../../sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/runtime-utils.js';
import type { RoutingInstructionState } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-routing-state.js';

describe('stop_message_auto continuation routing state key', () => {
  test('uses unified continuation request-chain key before session scope', () => {
    const key = resolveStateKey({
      providerProtocol: 'openai-chat',
      requestId: 'req_chat_cont_root',
      sessionId: 'session_should_lose',
      continuation: {
        chainId: 'req_chain_from_continuation',
        stickyScope: 'request_chain',
        resumeFrom: {
          requestId: 'req_chain_from_continuation'
        }
      }
    });

    expect(key).toBe('req_chain_from_continuation');
  });

  test('does not upgrade responsesRequestContext session into request session state key', () => {
    const key = resolveStateKey({
      providerProtocol: 'openai-responses',
      requestId: 'req_rrc_only',
      metadata: {
        responsesRequestContext: {
          sessionId: 'sess-relay-only',
          conversationId: 'conv-relay-only'
        }
      },
      __rt: {
        responsesRequestContext: {
          sessionId: 'sess-relay-only-rt',
          conversationId: 'conv-relay-only-rt'
        }
      }
    } as any);

    expect(key).toBe('req_rrc_only');
  });

  test('restores stopless state only from current request tool output, not from exec_command shell text alone', () => {
    const command = "routecodex hook run stop_message_auto --input-json '{\"flowId\":\"stop_message_flow\",\"repeatCount\":1,\"maxRepeats\":3}'";
    const state = resolveRuntimeStopMessageStateFromAdapterContext({
      __raw_request_body: {
        input: [{
          type: 'function_call',
          call_id: 'call_servertool_cli',
          name: 'exec_command',
          arguments: JSON.stringify({ cmd: command })
        }],
        tool_outputs: [{
          type: 'function_call_output',
          call_id: 'call_servertool_cli',
          output: '{"toolName":"stop_message_auto","flowId":"stop_message_flow","continuationPrompt":"continue from output","repeatCount":2,"maxRepeats":4}'
        }]
      }
    });

    expect(state).toEqual({
      text: 'continue from output',
      maxRepeats: 4,
      used: 1,
      source: 'client_exec_result',
      stageMode: 'on'
    });
  });

  test('uses Rust-owned bd working directory resolver', () => {
    const workdir = resolveBdWorkingDirectoryForRecord(
      {
        metadata: {
          capturedContext: {
            __hub_capture: {
              context: { workdir: ' /repo/captured ' }
            }
          }
        }
      },
      { workdir: '/repo/runtime' }
    );

    expect(workdir).toBe('/repo/captured');
  });

  test('uses Rust-owned followup provider key resolver', () => {
    const providerKey = resolveStopMessageFollowupProviderKey({
      record: {
        metadata: {
          target: { providerId: ' target.provider ' }
        }
      },
      runtimeMetadata: { providerKey: 'runtime.provider' }
    });

    expect(providerKey).toBe('target.provider');
  });

  test('uses Rust-owned runtime context resolver helpers', () => {
    expect(getCapturedRequest({
      capturedEntryRequest: { input: 'entry' },
      capturedChatRequest: { messages: [] }
    })).toEqual({ input: 'entry' });
    expect(resolveClientConnectionState({ disconnected: true })).toEqual({ disconnected: true });
    expect(resolveClientConnectionState([])).toBeNull();
    expect(hasCompactionFlag({ compactionRequest: ' true ' })).toBe(true);
    expect(hasCompactionFlag({ compactionRequest: 'false' })).toBe(false);
    expect(resolveEntryEndpoint({
      metadata: { entryEndpoint: ' /v1/responses ' }
    })).toBe('/v1/responses');
    expect(resolveEntryEndpoint({})).toBe('/v1/chat/completions');
  });

  test('uses Rust-owned followup tool content max chars resolver', () => {
    const previous = process.env.ROUTECODEX_STOPMESSAGE_FOLLOWUP_TOOL_CONTENT_MAX_CHARS;
    try {
      process.env.ROUTECODEX_STOPMESSAGE_FOLLOWUP_TOOL_CONTENT_MAX_CHARS = ' 32.9 ';
      expect(resolveStopMessageFollowupToolContentMaxChars({ model: 'other' })).toBe(64);

      process.env.ROUTECODEX_STOPMESSAGE_FOLLOWUP_TOOL_CONTENT_MAX_CHARS = 'invalid';
      expect(resolveStopMessageFollowupToolContentMaxChars({ model: 'kimi-k2.5' })).toBeUndefined();

      delete process.env.ROUTECODEX_STOPMESSAGE_FOLLOWUP_TOOL_CONTENT_MAX_CHARS;
      expect(resolveStopMessageFollowupToolContentMaxChars({ model: ' KIMI-K2.5-preview ' })).toBe(1200);
      expect(resolveStopMessageFollowupToolContentMaxChars({ model: 'other' })).toBeUndefined();
    } finally {
      if (previous === undefined) {
        delete process.env.ROUTECODEX_STOPMESSAGE_FOLLOWUP_TOOL_CONTENT_MAX_CHARS;
      } else {
        process.env.ROUTECODEX_STOPMESSAGE_FOLLOWUP_TOOL_CONTENT_MAX_CHARS = previous;
      }
    }
  });

  test('uses Rust-owned default stop-message snapshot resolver', () => {
    const snapshot = resolveDefaultStopMessageSnapshot(
      {
        base: {
          choices: [{
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'done' }
          }]
        },
        adapterContext: {}
      },
      {
        text: ' custom continue ',
        maxRepeats: 2.9
      }
    );

    expect(snapshot).toEqual({
      text: 'custom continue',
      maxRepeats: 2,
      used: 0,
      source: 'default'
    });

    expect(resolveDefaultStopMessageSnapshot(
      {
        base: {
          choices: [{
            finish_reason: 'tool_calls',
            message: { tool_calls: [{ id: 'call_1' }] }
          }]
        },
        adapterContext: {}
      }
    )).toBeNull();
  });

  test('uses Rust-owned implicit Gemini empty responses snapshot resolver', () => {
    const adapterContext = {
      __rt: {
        stopGatewayContext: {
          observed: true,
          eligible: true,
          source: 'responses',
          reason: 'status_completed'
        }
      }
    };

    expect(resolveImplicitGeminiStopMessageSnapshot(
      {
        base: { status: 'completed', output: [] },
        adapterContext,
        providerProtocol: 'gemini-chat'
      },
      {
        entryEndpoint: '/v1/responses'
      }
    )).toEqual({
      text: '继续执行',
      maxRepeats: 1,
      used: 0,
      source: 'auto'
    });

    expect(resolveImplicitGeminiStopMessageSnapshot(
      {
        base: {
          status: 'completed',
          output: [{
            type: 'message',
            content: [{ type: 'output_text', text: 'visible' }]
          }]
        },
        adapterContext,
        providerProtocol: 'gemini-chat'
      },
      {
        entryEndpoint: '/v1/responses'
      }
    )).toBeNull();

    expect(resolveImplicitGeminiStopMessageSnapshot(
      {
        base: {
          status: 'completed',
          output: [{ type: 'function_call', arguments: '{}' }]
        },
        adapterContext,
        providerProtocol: 'gemini-chat'
      },
      {
        entryEndpoint: '/v1/responses'
      }
    )).toBeNull();
  });
});
