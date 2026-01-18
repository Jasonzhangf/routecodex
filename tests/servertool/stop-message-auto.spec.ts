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
    const payload = followup.payload as JsonObject;
    const messages = Array.isArray((payload as any).messages) ? (payload as any).messages : [];
    expect(messages.length).toBeGreaterThan(1);
    const last = messages[messages.length - 1] as any;
    expect(last.role).toBe('user');
    expect(last.content).toBe('继续');
    expect(followup.metadata?.disableStickyRoutes).toBe(true);
    expect(followup.metadata?.preserveRouteHint).toBe(false);

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

    const result = await runServerSideToolEngine({
      chatResponse: responsesPayload,
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-stopmessage-resp-1',
      providerProtocol: 'gemini-chat',
      reenterPipeline: async () => {
        throw new Error('unexpected followup execution in this test');
      }
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('stop_message_flow');
    const followup = result.execution?.followup as any;
    expect(followup).toBeDefined();
    expect(followup.metadata?.disableStickyRoutes).toBe(true);
    expect(followup.metadata?.preserveRouteHint).toBe(false);
    expect(followup.metadata?.stream).toBe(false);
    expect(followup.metadata?.serverToolOriginalEntryEndpoint).toBe('/v1/responses');

    const payload = followup.payload as any;
    expect(payload.messages).toBeUndefined();
    expect(Array.isArray(payload.input)).toBe(true);
    expect(payload.stream).toBe(false);
    expect(payload.parameters).toBeUndefined();
    expect(payload.max_output_tokens).toBe(99);
    expect(payload.temperature).toBe(0.1);

    const inputText = JSON.stringify(payload.input);
    expect(inputText).toContain('hi');
    expect(inputText).toContain('ok');
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

    const result = await runServerSideToolEngine({
      chatResponse: responsesPayload,
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-stopmessage-resp-2',
      providerProtocol: 'gemini-chat',
      reenterPipeline: async () => {
        throw new Error('unexpected followup execution in this test');
      }
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('stop_message_flow');
    const followup = result.execution?.followup as any;
    expect(followup).toBeDefined();
    expect(followup.metadata?.stream).toBe(false);

    const payload = followup.payload as any;
    expect(payload.messages).toBeUndefined();
    expect(Array.isArray(payload.input)).toBe(true);
    expect(payload.stream).toBe(false);
    expect(payload.parameters).toBeUndefined();
    expect(payload.max_output_tokens).toBe(77);
    expect(payload.temperature).toBe(0.2);

    const inputText = JSON.stringify(payload.input);
    expect(inputText).toContain('hi');
    expect(inputText).toContain('ok');
    expect(inputText).toContain('继续执行');
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
