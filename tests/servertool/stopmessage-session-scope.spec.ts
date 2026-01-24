import * as fs from 'node:fs';
import * as path from 'node:path';
import { bootstrapVirtualRouterConfig } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap.js';
import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine.js';
import { VirtualRouterError } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/types.js';
import { saveRoutingInstructionStateSync } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/sticky-session-store.js';
import type { StandardizedRequest } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/standardized.js';

const SESSION_DIR = path.join(process.cwd(), 'tmp', 'jest-stopmessage-session-scope');

function buildEngine(): VirtualRouterEngine {
  const input: any = {
    virtualrouter: {
      providers: {
        mock: {
          id: 'mock',
          type: 'openai',
          endpoint: 'https://example.invalid',
          auth: { type: 'apikey', keys: { key1: { value: 'TEST' } } },
          models: { 'gpt-test': {} }
        }
      },
      routing: { default: ['mock.gpt-test'] }
    }
  };
  const { config } = bootstrapVirtualRouterConfig(input);
  const engine = new VirtualRouterEngine();
  engine.initialize(config);
  return engine;
}

function readSessionState(sessionId: string): any {
  const filepath = path.join(SESSION_DIR, `session-${sessionId}.json`);
  const raw = fs.readFileSync(filepath, 'utf8');
  return JSON.parse(raw);
}

