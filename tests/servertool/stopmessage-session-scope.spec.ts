import * as fs from 'node:fs';
import * as path from 'node:path';
import { bootstrapVirtualRouterConfig } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/bootstrap.js';
import { VirtualRouterEngine } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine.js';
import { saveRoutingInstructionStateSync } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/sticky-session-store.js';
import { runServerSideToolEngine } from '../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';
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
  const sessionFile = path.join(SESSION_DIR, `session-${sessionId}.json`);
  const tmuxFile = path.join(SESSION_DIR, `tmux-${sessionId}.json`);
  const filepath = fs.existsSync(sessionFile) ? sessionFile : tmuxFile;
  const raw = fs.readFileSync(filepath, 'utf8');
  return JSON.parse(raw);
}

function sessionStatePath(sessionId: string): string {
  const sessionFile = path.join(SESSION_DIR, `session-${sessionId}.json`);
  if (fs.existsSync(sessionFile)) {
    return sessionFile;
  }
  return path.join(SESSION_DIR, `tmux-${sessionId}.json`);
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

  test('ignores stopMessage instruction when tmux scope is missing', () => {
    const engine = buildEngine();
    const request: StandardizedRequest = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: '<**stopMessage:"继续"**>\\nhello' }],
      tools: [],
      parameters: {}
    } as any;
    engine.route(request, {
      requestId: 'req_stopmessage_missing_session',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      routeHint: 'default'
    } as any);
    expect(fs.existsSync(path.join(SESSION_DIR, 'session-undefined.json'))).toBe(false);
  });

  test('persists stopMessage under session:<sessionId> only', () => {
    const engine = buildEngine();
    const sessionId = 'sess-123';
    const request: StandardizedRequest = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: '<**stopMessage:"继续",2**>\\nhello' }],
      tools: [],
      parameters: {}
    } as any;

    engine.route(request, {
      requestId: 'req_stopmessage_session',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      tmuxSessionId: sessionId,
      conversationId: 'conv-should-not-be-used',
      routeHint: 'default'
    } as any);

    const persisted = readSessionState(sessionId);
    expect(persisted?.state?.stopMessageText).toBe('继续');
    expect(persisted?.state?.stopMessageMaxRepeats).toBe(2);
    expect(fs.existsSync(path.join(SESSION_DIR, 'conversation-conv-should-not-be-used.json'))).toBe(false);
  });

  test('legacy session-scoped stopMessage is auto-cleared when tmux/daemon scope is missing', () => {
    const engine = buildEngine();
    const sessionId = 'sess-legacy-cleanup';
    saveRoutingInstructionStateSync(`session:${sessionId}`, {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: 'legacy-stop',
      stopMessageMaxRepeats: 5,
      stopMessageUsed: 0,
      stopMessageStageMode: 'on',
      stopMessageAiMode: 'on',
      preCommandScriptPath: '/tmp/legacy-pre-command.sh',
      preCommandUpdatedAt: Date.now()
    } as any);

    const metadata = {
      requestId: 'req-stopmessage-legacy-cleanup',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      routeHint: 'default'
    } as any;

    expect(engine.getStopMessageState(metadata)).toBeNull();
    expect(engine.getPreCommandState(metadata)).toBeNull();

    expect(fs.existsSync(sessionStatePath(sessionId))).toBe(false);
  });

  test('mode-only stopMessage:on no longer persists state', () => {
    const engine = buildEngine();
    const sessionId = 'sess-mode-only-default';
    const request: StandardizedRequest = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: '<**stopMessage:on**>继续执行当前任务' }],
      tools: [],
      parameters: {}
    } as any;

    engine.route(request, {
      requestId: 'req_stopmessage_mode_only_default',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      routeHint: 'default'
    } as any);

    expect(fs.existsSync(path.join(SESSION_DIR, `session-${sessionId}.json`))).toBe(false);
  });

  test('mode-only stopMessage:on does not expose runtime snapshot without text', () => {
    const engine = buildEngine();
    const sessionId = 'sess-mode-only-snapshot';
    const request: StandardizedRequest = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: '<**stopMessage:on,10**>继续执行当前任务' }],
      tools: [],
      parameters: {}
    } as any;

    const metadata = {
      requestId: 'req_stopmessage_mode_only_snapshot',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      routeHint: 'default'
    } as any;

    engine.route(request, metadata);

    const snapshot = engine.getStopMessageState(metadata);
    expect(snapshot).toBeNull();
  });

  test('mode-only stopMessage:on,10 keeps legacy mode-only counter state', () => {
    const engine = buildEngine();
    const sessionId = 'sess-mode-only-rearm';
    const metadata = {
      requestId: 'req_stopmessage_mode_only_rearm_1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      tmuxSessionId: sessionId,
      routeHint: 'default'
    } as any;
    const beforeUpdatedAt = Date.now() - 100;
    const consumedAt = Date.now();
    saveRoutingInstructionStateSync(`tmux:${sessionId}`, {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: undefined,
      stopMessageMaxRepeats: 10,
      stopMessageUsed: 4,
      stopMessageUpdatedAt: beforeUpdatedAt,
      stopMessageLastUsedAt: consumedAt,
      stopMessageStageMode: 'on',
      stopMessageSource: 'explicit'
    } as any);

    engine.route(
      {
        model: 'gpt-test',
        messages: [{ role: 'user', content: '<**stopMessage:on,10**>继续' }],
        tools: [],
        parameters: {}
      } as any,
      {
        ...metadata,
        requestId: 'req_stopmessage_mode_only_rearm_2'
      }
    );

    const snapshot = engine.getStopMessageState(metadata);
    expect(snapshot).toBeNull();
    const after = readSessionState(sessionId);
    expect(after?.state?.stopMessageText).toBeUndefined();
    expect(after?.state?.stopMessageStageMode).toBe('on');
    expect(after?.state?.stopMessageMaxRepeats).toBe(10);
    expect(after?.state?.stopMessageUsed).toBe(4);
    expect(typeof after?.state?.stopMessageUpdatedAt).toBe('number');
    expect(after?.state?.stopMessageUpdatedAt).toBeGreaterThanOrEqual(beforeUpdatedAt);
  });

  test('mode-only stopMessage remains non-persistent across engine restart', () => {
    const sessionId = 'sess-mode-only-restart';
    const request: StandardizedRequest = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: '<**stopMessage:on,10**>继续执行当前任务' }],
      tools: [],
      parameters: {}
    } as any;

    const metadata = {
      requestId: 'req_stopmessage_mode_only_restart',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      routeHint: 'default'
    } as any;

    const engine1 = buildEngine();
    engine1.route(request, metadata);

    const engine2 = buildEngine();
    const snapshot = engine2.getStopMessageState(metadata);
    expect(snapshot).toBeNull();
    expect(fs.existsSync(path.join(SESSION_DIR, `session-${sessionId}.json`))).toBe(false);
  });

  test('mode-only stopMessage does not create scoped state across restart when session dir changes', () => {
    const sessionId = 'sess-mode-only-restart-scoped-fallback';
    const request: StandardizedRequest = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: '<**stopMessage:on,10**>继续执行当前任务' }],
      tools: [],
      parameters: {}
    } as any;

    const metadata = {
      requestId: 'req_stopmessage_mode_only_restart_scoped_1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      routeHint: 'default'
    } as any;

    const scopedRoot = path.join(SESSION_DIR, 'scoped-restart-recovery', 'sessions');
    const firstScopedDir = path.join(scopedRoot, '127.0.0.1_5520');
    const secondScopedDir = path.join(scopedRoot, '0.0.0.0_5520');

    fs.rmSync(path.join(SESSION_DIR, 'scoped-restart-recovery'), { recursive: true, force: true });
    fs.mkdirSync(firstScopedDir, { recursive: true });
    fs.mkdirSync(secondScopedDir, { recursive: true });

    const previousSessionDir = process.env.ROUTECODEX_SESSION_DIR;

    try {
      process.env.ROUTECODEX_SESSION_DIR = firstScopedDir;
      const engine1 = buildEngine();
      engine1.route(request, metadata);

      const legacyScopedFile = path.join(firstScopedDir, 'session-' + sessionId + '.json');
      expect(fs.existsSync(legacyScopedFile)).toBe(false);

      process.env.ROUTECODEX_SESSION_DIR = secondScopedDir;
      const engine2 = buildEngine();
      const snapshot = engine2.getStopMessageState({
        ...metadata,
        requestId: 'req_stopmessage_mode_only_restart_scoped_2'
      } as any);

      expect(snapshot).toBeNull();
      const migratedFile = path.join(secondScopedDir, 'session-' + sessionId + '.json');
      expect(fs.existsSync(migratedFile)).toBe(false);
    } finally {
      if (previousSessionDir === undefined) {
        process.env.ROUTECODEX_SESSION_DIR = SESSION_DIR;
      } else {
        process.env.ROUTECODEX_SESSION_DIR = previousSessionDir;
      }
      fs.rmSync(path.join(SESSION_DIR, 'scoped-restart-recovery'), { recursive: true, force: true });
    }
  });


  test('clears stopMessage with a monotonic updatedAt timestamp', () => {
    const engine = buildEngine();
    const sessionId = 'sess-clear-1';
    const setRequest: StandardizedRequest = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: '<**stopMessage:"继续",1**>\\nhello' }],
      tools: [],
      parameters: {}
    } as any;

    engine.route(setRequest, {
      requestId: 'req_stopmessage_set_clear',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      tmuxSessionId: sessionId,
      routeHint: 'default'
    } as any);

    const before = readSessionState(sessionId);
    expect(before?.state?.stopMessageText).toBe('继续');

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
      tmuxSessionId: sessionId,
      routeHint: 'default'
    } as any);

    expect(fs.existsSync(sessionStatePath(sessionId))).toBe(false);
  });

  test('inline stopMessage:clear marker with trailing text still clears stopMessage', () => {
    const engine = buildEngine();
    const sessionId = 'sess-clear-inline-tail';

    engine.route(
      {
        model: 'gpt-test',
        messages: [{ role: 'user', content: '<**stopMessage:on,10**>继续执行当前任务' }],
        tools: [],
        parameters: {}
      } as any,
      {
        requestId: 'req_stopmessage_set_inline_tail',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        sessionId,
        tmuxSessionId: sessionId,
        routeHint: 'default'
      } as any
    );

    engine.route(
      {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'Search *.ts in src\n<**stopMessage:clear**>中文报告进度和问题' }],
        tools: [],
        parameters: {}
      } as any,
      {
        requestId: 'req_stopmessage_clear_inline_tail',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        sessionId,
        tmuxSessionId: sessionId,
        routeHint: 'default'
      } as any
    );

    expect(fs.existsSync(sessionStatePath(sessionId))).toBe(false);
  });

  test('stopMessage:clear still applies when later user message has no marker (clock-like tail)', () => {
    const engine = buildEngine();
    const sessionId = 'sess-clear-stale-user-tail';

    engine.route(
      {
        model: 'gpt-test',
        messages: [{ role: 'user', content: '<**stopMessage:on,10**>继续执行当前任务' }],
        tools: [],
        parameters: {}
      } as any,
      {
        requestId: 'req_stopmessage_set_before_stale_clear',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        sessionId,
        tmuxSessionId: sessionId,
        routeHint: 'default'
      } as any
    );

    engine.route(
      {
        model: 'gpt-test',
        messages: [
          { role: 'user', content: '<**stopMessage:clear**>中文报告进度和问题' },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: '[Clock Reminder]: scheduled tasks are due.' }
        ],
        tools: [],
        parameters: {}
      } as any,
      {
        requestId: 'req_stopmessage_clear_with_stale_user_tail',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        sessionId,
        tmuxSessionId: sessionId,
        routeHint: 'default'
      } as any
    );

    expect(fs.existsSync(sessionStatePath(sessionId))).toBe(false);
  });

  test('generic <**clear**> clears mode-only stopMessage:on,10 state', () => {
    const engine = buildEngine();
    const sessionId = 'sess-clear-generic-mode-only-1';
    const setRequest: StandardizedRequest = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: '<**stopMessage:on,10**>继续执行当前任务' }],
      tools: [],
      parameters: {}
    } as any;

    engine.route(setRequest, {
      requestId: 'req_stopmessage_set_generic_clear',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      routeHint: 'default'
    } as any);

    const clearRequest: StandardizedRequest = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: '<**clear**>\\n继续执行当前任务' }],
      tools: [],
      parameters: {}
    } as any;

    engine.route(clearRequest, {
      requestId: 'req_stopmessage_generic_clear',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      routeHint: 'default'
    } as any);

    const filepath = path.join(SESSION_DIR, `session-${sessionId}.json`);
    expect(fs.existsSync(filepath)).toBe(false);
  });

  test('activate then <**clear**> does not trigger stop_message followup', async () => {
    const engine = buildEngine();
    const sessionId = 'sess-clear-no-followup-1';
    const metadata = {
      requestId: 'req_stopmessage_set_before_clear',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      routeHint: 'default'
    } as any;

    engine.route(
      {
        model: 'gpt-test',
        messages: [{ role: 'user', content: '<**stopMessage:on,10**>继续执行当前任务' }],
        tools: [],
        parameters: {}
      } as any,
      metadata
    );

    engine.route(
      {
        model: 'gpt-test',
        messages: [{ role: 'user', content: '<**clear**>\\n继续执行' }],
        tools: [],
        parameters: {}
      } as any,
      {
        ...metadata,
        requestId: 'req_stopmessage_clear_before_followup'
      }
    );

    const filepath = path.join(SESSION_DIR, `session-${sessionId}.json`);
    expect(fs.existsSync(filepath)).toBe(false);

    const adapterContext: AdapterContext = {
      requestId: 'req_stopmessage_clear_no_followup',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: '继续执行当前任务' }]
      }
    } as any;

    const stopResponse: JsonObject = {
      id: 'chatcmpl-stop-after-clear-1',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop'
        }
      ]
    };

    const result = await runServerSideToolEngine({
      chatResponse: stopResponse,
      adapterContext,
      requestId: 'req_stopmessage_clear_no_followup',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat'
    });

    expect(result.mode).toBe('passthrough');
    expect(result.execution).toBeUndefined();
  });

  test('does not reapply stopMessage from history after it is cleared/consumed', () => {
    const engine = buildEngine();
    const sessionId = 'sess-no-reapply-1';

    const setRequest: StandardizedRequest = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: '<**stopMessage:"继续",1**>\\nhello' }],
      tools: [],
      parameters: {}
    } as any;
    engine.route(setRequest, {
      requestId: 'req_stopmessage_set_once',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      tmuxSessionId: sessionId,
      routeHint: 'default'
    } as any);

    const clearedAt = Date.now();
    saveRoutingInstructionStateSync(`tmux:${sessionId}`, {
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

    const nextRequest: StandardizedRequest = {
      model: 'gpt-test',
      messages: [
        { role: 'user', content: '<**stopMessage:"继续",1**>\\nhello' },
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
      tmuxSessionId: sessionId,
      routeHint: 'default'
    } as any);

    const persisted = readSessionState(sessionId);
    expect(persisted?.state?.stopMessageText).toBeUndefined();
    expect(persisted?.state?.stopMessageMaxRepeats).toBeUndefined();
  });

  test('does not reapply stale stopMessage when latest message is non-user', () => {
    const engine = buildEngine();
    const sessionId = 'sess-no-reapply-non-user-tail';

    engine.route(
      {
        model: 'gpt-test',
        messages: [{ role: 'user', content: '<**stopMessage:"继续",1**>\\nhello' }],
        tools: [],
        parameters: {}
      } as any,
      {
        requestId: 'req_stopmessage_set_non_user_tail',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        sessionId,
        tmuxSessionId: sessionId,
        routeHint: 'default'
      } as any
    );

    const clearedAt = Date.now();
    saveRoutingInstructionStateSync(`tmux:${sessionId}`, {
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

    engine.route(
      {
        model: 'gpt-test',
        messages: [
          { role: 'user', content: '<**stopMessage:"继续",1**>\\nhello' },
          { role: 'assistant', content: 'tool output only' }
        ],
        tools: [],
        parameters: {}
      } as any,
      {
        requestId: 'req_stopmessage_following_non_user_tail',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        sessionId,
        tmuxSessionId: sessionId,
        routeHint: 'default'
      } as any
    );

    const persisted = readSessionState(sessionId);
    expect(persisted?.state?.stopMessageText).toBeUndefined();
    expect(persisted?.state?.stopMessageMaxRepeats).toBeUndefined();
  });

  test('ignores stopMessage/precommand instructions on servertool followup hops', () => {
    const engine = buildEngine();
    const sessionId = 'sess-servertool-followup-ignore';
    const metadata = {
      requestId: 'req_servertool_followup_ignore',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      routeHint: 'default',
      __rt: { serverToolFollowup: true }
    } as any;

    engine.route(
      {
        model: 'gpt-test',
        messages: [{ role: 'user', content: '<**stopMessage:on,10**><**precommand:on**>继续' }],
        tools: [],
        parameters: {}
      } as any,
      metadata
    );

    const snapshot = engine.getStopMessageState(metadata);
    expect(snapshot).toBeNull();
  });

  test('re-arms stopMessage when set again with the same text/max after being exhausted', () => {
    const engine = buildEngine();
    const sessionId = 'sess-rearm-same-1';

    const setRequest: StandardizedRequest = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: '<**stopMessage:"继续",1**>\\nhello' }],
      tools: [],
      parameters: {}
    } as any;
    engine.route(setRequest, {
      requestId: 'req_stopmessage_rearm_set_1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      tmuxSessionId: sessionId,
      routeHint: 'default'
    } as any);

    const before = readSessionState(sessionId);
    expect(before?.state?.stopMessageText).toBe('继续');
    expect(before?.state?.stopMessageMaxRepeats).toBe(1);
    expect(before?.state?.stopMessageUsed).toBe(0);
    const beforeUpdatedAt = before?.state?.stopMessageUpdatedAt;
    expect(typeof beforeUpdatedAt === 'number').toBe(true);

    const exhaustedAt = Date.now();
    saveRoutingInstructionStateSync(`tmux:${sessionId}`, {
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
      messages: [{ role: 'user', content: '<**stopMessage:"继续",1**>\\nhello again' }],
      tools: [],
      parameters: {}
    } as any;
    engine.route(setAgainRequest, {
      requestId: 'req_stopmessage_rearm_set_2',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      tmuxSessionId: sessionId,
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

  test('explicit stopMessage set overrides previous runtime markers and clears counters/history', () => {
    const engine = buildEngine();
    const sessionId = 'sess-stopmessage-explicit-override-runtime';
    const now = Date.now();

    saveRoutingInstructionStateSync(`tmux:${sessionId}`, {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '旧目标',
      stopMessageMaxRepeats: 5,
      stopMessageUsed: 0,
      stopMessageUpdatedAt: now - 10_000,
      stopMessageLastUsedAt: undefined,
      stopMessageStageMode: 'on',
      stopMessageAiMode: 'on',
      stopMessageSource: 'explicit_text',
      stopMessageAiSeedPrompt: '旧 followup 种子',
      stopMessageAiHistory: [{ round: 1, followupText: '旧 followup' }]
    } as any);

    const request: StandardizedRequest = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: '<**stopMessage:"新目标",3,ai:on**>继续' }],
      tools: [],
      parameters: {}
    } as any;

    engine.route(request, {
      requestId: 'req_stopmessage_explicit_override_runtime',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      tmuxSessionId: sessionId,
      routeHint: 'default'
    } as any);

    const persisted = readSessionState(sessionId);
    expect(persisted?.state?.stopMessageText).toBe('新目标');
    expect(persisted?.state?.stopMessageMaxRepeats).toBe(3);
    expect(persisted?.state?.stopMessageUsed).toBe(0);
    expect(persisted?.state?.stopMessageStageMode).toBe('on');
    expect(persisted?.state?.stopMessageAiMode).toBe('on');
    expect(persisted?.state?.stopMessageLastUsedAt).toBeUndefined();
    expect(persisted?.state?.stopMessageAiSeedPrompt).toBeUndefined();
    expect(persisted?.state?.stopMessageAiHistory).toBeUndefined();
  });
});
