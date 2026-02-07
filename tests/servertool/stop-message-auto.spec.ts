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
const USER_DIR = path.join(process.cwd(), 'tmp', 'jest-stopmessage-userdir');

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

async function readJsonFileUntil<T>(
  filepath: string,
  predicate: (data: T) => boolean,
  attempts = 50,
  delayMs = 10
): Promise<T> {
  let lastError: unknown;
  let lastValue: T | undefined;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const raw = fs.readFileSync(filepath, 'utf8');
      if (!raw || !raw.trim()) {
        throw new Error('empty file');
      }
      const parsed = JSON.parse(raw) as T;
      lastValue = parsed;
      if (predicate(parsed)) {
        return parsed;
      }
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  if (lastValue !== undefined) {
    throw new Error(`condition not met for ${filepath}: ${JSON.stringify(lastValue)}`);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'failed to read json'));
}

describe('stop_message_auto servertool', () => {
  beforeAll(() => {
    process.env.ROUTECODEX_SESSION_DIR = SESSION_DIR;
    process.env.ROUTECODEX_USER_DIR = USER_DIR;
    process.env.ROUTECODEX_STOPMESSAGE_STAGE_MODE = 'off';
    fs.mkdirSync(USER_DIR, { recursive: true });
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

    const persisted = await readJsonFileUntil<{ state?: { stopMessageUsed?: number; stopMessageLastUsedAt?: number } }>(
      path.join(SESSION_DIR, `session-${sessionId}.json`),
      (data) => data?.state?.stopMessageUsed === 1 && typeof data?.state?.stopMessageLastUsedAt === 'number'
    );
    // llmswitch-core main: stopMessage usage counter increments as soon as we decide to trigger followup.
    expect(persisted?.state?.stopMessageUsed).toBe(1);
    expect(typeof persisted?.state?.stopMessageLastUsedAt).toBe('number');
  });

  test('skips stop_message retrigger on stop_message_flow followup hops', async () => {
    const sessionId = 'stopmessage-spec-session-followup-allow';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续',
      stopMessageMaxRepeats: 30,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stop-followup-allow',
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
      requestId: 'req-stopmessage-followup-allow',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hi' }]
      },
      __rt: {
        serverToolFollowup: true,
        serverToolLoopState: {
          flowId: 'stop_message_flow',
          repeatCount: 1,
          payloadHash: 'seed'
        }
      }
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-stopmessage-followup-allow',
      providerProtocol: 'openai-chat'
    });

    expect(result.mode).toBe('passthrough');

    const persisted = await readJsonFileUntil<{ state?: { stopMessageUsed?: number } }>(
      path.join(SESSION_DIR, `session-${sessionId}.json`),
      (data) => data?.state?.stopMessageUsed === 0
    );
    expect(persisted?.state?.stopMessageUsed).toBe(0);
  });

  test('skips stop_message retrigger for non-stop followup flows', async () => {
    const sessionId = 'stopmessage-spec-session-followup-cross-flow';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续',
      stopMessageMaxRepeats: 30,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stop-followup-cross-flow',
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
      requestId: 'req-stopmessage-followup-cross-flow',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hi' }]
      },
      __rt: {
        serverToolFollowup: true,
        serverToolLoopState: {
          flowId: 'web_search_flow',
          repeatCount: 1,
          payloadHash: 'seed'
        }
      }
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-stopmessage-followup-cross-flow',
      providerProtocol: 'openai-chat'
    });

    expect(result.mode).toBe('passthrough');

    const persisted = await readJsonFileWithRetry<{ state?: { stopMessageUsed?: number } }>(
      path.join(SESSION_DIR, `session-${sessionId}.json`)
    );
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

    const persisted = await readJsonFileUntil<{
      state?: {
        stopMessageText?: unknown;
        stopMessageMaxRepeats?: unknown;
        stopMessageUsed?: unknown;
        stopMessageUpdatedAt?: unknown;
        stopMessageLastUsedAt?: unknown;
      };
    }>(
      path.join(SESSION_DIR, `session-${sessionId}.json`),
      (data) =>
        (data as any)?.state?.stopMessageText === undefined &&
        (data as any)?.state?.stopMessageMaxRepeats === undefined &&
        (data as any)?.state?.stopMessageUsed === undefined &&
        typeof (data as any)?.state?.stopMessageUpdatedAt === 'number' &&
        typeof (data as any)?.state?.stopMessageLastUsedAt === 'number'
    );
    // stopMessage is now one-shot per request chain. For maxRepeats=1, state is cleared at trigger-time
    // and leaves a tombstone timestamp pair to prevent accidental re-application.
    expect(persisted?.state?.stopMessageText).toBeUndefined();
    expect(persisted?.state?.stopMessageMaxRepeats).toBeUndefined();
    expect(persisted?.state?.stopMessageUsed).toBeUndefined();
    expect(typeof persisted?.state?.stopMessageLastUsedAt).toBe('number');
    expect(typeof persisted?.state?.stopMessageUpdatedAt).toBe('number');

    expect(capturedFollowup).toBeTruthy();
    expect(capturedFollowup?.entryEndpoint).toBe('/v1/responses');
    expect(capturedFollowup?.metadata?.__rt?.disableStickyRoutes).toBe(true);
    expect(capturedFollowup?.metadata?.__rt?.preserveRouteHint).toBe(false);
    expect(capturedFollowup?.metadata?.stream).toBe(false);
    expect(capturedFollowup?.metadata?.__rt?.serverToolOriginalEntryEndpoint).toBe('/v1/responses');

    const payload = capturedFollowup?.body as any;
    expect(Array.isArray(payload.messages)).toBe(true);
    expect(payload.stream).toBe(false);
    expect(payload.parameters).toBeDefined();
    expect(payload.parameters.stream).toBeUndefined();
    expect(payload.parameters.max_output_tokens).toBe(99);
    expect(payload.parameters.temperature).toBe(0.1);
    expect(Array.isArray(payload.tools)).toBe(true);
    expect(JSON.stringify(payload.tools)).toContain("\"name\":\"apply_patch\"");

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

  test('uses staged status-check template on first followup', async () => {
    const tempUserDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp', 'stopmessage-stage-userdir-'));
    const prevUserDir = process.env.ROUTECODEX_USER_DIR;
    const prevStageMode = process.env.ROUTECODEX_STOPMESSAGE_STAGE_MODE;
    try {
      fs.mkdirSync(path.join(tempUserDir, 'stopMessage'), { recursive: true });
      fs.writeFileSync(
        path.join(tempUserDir, 'stopMessage', 'stage-status-check.md'),
        '阶段A：先看 BD 状态\n{{BASE_STOP_MESSAGE}}',
        'utf8'
      );
      fs.writeFileSync(
        path.join(tempUserDir, 'stopMessage', 'stage-loop-self-check.md'),
        '阶段B：循环自检\n{{BASE_STOP_MESSAGE}}',
        'utf8'
      );
      process.env.ROUTECODEX_USER_DIR = tempUserDir;
      process.env.ROUTECODEX_STOPMESSAGE_STAGE_MODE = 'on';

      const sessionId = 'stopmessage-spec-session-stage-1';
      const state: RoutingInstructionState = {
        forcedTarget: undefined,
        stickyTarget: undefined,
        allowedProviders: new Set(),
        disabledProviders: new Set(),
        disabledKeys: new Map(),
        disabledModels: new Map(),
        stopMessageText: '先执行、后汇报',
        stopMessageMaxRepeats: 5,
        stopMessageUsed: 0
      };
      writeRoutingStateForSession(sessionId, state);

      const chatResponse: JsonObject = {
        id: 'chatcmpl-stage-1',
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
        requestId: 'req-stopmessage-stage-1',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        sessionId,
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [
            { role: 'user', content: '先执行任务' },
            { role: 'assistant', content: '收到' },
            { role: 'tool', content: '执行了代码修改并准备验证' }
          ]
        }
      } as any;

      const result = await runServerSideToolEngine({
        chatResponse,
        adapterContext,
        entryEndpoint: '/v1/chat/completions',
        requestId: 'req-stopmessage-stage-1',
        providerProtocol: 'openai-chat'
      });

      expect(result.mode).toBe('tool_flow');
      const followup = result.execution?.followup as any;
      const ops = Array.isArray(followup?.injection?.ops) ? followup.injection.ops : [];
      const appendUserText = ops.find((entry: any) => entry?.op === 'append_user_text');
      expect(appendUserText?.text).toContain('先执行、后汇报');

      const persisted = await readJsonFileUntil<{ state?: { stopMessageStage?: string; stopMessageObservationStableCount?: number } }>(
        path.join(SESSION_DIR, `session-${sessionId}.json`),
        (data) => data?.state?.stopMessageStage === 'status_probe' || data?.state?.stopMessageStage === 'active_continue'
      );
      if (persisted?.state?.stopMessageStage === 'status_probe') {
        expect(appendUserText?.text).toContain('阶段A：先看 BD 状态');
      } else {
        expect(appendUserText?.text).toContain('继续执行');
      }
      expect(persisted?.state?.stopMessageObservationStableCount).toBe(0);
    } finally {
      if (prevUserDir === undefined) {
        delete process.env.ROUTECODEX_USER_DIR;
      } else {
        process.env.ROUTECODEX_USER_DIR = prevUserDir;
      }
      if (prevStageMode === undefined) {
        delete process.env.ROUTECODEX_STOPMESSAGE_STAGE_MODE;
      } else {
        process.env.ROUTECODEX_STOPMESSAGE_STAGE_MODE = prevStageMode;
      }
      fs.rmSync(tempUserDir, { recursive: true, force: true });
    }
  });


  test('uses active-continue template when bd has in_progress', async () => {
    const tempUserDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp', 'stopmessage-stage-active-userdir-'));
    const prevUserDir = process.env.ROUTECODEX_USER_DIR;
    const prevStageMode = process.env.ROUTECODEX_STOPMESSAGE_STAGE_MODE;
    try {
      fs.mkdirSync(path.join(tempUserDir, 'stopMessage'), { recursive: true });
      fs.writeFileSync(
        path.join(tempUserDir, 'stopMessage', 'stage-status-check.md'),
        '阶段A：状态确认\n{{BASE_STOP_MESSAGE}}',
        'utf8'
      );
      fs.writeFileSync(
        path.join(tempUserDir, 'stopMessage', 'stage-active-continue.md'),
        '阶段A2：强制继续执行\n{{BASE_STOP_MESSAGE}}',
        'utf8'
      );
      fs.writeFileSync(
        path.join(tempUserDir, 'stopMessage', 'stage-loop-self-check.md'),
        '阶段B：循环自检\n{{BASE_STOP_MESSAGE}}',
        'utf8'
      );
      process.env.ROUTECODEX_USER_DIR = tempUserDir;
      process.env.ROUTECODEX_STOPMESSAGE_STAGE_MODE = 'on';

      const sessionId = 'stopmessage-spec-session-stage-active';
      const state: RoutingInstructionState = {
        forcedTarget: undefined,
        stickyTarget: undefined,
        allowedProviders: new Set(),
        disabledProviders: new Set(),
        disabledKeys: new Map(),
        disabledModels: new Map(),
        stopMessageText: '继续推进任务',
        stopMessageMaxRepeats: 5,
        stopMessageUsed: 0
      };
      writeRoutingStateForSession(sessionId, state);

      const chatResponse: JsonObject = {
        id: 'chatcmpl-stage-active',
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
        requestId: 'req-stopmessage-stage-active',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        sessionId,
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [
            { role: 'user', content: '继续执行' },
            { role: 'tool', content: 'bd --no-db show routecodex-77\nstatus: in_progress' }
          ]
        }
      } as any;

      const result = await runServerSideToolEngine({
        chatResponse,
        adapterContext,
        entryEndpoint: '/v1/chat/completions',
        requestId: 'req-stopmessage-stage-active',
        providerProtocol: 'openai-chat'
      });

      expect(result.mode).toBe('tool_flow');
      const followup = result.execution?.followup as any;
      const ops = Array.isArray(followup?.injection?.ops) ? followup.injection.ops : [];
      const appendUserText = ops.find((entry: any) => entry?.op === 'append_user_text');
      expect(appendUserText?.text).toContain('阶段A2：强制继续执行');
      expect(appendUserText?.text).toContain('继续推进任务');

      const persisted = await readJsonFileUntil<{ state?: { stopMessageStage?: string } }>(
        path.join(SESSION_DIR, `session-${sessionId}.json`),
        (data) => data?.state?.stopMessageStage === 'active_continue'
      );
      expect(persisted?.state?.stopMessageStage).toBe('active_continue');
    } finally {
      if (prevUserDir === undefined) {
        delete process.env.ROUTECODEX_USER_DIR;
      } else {
        process.env.ROUTECODEX_USER_DIR = prevUserDir;
      }
      if (prevStageMode === undefined) {
        delete process.env.ROUTECODEX_STOPMESSAGE_STAGE_MODE;
      } else {
        process.env.ROUTECODEX_STOPMESSAGE_STAGE_MODE = prevStageMode;
      }
      fs.rmSync(tempUserDir, { recursive: true, force: true });
    }
  });

  test('stops staged followup after repeated unchanged observations', async () => {
    const tempUserDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp', 'stopmessage-stage-loop-userdir-'));
    const prevUserDir = process.env.ROUTECODEX_USER_DIR;
    const prevStageMode = process.env.ROUTECODEX_STOPMESSAGE_STAGE_MODE;
    try {
      fs.mkdirSync(path.join(tempUserDir, 'stopMessage'), { recursive: true });
      fs.writeFileSync(
        path.join(tempUserDir, 'stopMessage', 'stage-status-check.md'),
        '阶段A：状态确认\n{{BASE_STOP_MESSAGE}}',
        'utf8'
      );
      fs.writeFileSync(
        path.join(tempUserDir, 'stopMessage', 'stage-loop-self-check.md'),
        '阶段B：循环自检\n{{BASE_STOP_MESSAGE}}',
        'utf8'
      );
      process.env.ROUTECODEX_USER_DIR = tempUserDir;
      process.env.ROUTECODEX_STOPMESSAGE_STAGE_MODE = 'on';

      const sessionId = 'stopmessage-spec-session-stage-loop';
      const state: RoutingInstructionState = {
        forcedTarget: undefined,
        stickyTarget: undefined,
        allowedProviders: new Set(),
        disabledProviders: new Set(),
        disabledKeys: new Map(),
        disabledModels: new Map(),
        stopMessageText: '继续推进同一任务',
        stopMessageMaxRepeats: 10,
        stopMessageUsed: 0
      };
      writeRoutingStateForSession(sessionId, state);

      const chatResponse: JsonObject = {
        id: 'chatcmpl-stage-loop',
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
        requestId: 'req-stopmessage-stage-loop',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        sessionId,
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [
            { role: 'user', content: '继续处理' },
            { role: 'assistant', content: '处理中' },
            { role: 'tool', content: 'bd --no-db show routecodex-77\nstatus: in_progress' }
          ]
        }
      } as any;

      const first = await runServerSideToolEngine({
        chatResponse,
        adapterContext,
        entryEndpoint: '/v1/chat/completions',
        requestId: 'req-stopmessage-stage-loop-1',
        providerProtocol: 'openai-chat'
      });
      expect(first.mode).toBe('tool_flow');
      await readJsonFileUntil<{ state?: { stopMessageObservationStableCount?: number } }>(
        path.join(SESSION_DIR, `session-${sessionId}.json`),
        (data) => data?.state?.stopMessageObservationStableCount === 0
      );

      const second = await runServerSideToolEngine({
        chatResponse,
        adapterContext,
        entryEndpoint: '/v1/chat/completions',
        requestId: 'req-stopmessage-stage-loop-2',
        providerProtocol: 'openai-chat'
      });
      expect(second.mode).toBe('tool_flow');
      await readJsonFileUntil<{ state?: { stopMessageObservationStableCount?: number } }>(
        path.join(SESSION_DIR, `session-${sessionId}.json`),
        (data) => data?.state?.stopMessageObservationStableCount === 1
      );

      const third = await runServerSideToolEngine({
        chatResponse,
        adapterContext,
        entryEndpoint: '/v1/chat/completions',
        requestId: 'req-stopmessage-stage-loop-3',
        providerProtocol: 'openai-chat'
      });
      expect(third.mode).toBe('passthrough');

      const persisted = await readJsonFileUntil<{ state?: { stopMessageText?: unknown; stopMessageMaxRepeats?: unknown } }>(
        path.join(SESSION_DIR, `session-${sessionId}.json`),
        (data) => data?.state?.stopMessageText === undefined && data?.state?.stopMessageMaxRepeats === undefined
      );
      expect(persisted?.state?.stopMessageText).toBeUndefined();
      expect(persisted?.state?.stopMessageMaxRepeats).toBeUndefined();
    } finally {
      if (prevUserDir === undefined) {
        delete process.env.ROUTECODEX_USER_DIR;
      } else {
        process.env.ROUTECODEX_USER_DIR = prevUserDir;
      }
      if (prevStageMode === undefined) {
        delete process.env.ROUTECODEX_STOPMESSAGE_STAGE_MODE;
      } else {
        process.env.ROUTECODEX_STOPMESSAGE_STAGE_MODE = prevStageMode;
      }
      fs.rmSync(tempUserDir, { recursive: true, force: true });
    }
  });


});