describe('stopMessage is session-scoped', () => {
  beforeAll(() => {
    process.env.ROUTECODEX_SESSION_DIR = SESSION_DIR;
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
  });

  test('throws when stopMessage is set without sessionId', () => {
    const engine = buildEngine();
    const request: StandardizedRequest = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: '<**stopMessage:\"继续\"**>\\nhello' }],
      tools: [],
      parameters: {}
    } as any;
    expect(() =>
      engine.route(request, {
        requestId: 'req_stopmessage_missing_session',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        routeHint: 'default'
      } as any)
    ).toThrow(VirtualRouterError);
  });

  test('persists stopMessage under session:<sessionId> only', () => {
    const engine = buildEngine();
    const sessionId = 'sess-123';
    const request: StandardizedRequest = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: '<**stopMessage:\"继续\",2**>\\nhello' }],
      tools: [],
      parameters: {}
    } as any;

    engine.route(request, {
      requestId: 'req_stopmessage_session',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      conversationId: 'conv-should-not-be-used',
      routeHint: 'default'
    } as any);

    const persisted = readSessionState(sessionId);
    expect(persisted?.state?.stopMessageText).toBe('继续');
    expect(persisted?.state?.stopMessageMaxRepeats).toBe(2);
    expect(fs.existsSync(path.join(SESSION_DIR, 'conversation-conv-should-not-be-used.json'))).toBe(false);
  });

  test('clears stopMessage with a monotonic updatedAt timestamp', () => {
    const engine = buildEngine();
    const sessionId = 'sess-clear-1';
    const setRequest: StandardizedRequest = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: '<**stopMessage:\"继续\",1**>\\nhello' }],
      tools: [],
      parameters: {}
    } as any;

    engine.route(setRequest, {
      requestId: 'req_stopmessage_set_clear',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      routeHint: 'default'
    } as any);

    const before = readSessionState(sessionId);
    expect(before?.state?.stopMessageText).toBe('继续');
    const beforeUpdatedAt = before?.state?.stopMessageUpdatedAt;
    expect(typeof beforeUpdatedAt === 'number').toBe(true);

    const clearRequest: StandardizedRequest = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: '<**stopMessage:clear**>\\nhello' }],
      tools: [],
      parameters: {}
    } as any;

    engine.route(clearRequest, {
      requestId: 'req_stopmessage_clear',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      routeHint: 'default'
    } as any);

    const after = readSessionState(sessionId);
    expect(after?.state?.stopMessageText).toBeUndefined();
    expect(after?.state?.stopMessageMaxRepeats).toBeUndefined();
    expect(typeof after?.state?.stopMessageUpdatedAt).toBe('number');
    expect(after?.state?.stopMessageUpdatedAt).toBeGreaterThanOrEqual(beforeUpdatedAt);
  });

  test('does not reapply stopMessage from history after it is cleared/consumed', () => {
    const engine = buildEngine();
    const sessionId = 'sess-no-reapply-1';

    // Initial set (marker in the last user message).
    const setRequest: StandardizedRequest = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: '<**stopMessage:\"继续\",1**>\\nhello' }],
      tools: [],
      parameters: {}
    } as any;
    engine.route(setRequest, {
      requestId: 'req_stopmessage_set_once',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      routeHint: 'default'
    } as any);

    // Simulate "consumed and cleared" by servertool reservation (no user clear marker in history).
    const clearedAt = Date.now();
    saveRoutingInstructionStateSync(`session:${sessionId}`, {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: undefined,
      stopMessageMaxRepeats: undefined,
      stopMessageUsed: undefined,
      stopMessageUpdatedAt: clearedAt,
      stopMessageLastUsedAt: clearedAt
    } as any);

    // Next request resends full history (includes the original stopMessage marker),
    // but the latest user message has no marker. stopMessage must NOT be re-applied.
    const nextRequest: StandardizedRequest = {
      model: 'gpt-test',
      messages: [
        { role: 'user', content: '<**stopMessage:\"继续\",1**>\\nhello' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'hi again' }
      ],
      tools: [],
      parameters: {}
    } as any;
    engine.route(nextRequest, {
      requestId: 'req_stopmessage_following_plain',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      routeHint: 'default'
    } as any);

    const persisted = readSessionState(sessionId);
    expect(persisted?.state?.stopMessageText).toBeUndefined();
    expect(persisted?.state?.stopMessageMaxRepeats).toBeUndefined();
  });

  test('re-arms stopMessage when set again with the same text/max after being exhausted', () => {
    const engine = buildEngine();
    const sessionId = 'sess-rearm-same-1';

    const setRequest: StandardizedRequest = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: '<**stopMessage:\"继续\",1**>\\nhello' }],
      tools: [],
      parameters: {}
    } as any;
    engine.route(setRequest, {
      requestId: 'req_stopmessage_rearm_set_1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      routeHint: 'default'
    } as any);

    const before = readSessionState(sessionId);
    expect(before?.state?.stopMessageText).toBe('继续');
    expect(before?.state?.stopMessageMaxRepeats).toBe(1);
    expect(before?.state?.stopMessageUsed).toBe(0);
    const beforeUpdatedAt = before?.state?.stopMessageUpdatedAt;
    expect(typeof beforeUpdatedAt === 'number').toBe(true);

    // Simulate servertool exhausting stopMessage (used === maxRepeats).
    const exhaustedAt = Date.now();
    saveRoutingInstructionStateSync(`session:${sessionId}`, {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续',
      stopMessageMaxRepeats: 1,
      stopMessageUsed: 1,
      stopMessageUpdatedAt: beforeUpdatedAt,
      stopMessageLastUsedAt: exhaustedAt,
      stopMessageSource: 'explicit'
    } as any);

    const setAgainRequest: StandardizedRequest = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: '<**stopMessage:\"继续\",1**>\\nhello again' }],
      tools: [],
      parameters: {}
    } as any;
    engine.route(setAgainRequest, {
      requestId: 'req_stopmessage_rearm_set_2',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      routeHint: 'default'
    } as any);

    const after = readSessionState(sessionId);
    expect(after?.state?.stopMessageText).toBe('继续');
    expect(after?.state?.stopMessageMaxRepeats).toBe(1);
    expect(after?.state?.stopMessageUsed).toBe(0);
    expect(typeof after?.state?.stopMessageUpdatedAt).toBe('number');
    expect(after?.state?.stopMessageUpdatedAt).toBeGreaterThanOrEqual(beforeUpdatedAt);
    expect(after?.state?.stopMessageLastUsedAt).toBeUndefined();
  });
});
