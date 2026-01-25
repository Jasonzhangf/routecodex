import * as fs from 'node:fs';
import * as path from 'node:path';
import { runServerSideToolEngine } from '../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js';
import { runServerToolOrchestration } from '../../sharedmodule/llmswitch-core/src/servertool/engine.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';
import {
  serializeRoutingInstructionState,
  type RoutingInstructionState
} from '../../sharedmodule/llmswitch-core/src/router/virtual-router/routing-instructions.js';
import { buildResponsesRequestFromChat } from '../../sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.js';
import { ensureRuntimeMetadata } from '../../sharedmodule/llmswitch-core/src/conversion/shared/runtime-metadata.js';

const SESSION_DIR = path.join(process.cwd(), 'tmp', 'jest-stopmessage-sessions');

function writeRoutingStateForSession(sessionId: string, state: RoutingInstructionState): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const filename = `session-${sessionId}.json`;
  const filepath = path.join(SESSION_DIR, filename);
  const payload = {
    version: 1,
    state: serializeRoutingInstructionState(state)
  };
  fs.writeFileSync(filepath, JSON.stringify(payload), { encoding: 'utf8' });
}

async function readJsonFileWithRetry<T>(filepath: string, attempts = 20, delayMs = 10): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const raw = fs.readFileSync(filepath, 'utf8');
      if (!raw || !raw.trim()) {
        throw new Error('empty file');
      }
      return JSON.parse(raw) as T;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'failed to read json'));
}

