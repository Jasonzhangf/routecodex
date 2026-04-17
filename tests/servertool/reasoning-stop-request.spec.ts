import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { StandardizedRequest } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/standardized.js';
import { prepareReasoningStopRequestTooling } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-chat-process-request-utils.js';
import {
  loadRoutingInstructionStateSync,
  saveRoutingInstructionStateSync
} from '../../sharedmodule/llmswitch-core/src/router/virtual-router/sticky-session-store.js';
import type { RoutingInstructionState } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/routing-instructions.js';

const SESSION_DIR = path.join(process.cwd(), 'tmp', 'jest-reasoning-stop-request-sessions');

function createEmptyRoutingInstructionState(): RoutingInstructionState {
  return {
    forcedTarget: undefined,
    stickyTarget: undefined,
    preferTarget: undefined,
    allowedProviders: new Set<string>(),
    disabledProviders: new Set<string>(),
    disabledKeys: new Map<string, Set<string | number>>(),
    disabledModels: new Map<string, Set<string>>(),
    stopMessageSource: undefined,
    stopMessageText: undefined,
    stopMessageMaxRepeats: undefined,
    stopMessageUsed: undefined,
    stopMessageUpdatedAt: undefined,
    stopMessageLastUsedAt: undefined,
    stopMessageStageMode: undefined,
    stopMessageAiMode: undefined,
    stopMessageAiSeedPrompt: undefined,
    stopMessageAiHistory: undefined,
    reasoningStopMode: undefined,
    reasoningStopArmed: undefined,
    reasoningStopSummary: undefined,
    reasoningStopUpdatedAt: undefined,
    preCommandSource: undefined,
    preCommandScriptPath: undefined,
    preCommandUpdatedAt: undefined
  };
}

function setStoplessMode(sessionId: string, mode: 'on' | 'off' | 'endless'): void {
  const stickyKey = `session:${sessionId}`;
  const existing = loadRoutingInstructionStateSync(stickyKey);
  const next = existing ?? createEmptyRoutingInstructionState();
  next.reasoningStopMode = mode;
  saveRoutingInstructionStateSync(stickyKey, next);
}

function buildRequest(content = '继续执行'): StandardizedRequest {
  return {
    model: 'gpt-test',
    messages: [{ role: 'user', content }],
    tools: [],
    parameters: {},
    metadata: { originalEndpoint: '/v1/chat/completions' }
  };
}

describe('reasoning stop request tooling', () => {
  beforeAll(() => {
    process.env.ROUTECODEX_SESSION_DIR = SESSION_DIR;
  });

  beforeEach(() => {
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  });

  test('injects reasoning.stop when persisted stopless mode is on', () => {
    const sessionId = 'reasoning-stop-request-on';
    setStoplessMode(sessionId, 'on');
    const request = buildRequest();
    const adapterContext = { sessionId } as unknown as AdapterContext;

    const mode = prepareReasoningStopRequestTooling({ request, adapterContext });

    expect(mode).toBe('on');
    expect(request.tools?.some((tool) => tool.function.name === 'reasoning.stop')).toBe(true);
    const captured = (adapterContext as any).capturedChatRequest;
    expect(captured?.tools?.some((tool: any) => tool?.function?.name === 'reasoning.stop')).toBe(true);
    const reasoningStopTool = request.tools?.find((tool) => tool.function.name === 'reasoning.stop');
    const properties = reasoningStopTool?.function.parameters?.properties as Record<string, unknown> | undefined;
    expect(properties?.stop_reason).toBeDefined();
    expect(properties?.user_input_required).toBeDefined();
    expect(properties?.user_question).toBeDefined();
    expect(properties?.learning).toBeDefined();
  });

  test('parses directive, strips marker, persists mode, and injects reasoning.stop', () => {
    const sessionId = 'reasoning-stop-request-directive';
    const request = buildRequest('开启 stopless <**stopless:on**>');
    const adapterContext = { sessionId } as unknown as AdapterContext;

    const mode = prepareReasoningStopRequestTooling({ request, adapterContext });

    expect(mode).toBe('on');
    expect(typeof request.messages[0]?.content === 'string' ? request.messages[0].content : '').toBe('开启 stopless');
    expect(loadRoutingInstructionStateSync(`session:${sessionId}`)?.reasoningStopMode).toBe('on');
    expect(request.tools?.some((tool) => tool.function.name === 'reasoning.stop')).toBe(true);
  });

  test('does not inject reasoning.stop when mode is off', () => {
    const sessionId = 'reasoning-stop-request-off';
    setStoplessMode(sessionId, 'off');
    const request = buildRequest();
    const adapterContext = { sessionId } as unknown as AdapterContext;

    const mode = prepareReasoningStopRequestTooling({ request, adapterContext });

    expect(mode).toBe('off');
    expect(request.tools?.some((tool) => tool.function.name === 'reasoning.stop')).toBe(false);
  });

  test('backfills adapterContext sessionId from request metadata before syncing stopless mode', () => {
    const request = buildRequest('开启 stopless <**stopless:on**>');
    request.metadata = {
      ...request.metadata,
      sessionId: 'reasoning-stop-request-metadata-session'
    };
    const adapterContext = {} as unknown as AdapterContext;

    const mode = prepareReasoningStopRequestTooling({ request, adapterContext });

    expect(mode).toBe('on');
    expect((adapterContext as any).sessionId).toBe('reasoning-stop-request-metadata-session');
    expect(
      loadRoutingInstructionStateSync('session:reasoning-stop-request-metadata-session')?.reasoningStopMode
    ).toBe('on');
  });
});