describe('stop_message_auto servertool', () => {
  beforeAll(() => {
    process.env.ROUTECODEX_SESSION_DIR = SESSION_DIR;
  });

  test('schedules followup when stopMessage is active and finish_reason=stop', async () => {
    const sessionId = 'stopmessage-spec-session-1';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续',
      stopMessageMaxRepeats: 2,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const capturedChatRequest: JsonObject = {
      model: 'gpt-test',
      messages: [
        {
          role: 'user',
          content: 'hi'
        }
      ]
    };

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stop-1',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'ok'
          },
          finish_reason: 'stop'
        }
      ]
    };

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      capturedChatRequest
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-stopmessage-1',
      providerProtocol: 'openai-chat'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('stop_message_flow');
    const followup = result.execution?.followup as any;
    expect(followup).toBeDefined();
    expect(followup.entryEndpoint).toBe('/v1/chat/completions');
    expect(Array.isArray(followup.injection?.ops)).toBe(true);
    const ops = followup.injection.ops as any[];
    expect(ops.some((op) => op?.op === 'append_user_text' && op?.text === '继续')).toBe(true);

    const persisted = await readJsonFileWithRetry<{ state?: { stopMessageUsed?: number; stopMessageLastUsedAt?: number } }>(
      path.join(SESSION_DIR, `session-${sessionId}.json`)
    );
    // stopMessage usage counter is reserved only when followup is executed (servertool orchestration),
    // not when the handler merely schedules the followup.
    expect(persisted?.state?.stopMessageUsed).toBe(0);
  });

  test('builds /v1/responses followup and preserves parameters (non-streaming)', async () => {
    const sessionId = 'stopmessage-spec-session-responses';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续执行',
      stopMessageMaxRepeats: 1,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const capturedChatRequest: JsonObject = {
      model: 'gemini-test',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'exec_command',
            description: 'Run a shell command',
            parameters: {
              type: 'object',
              properties: { cmd: { type: 'string' } },
              required: ['cmd'],
              additionalProperties: false
            }
          }
        }
      ],
      parameters: {
        max_output_tokens: 99,
        temperature: 0.1,
        stream: true
      }
    };

    const responsesPayload: JsonObject = {
      id: 'resp-stopmessage-1',
      object: 'response',
      model: 'gemini-test',
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }]
    };

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-resp-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'gemini-chat',
      sessionId,
      capturedChatRequest
    } as any;

    let capturedFollowup: { entryEndpoint?: string; body?: any; metadata?: any } | null = null;
    const orchestration = await runServerToolOrchestration({
      chat: responsesPayload,
      adapterContext,
      requestId: 'req-stopmessage-resp-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'gemini-chat',
      reenterPipeline: async (opts: any) => {
        capturedFollowup = { entryEndpoint: opts?.entryEndpoint, body: opts?.body, metadata: opts?.metadata };
        return {
          body: {
            id: 'resp-stopmessage-followup-1',
            object: 'response',
            model: 'gemini-test',
            status: 'completed',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }]
          } as JsonObject
        };
      }
    });

    expect(orchestration.executed).toBe(true);
    expect(orchestration.flowId).toBe('stop_message_flow');

    const persisted = await readJsonFileWithRetry<{
      state?: {
        stopMessageText?: unknown;
        stopMessageMaxRepeats?: unknown;
        stopMessageUsed?: unknown;
        stopMessageUpdatedAt?: unknown;
        stopMessageLastUsedAt?: unknown;
      };
    }>(path.join(SESSION_DIR, `session-${sessionId}.json`));
    expect(persisted?.state?.stopMessageText).toBeUndefined();
    expect(persisted?.state?.stopMessageMaxRepeats).toBeUndefined();
    expect(persisted?.state?.stopMessageUsed).toBeUndefined();
    expect(typeof persisted?.state?.stopMessageUpdatedAt).toBe('number');
    expect(typeof persisted?.state?.stopMessageLastUsedAt).toBe('number');

    expect(capturedFollowup).toBeTruthy();
    expect(capturedFollowup?.entryEndpoint).toBe('/v1/responses');
    expect(capturedFollowup?.metadata?.__rt?.disableStickyRoutes).toBe(true);
    expect(capturedFollowup?.metadata?.__rt?.preserveRouteHint).toBe(false);
    expect(capturedFollowup?.metadata?.stream).toBe(false);
    expect(capturedFollowup?.metadata?.__rt?.serverToolOriginalEntryEndpoint).toBe('/v1/responses');

    const payload = capturedFollowup?.body as any;
    expect(Array.isArray(payload.messages)).toBe(true);
    expect(payload.stream).toBe(false);
    expect(Array.isArray(payload.tools)).toBe(true);
    expect(payload.tools.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(payload.tools)).toContain('exec_command');
    expect(payload.parameters).toBeDefined();
    expect(payload.parameters.stream).toBeUndefined();
    expect(payload.parameters.max_output_tokens).toBe(99);
    expect(payload.parameters.temperature).toBe(0.1);

    const inputText = JSON.stringify(payload.messages);
    expect(inputText).toContain('hi');
    expect(inputText).toContain('继续执行');
  });

  test('builds /v1/responses followup when captured request is a Responses payload', async () => {
    const sessionId = 'stopmessage-spec-session-responses-captured';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续执行',
      stopMessageMaxRepeats: 1,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const capturedChatSeed: JsonObject = {
      model: 'gemini-test',
      messages: [{ role: 'user', content: 'hi' }],
      parameters: {
        max_output_tokens: 77,
        temperature: 0.2,
        stream: true
      }
    };
    const capturedChatRequest = buildResponsesRequestFromChat(capturedChatSeed as any, {
      stream: true
    }).request as unknown as JsonObject;

    const responsesPayload: JsonObject = {
      id: 'resp-stopmessage-2',
      object: 'response',
      model: 'gemini-test',
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }]
    };

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-resp-2',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'gemini-chat',
      sessionId,
      capturedChatRequest
    } as any;

    let capturedFollowup: { entryEndpoint?: string; body?: any; metadata?: any } | null = null;
    const orchestration = await runServerToolOrchestration({
      chat: responsesPayload,
      adapterContext,
      requestId: 'req-stopmessage-resp-2',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'gemini-chat',
      reenterPipeline: async (opts: any) => {
        capturedFollowup = { entryEndpoint: opts?.entryEndpoint, body: opts?.body, metadata: opts?.metadata };
        return {
          body: {
            id: 'resp-stopmessage-followup-2',
            object: 'response',
            model: 'gemini-test',
            status: 'completed',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }]
          } as JsonObject
        };
      }
    });

    expect(orchestration.executed).toBe(true);
    expect(orchestration.flowId).toBe('stop_message_flow');
    expect(capturedFollowup).toBeTruthy();
    expect(capturedFollowup?.entryEndpoint).toBe('/v1/responses');
    expect(capturedFollowup?.metadata?.stream).toBe(false);

    const payload = capturedFollowup?.body as any;
    expect(Array.isArray(payload.messages)).toBe(true);
    expect(payload.stream).toBe(false);
    expect(payload.parameters).toBeDefined();
    expect(payload.parameters.stream).toBeUndefined();
    expect(payload.parameters.max_output_tokens).toBe(77);
    expect(payload.parameters.temperature).toBe(0.2);

    const inputText = JSON.stringify(payload.messages);
    expect(inputText).toContain('hi');
    expect(inputText).toContain('继续执行');
  });

  test('followup hop still triggers servertools but does not nest followups', async () => {
    const sessionId = 'stopmessage-spec-session-followup-hop';
    // No routing state required: we are testing serverToolFollowup behavior, not stopMessage scheduling.
    writeRoutingStateForSession(sessionId, {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map()
    } as any);

    const capturedChatRequest: JsonObject = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'clock',
            description: 'get time',
            parameters: { type: 'object', properties: { action: { type: 'string' } } }
          }
        }
      ]
    };

    const adapterContext: AdapterContext = {
      requestId: 'req-followup-hop-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-chat',
      sessionId,
      capturedChatRequest
    } as any;
    const rt = ensureRuntimeMetadata(adapterContext as any);
    (rt as any).serverToolFollowup = true;
    // Pretend we are inside a stopMessage followup hop; other flows must not start new followups.
    (rt as any).serverToolLoopState = { flowId: 'stop_message_flow', repeatCount: 1 };
    // Avoid starting the clock daemon; we only need tool output injection for this test.
    (rt as any).clock = { enabled: false };

    const chatResponse: JsonObject = {
      id: 'chatcmpl-tool-1',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_clock_1',
                type: 'function',
                function: { name: 'clock', arguments: JSON.stringify({ action: 'list' }) }
              }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ]
    };

    let reentered = 0;
    const orchestration = await runServerToolOrchestration({
      chat: chatResponse,
      adapterContext,
      requestId: 'req-followup-hop-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => {
        reentered += 1;
        return { body: { ok: true } as any };
      }
    });

    expect(orchestration.executed).toBe(true);
    // A followup hop should not reenter again (no nested followups).
    expect(reentered).toBe(0);
    expect(JSON.stringify(orchestration.chat)).toContain('tool_outputs');
    expect(JSON.stringify(orchestration.chat)).toContain('call_clock_1');
  });

  test('skips followup when client disconnects mid-stream', async () => {
    const sessionId = 'stopmessage-spec-session-disconnected';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续',
      stopMessageMaxRepeats: 2,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const capturedChatRequest: JsonObject = {
      model: 'gpt-test',
      messages: [
        {
          role: 'user',
          content: 'hi'
        }
      ]
    };

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stop-2',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'ok'
          },
          finish_reason: 'stop'
        }
      ]
    };

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-2',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      capturedChatRequest,
      clientConnectionState: { disconnected: true }
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-stopmessage-2',
      providerProtocol: 'openai-chat'
    });

    expect(result.mode).toBe('passthrough');
  });

  test('forces followup stream=false even when captured parameters.stream=true', async () => {
    const sessionId = 'stopmessage-spec-session-stream-override';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续',
      stopMessageMaxRepeats: 1,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const capturedChatRequest: JsonObject = {
      model: 'gpt-test',
      messages: [
        {
          role: 'user',
          content: 'hi'
        }
      ],
      parameters: {
        stream: true
      }
    };

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stop-stream-1',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'ok'
          },
          finish_reason: 'stop'
        }
      ]
    };

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-stream-1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      capturedChatRequest
    } as any;

    let sawFollowupStreamFalse = false;
    const orchestration = await runServerToolOrchestration({
      chat: chatResponse,
      adapterContext,
      requestId: 'req-stopmessage-stream-1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      reenterPipeline: async (opts: any) => {
        sawFollowupStreamFalse = opts?.body?.stream === false;
        return {
          body: {
            id: 'chatcmpl-stop-stream-1-followup',
            object: 'chat.completion',
            model: 'gpt-test',
            choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }]
          } as JsonObject
        };
      }
    });

    expect(orchestration.executed).toBe(true);
    expect(orchestration.flowId).toBe('stop_message_flow');
    expect(sawFollowupStreamFalse).toBe(true);
  });

  test('retries once on empty stop_followup and then succeeds', async () => {
    const sessionId = 'stopmessage-spec-session-empty-retry';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续',
      stopMessageMaxRepeats: 1,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const capturedChatRequest: JsonObject = {
      model: 'gpt-test',
      messages: [
        {
          role: 'user',
          content: 'hi'
        }
      ]
    };

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stop-empty-1',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'ok'
          },
          finish_reason: 'stop'
        }
      ]
    };

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-empty-1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      capturedChatRequest
    } as any;

    let callCount = 0;
    const orchestration = await runServerToolOrchestration({
      chat: chatResponse,
      adapterContext,
      requestId: 'req-stopmessage-empty-1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            body: {
              id: 'chatcmpl-followup-empty',
              object: 'chat.completion',
              model: 'gpt-test',
              choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }]
            } as JsonObject
          };
        }
        return {
          body: {
            id: 'chatcmpl-followup-nonempty',
            object: 'chat.completion',
            model: 'gpt-test',
            choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }]
          } as JsonObject
        };
      }
    });

    expect(orchestration.executed).toBe(true);
    expect(orchestration.flowId).toBe('stop_message_flow');
    expect(callCount).toBe(2);
    expect((orchestration.chat as any)?.id).toBe('chatcmpl-followup-nonempty');
  });

  test('errors when stop_followup stays empty after retry', async () => {
    const sessionId = 'stopmessage-spec-session-empty-error';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续',
      stopMessageMaxRepeats: 1,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const capturedChatRequest: JsonObject = {
      model: 'gpt-test',
      messages: [
        {
          role: 'user',
          content: 'hi'
        }
      ]
    };

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stop-empty-2',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'ok'
          },
          finish_reason: 'stop'
        }
      ]
    };

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-empty-2',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      capturedChatRequest
    } as any;

    const orchestration = await runServerToolOrchestration({
      chat: chatResponse,
      adapterContext,
      requestId: 'req-stopmessage-empty-2',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => ({
        body: {
          id: 'chatcmpl-followup-empty',
          object: 'chat.completion',
          model: 'gpt-test',
          choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }]
        } as JsonObject
      })
    });

    // stopMessage followup empty: should not bubble 502; return original response and disable stopMessage to avoid loops.
    expect(orchestration.executed).toBe(true);
    expect(orchestration.flowId).toBe('stop_message_flow');
    expect((orchestration.chat as any)?.id).toBe('chatcmpl-stop-empty-2');

    const persisted = await readJsonFileWithRetry<{ state?: { stopMessageText?: unknown; stopMessageMaxRepeats?: unknown } }>(
      path.join(SESSION_DIR, `session-${sessionId}.json`)
    );
    expect(persisted?.state?.stopMessageText).toBeUndefined();
    expect(persisted?.state?.stopMessageMaxRepeats).toBeUndefined();
  });
});
