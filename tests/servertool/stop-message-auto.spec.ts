import * as fs from 'node:fs';
import * as path from 'node:path';
import { jest } from '@jest/globals';
import { runServerSideToolEngine as runServerSideToolEngineRaw } from '../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js';
import { runServerToolOrchestration as runServerToolOrchestrationRaw } from '../../sharedmodule/llmswitch-core/src/servertool/engine.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';
import {
  serializeRoutingInstructionState,
  type RoutingInstructionState
} from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-routing-state.js';
import { buildResponsesRequestFromChat } from '../../sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.js';
import {
  extractBlockedReportFromMessagesForTests,
  __setDecideOverrideForTests,
  type StopMessageDecisionContext,
  type StopMessageDecision
} from '../../sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.js';
import { resolveStateKey } from '../../sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/runtime-utils.js';
import { resolveRuntimeStopMessageState } from '../../sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/runtime-utils.js';
import { resetStopMessageRuntimeConfigCacheForTests } from '../../sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/config.js';

const SESSION_DIR = path.join(process.cwd(), 'tmp', 'jest-stopmessage-sessions');
const USER_DIR = path.join(process.cwd(), 'tmp', 'jest-stopmessage-userdir');
const EXECUTION_APPEND_TEXT = '请直接继续执行，不要进行状态汇总';
const ORIGINAL_STOPMESSAGE_DEFAULT_ENABLED = process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_ENABLED;
const ORIGINAL_REASONING_STOP_GUARD_ENABLED = process.env.ROUTECODEX_REASONING_STOP_GUARD_ENABLED;
const ORIGINAL_STOPMESSAGE_CONFIG_PATH = process.env.ROUTECODEX_STOPMESSAGE_CONFIG_PATH;
const STOPMESSAGE_CONFIG_PATH = path.join(SESSION_DIR, 'stop-message.json');

function terminalStopSchema(args: {
  stopreason?: 0 | 1;
  reason?: string;
  evidence?: string;
  doneSteps?: string;
  issueCause?: string;
  excludedFactors?: string;
  diagnosticOrder?: string;
  nextStep?: string;
  nextSuggestedPath?: string;
  learned?: string;
} = {}): string {
  return JSON.stringify({
    stopreason: args.stopreason ?? 0,
    reason: args.reason ?? '完成',
    has_evidence: 1,
    evidence: args.evidence ?? '日志通过',
    issue_cause: args.issueCause ?? '目标已验证',
    excluded_factors: args.excludedFactors ?? '无关路径已排除',
    diagnostic_order: args.diagnosticOrder ?? '日志 -> 测试 -> 结果',
    done_steps: args.doneSteps ?? '完成验证',
    next_step: args.nextStep ?? '',
    next_suggested_path: args.nextSuggestedPath ?? '',
    learned: args.learned ?? ''
  });
}

function writeRoutingStateForSession(sessionId: string, state: RoutingInstructionState): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const filename = `tmux-${sessionId}.json`;
  const filepath = path.join(SESSION_DIR, filename);
  const payload = {
    version: 1,
    state: serializeRoutingInstructionState(state)
  };
  fs.writeFileSync(filepath, JSON.stringify(payload), { encoding: 'utf8' });
}

function resolveStopStatePath(sessionId: string): string {
  const tmuxPath = path.join(SESSION_DIR, `tmux-${sessionId}.json`);
  if (fs.existsSync(tmuxPath)) {
    return tmuxPath;
  }
  return path.join(SESSION_DIR, `session-${sessionId}.json`);
}

function clearStopStateForSession(sessionId: string): void {
  fs.rmSync(path.join(SESSION_DIR, `tmux-${sessionId}.json`), { force: true });
  fs.rmSync(path.join(SESSION_DIR, `session-${sessionId}.json`), { force: true });
}

function withTmuxAdapterContext<T>(adapterContext: T): T {
  if (!adapterContext || typeof adapterContext !== 'object') {
    return adapterContext;
  }
  const record = adapterContext as Record<string, unknown>;
  const metadata =
    record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
      ? { ...(record.metadata as Record<string, unknown>) }
      : {};
  const tmuxSessionId =
    (typeof record.tmuxSessionId === 'string' && record.tmuxSessionId.trim()) ||
    (typeof record.clientTmuxSessionId === 'string' && record.clientTmuxSessionId.trim()) ||
    (typeof metadata.tmuxSessionId === 'string' && String(metadata.tmuxSessionId).trim()) ||
    (typeof metadata.clientTmuxSessionId === 'string' && String(metadata.clientTmuxSessionId).trim()) ||
    (typeof metadata.client_tmux_session_id === 'string' && String(metadata.client_tmux_session_id).trim()) ||
    '';
  if (!tmuxSessionId) {
    return adapterContext;
  }
  metadata.tmuxSessionId = tmuxSessionId;
  metadata.clientTmuxSessionId = tmuxSessionId;
  metadata.client_tmux_session_id = tmuxSessionId;

  return {
    ...(record as Record<string, unknown>),
    tmuxSessionId,
    clientTmuxSessionId: tmuxSessionId,
    metadata
  } as T;
}

async function runServerSideToolEngine(
  args: Parameters<typeof runServerSideToolEngineRaw>[0]
): ReturnType<typeof runServerSideToolEngineRaw> {
  const nextArgs = {
    ...args,
    adapterContext: withTmuxAdapterContext(args.adapterContext)
  } as Parameters<typeof runServerSideToolEngineRaw>[0];
  return runServerSideToolEngineRaw(nextArgs);
}

async function runServerToolOrchestration(
  args: Parameters<typeof runServerToolOrchestrationRaw>[0]
): ReturnType<typeof runServerToolOrchestrationRaw> {
  const nextArgs = {
    ...args,
    adapterContext: withTmuxAdapterContext(args.adapterContext)
  } as Parameters<typeof runServerToolOrchestrationRaw>[0];
  return runServerToolOrchestrationRaw(nextArgs);
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

async function readJsonFileWithRetry<T>(filepath: string, attempts = 50, delayMs = 10): Promise<T> {
  return readJsonFileUntil<T>(filepath, () => true, attempts, delayMs);
}

function readClientInjectMeta(followup: any): { clientInjectOnly: boolean; clientInjectText: string } {
  const metadata = followup?.metadata && typeof followup.metadata === 'object' ? followup.metadata : {};
  const rawOnly = (metadata as Record<string, unknown>).clientInjectOnly;
  const clientInjectOnly =
    rawOnly === true || (typeof rawOnly === 'string' && rawOnly.trim().toLowerCase() === 'true');
  const metadataText = typeof (metadata as Record<string, unknown>).clientInjectText === 'string'
    ? String((metadata as Record<string, unknown>).clientInjectText)
    : '';
  const injection = followup?.injection && typeof followup.injection === 'object' ? followup.injection : {};
  const ops = Array.isArray((injection as Record<string, unknown>).ops) ? (injection as Record<string, unknown>).ops as unknown[] : [];
  const injectedText = ops.map((op) => {
    const record = op && typeof op === 'object' && !Array.isArray(op) ? op as Record<string, unknown> : {};
    return record.op === 'append_user_text' && typeof record.text === 'string' ? record.text : '';
  }).filter(Boolean).join('\n');
  const clientInjectText = metadataText || injectedText;
  return { clientInjectOnly, clientInjectText };
}

function readStopMessageCliProjection(result: any, expectedReasoning?: string): { cmd: string; message: any } {
  expect(result.executed).toBe(true);
  expect(result.flowId).toBe('stop_message_flow');
  const projectedChoice = (result.chat?.choices as any[] | undefined)?.[0];
  expect(projectedChoice?.finish_reason).toBe('tool_calls');
  const projectedMessage = projectedChoice?.message as any;
  if (expectedReasoning !== undefined) {
    expect(projectedMessage.reasoning_content).toBe(expectedReasoning);
  }
  const toolCall = projectedMessage?.tool_calls?.[0];
  expect(toolCall?.function?.name).toBe('exec_command');
  const toolArgs = JSON.parse(String(toolCall?.function?.arguments ?? '{}')) as { cmd?: string };
  const cmd = String(toolArgs.cmd ?? '');
  expect(cmd).toContain('routecodex servertool run stop_message_auto');
  expect(cmd).toContain('"continuationPrompt"');
  return { cmd, message: projectedMessage };
}

function buildStopChatResponse(id = 'chatcmpl-stopmessage-double-dispatch'): JsonObject {
  return {
    id,
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
  } as JsonObject;
}

// Inline TS decision fallback for tests (native binding not available).
// Mirrors the Rust stop-message-core::decide() logic for common test scenarios.
function testStopMessageDecision(ctx: Record<string, unknown>): Record<string, unknown> {
  const defaultPrompt = (used: number): string => {
    const prompts = [
      '第一轮核对：只确认当前用户目标、已经完成的步骤、以及是否已有文件/日志/命令输出/测试结果作为证据。证据不足时不要询问用户、不要总结，直接调用工具补证据；若目标已完成或阻塞，给出简洁结论并附 stop schema。',
      '第二轮核对：在目标、已做步骤、证据之外，补齐问题原因、已排除因素、排查顺序。仍有缺口时必须调用工具继续验证；只有完成或确实阻塞时，才给用户结论并附 stop schema。',
      '第三轮最终收尾：不要开启新一轮执行，不要暴露 stopless/校验过程。直接给用户可读 summary，包含已完成事项、未完成事项、阻塞点/问题原因、已排除因素、建议下一步，并在末尾附 stop schema。'
    ];
    return prompts[Math.min(Math.max(used, 0), prompts.length - 1)];
  };

  // Port disabled?
  if (ctx.port_stop_message_disabled) {
    return { action: 'skip', skip_reason: 'skip_port_stopmessage_disabled' };
  }

  if (ctx.plan_mode_active) {
    return { action: 'skip', skip_reason: 'skip_plan_mode' };
  }

  const goalStatus = String(ctx.goal_status ?? 'idle').toLowerCase();
  const goalActive = goalStatus === 'active';
  if (goalActive) {
    return { action: 'skip', skip_reason: 'skip_goal_active' };
  }

  const followupFlowId = typeof ctx.followup_flow_id === 'string' ? ctx.followup_flow_id.trim() : '';
  if (followupFlowId && followupFlowId !== 'stop_message_flow') {
    return { action: 'skip', skip_reason: 'skip_servertool_followup_hop' };
  }

  if (String(ctx.explicit_mode ?? '').trim().toLowerCase() === 'off') {
    return { action: 'skip', skip_reason: 'skip_stopmessage_mode_off' };
  }

  // Resolve snapshot.
  const rawSnap = (ctx.persisted_snapshot ?? ctx.runtime_snapshot) as Record<string, unknown> | undefined;
  let snap = rawSnap;

  // Explicit mode without snapshot?
  if (!snap && ctx.explicit_mode === 'on') {
    return { action: 'skip', skip_reason: 'skip_explicit_mode_without_snapshot' };
  }

  if (!snap && ctx.persisted_default_exhausted) {
    return { action: 'skip', skip_reason: 'skip_goal_default_exhausted' };
  }

  // No snapshot → try default.
  if (!snap) {
    if (!goalActive && ctx.default_enabled) {
      const defaultUsed = 0;
      snap = {
        text: defaultPrompt(defaultUsed),
        max_repeats: typeof ctx.default_max_repeats === 'number' ? ctx.default_max_repeats : 3,
        used: defaultUsed,
        source: 'default',
        stage_mode: 'on'
      };
    } else {
      return { action: 'skip', skip_reason: 'skip_no_stopmessage_snapshot' };
    }
  }

  // Snapshot fields
  const text = String(snap.text ?? '').trim();
  const mode = String(snap.stage_mode ?? 'on').toLowerCase();
  const maxRepeats = typeof snap.max_repeats === 'number' ? Math.max(0, Math.floor(snap.max_repeats)) : 0;
  const used = typeof snap.used === 'number' ? Math.max(0, Math.floor(snap.used)) : 0;

  // Mode off?
  if (mode === 'off') {
    return { action: 'skip', skip_reason: 'skip_stopmessage_mode_off' };
  }

  // Empty text?
  if (!text) {
    return { action: 'skip', skip_reason: 'skip_stopmessage_empty_text' };
  }

  // Invalid repeats?
  if (maxRepeats <= 0) {
    return { action: 'skip', skip_reason: 'skip_stopmessage_invalid_repeats' };
  }

  // Not stop eligible?
  if (!ctx.stop_eligible) {
    return { action: 'skip', skip_reason: 'skip_not_stop_finish_reason' };
  }

  // Reached max repeats?
  if (used >= maxRepeats) {
    return { action: 'skip', skip_reason: 'skip_reached_max_repeats' };
  }

  // ── Trigger ──
  return {
    action: 'trigger',
    used,
    max_repeats: maxRepeats,
    followup_text: snap.source === 'default' || text === '继续执行' ? defaultPrompt(used) : text,
  };
}

describe('stop_message_auto servertool', () => {
  beforeAll(() => {
    __setDecideOverrideForTests(testStopMessageDecision as any);
    process.env.ROUTECODEX_SESSION_DIR = SESSION_DIR;
    process.env.ROUTECODEX_USER_DIR = USER_DIR;
    process.env.ROUTECODEX_STOPMESSAGE_CONFIG_PATH = STOPMESSAGE_CONFIG_PATH;
    process.env.ROUTECODEX_STOPMESSAGE_STAGE_MODE = 'auto';
    fs.mkdirSync(USER_DIR, { recursive: true });
    process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_ENABLED = '0';
    process.env.ROUTECODEX_REASONING_STOP_GUARD_ENABLED = '0';
  });

  afterAll(() => {
    __setDecideOverrideForTests(null);
    resetStopMessageRuntimeConfigCacheForTests();
    if (ORIGINAL_STOPMESSAGE_DEFAULT_ENABLED === undefined) {
      delete process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_ENABLED;
    } else {
      process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_ENABLED = ORIGINAL_STOPMESSAGE_DEFAULT_ENABLED;
    }
    if (ORIGINAL_STOPMESSAGE_CONFIG_PATH === undefined) {
      delete process.env.ROUTECODEX_STOPMESSAGE_CONFIG_PATH;
    } else {
      process.env.ROUTECODEX_STOPMESSAGE_CONFIG_PATH = ORIGINAL_STOPMESSAGE_CONFIG_PATH;
    }
    if (ORIGINAL_REASONING_STOP_GUARD_ENABLED === undefined) {
      delete process.env.ROUTECODEX_REASONING_STOP_GUARD_ENABLED;
    } else {
      process.env.ROUTECODEX_REASONING_STOP_GUARD_ENABLED = ORIGINAL_REASONING_STOP_GUARD_ENABLED;
    }
  });

  test('triggers default stopMessage when default is enabled without scoped stop state', async () => {
    process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_ENABLED = '1';
    resetStopMessageRuntimeConfigCacheForTests();

    const sessionId = 'stopmessage-red-default-no-followup';
    clearStopStateForSession(sessionId);
    // No persisted stopMessage state — no writeRoutingStateForSession

    const capturedChatRequest: JsonObject = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }]
    };

    const chatResponse: JsonObject = {
      id: 'chatcmpl-red-default-stop',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'ok' },
        finish_reason: 'stop'
      }]
    };

    const adapterContext: AdapterContext = {
      requestId: 'req-red-default-stop',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      capturedChatRequest
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-red-default-stop',
      providerProtocol: 'openai-chat'
    });

    expect(result.execution?.flowId).toBe('stop_message_flow');

    process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_ENABLED = '0';
    resetStopMessageRuntimeConfigCacheForTests();
  });

  test('triggers when scoped snapshot source=default outside plan and without active goal', async () => {
    const sessionId = 'stopmessage-red-default-scoped-snapshot';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
        allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续执行',
      stopMessageMaxRepeats: 3,
      stopMessageUsed: 2,
      stopMessageSource: 'default',
      stopMessageStageMode: 'on'
    } as RoutingInstructionState;
    writeRoutingStateForSession(sessionId, state);

    const chatResponse: JsonObject = {
      id: 'chatcmpl-red-default-scoped-state',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'ok' },
        finish_reason: 'stop'
      }]
    };

    const adapterContext: AdapterContext = {
      requestId: 'req-red-default-scoped-state',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      tmuxSessionId: sessionId,
      clientTmuxSessionId: sessionId,
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hi' }]
      }
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-red-default-scoped-state',
      providerProtocol: 'openai-chat'
    });

    expect(result.execution?.flowId).toBe('stop_message_flow');
  });

  test('schedules followup when stopMessage is active and finish_reason=stop', async () => {
    const sessionId = 'stopmessage-spec-session-1';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
        allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '立即执行待处理任务',
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
    // Engine preview still exposes the internal injection plan; final orchestration projects it to CLI.
    expect(followup.requestIdSuffix).toBe(':stop_followup');
    expect(followup.metadata).toBeDefined();
    expect(followup.entryEndpoint).toBeUndefined();
    expect(followup.injection).toBeDefined();
    expect(followup.metadata?.clientInjectOnly).toBeUndefined();
    expect(followup.metadata?.clientInjectText).toBeUndefined();
    expect(followup.metadata?.clientInjectSource).toBe('servertool.stop_message');
    const injectMeta = readClientInjectMeta(followup);
    expect(injectMeta.clientInjectOnly).toBe(false);
    expect(injectMeta.clientInjectText).toContain('第一轮核对');
    expect(injectMeta.clientInjectText).toContain('当前用户目标');
    expect(injectMeta.clientInjectText).toContain('JSON 对象');

    const persisted = await readJsonFileUntil<{ state?: { stopMessageUsed?: number; stopMessageLastUsedAt?: number } }>(
      resolveStopStatePath(sessionId),
      (data) => data?.state?.stopMessageUsed === 1 && typeof data?.state?.stopMessageLastUsedAt === 'number'
    );
    // llmswitch-core main: stopMessage usage counter increments as soon as we decide to trigger followup.
    expect(persisted?.state?.stopMessageUsed).toBe(1);
    expect(typeof persisted?.state?.stopMessageLastUsedAt).toBe('number');
  });

  test('stop followup pins exact routed provider/model instead of alias metadata fields', async () => {
    const sessionId = 'stopmessage-spec-session-exact-provider-pin';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
        allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续执行',
      stopMessageMaxRepeats: 2,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const capturedChatRequest: JsonObject = {
      model: 'MiniMax-M2.7',
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'hi' }]
        }
      ]
    };

    const chatResponse: JsonObject = {
      id: 'resp-stop-pin-1',
      object: 'response',
      model: 'MiniMax-M2.7',
      output: [
        {
          role: 'assistant',
          content: [{ type: 'output_text', text: 'ok' }]
        }
      ],
      finish_reason: 'stop'
    };

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-pin-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      sessionId,
      capturedChatRequest,
      providerKey: 'mini27.key1.minimax',
      targetProviderKey: 'mini27.key1.minimax',
      modelId: 'minimax',
      assignedModelId: 'minimax',
      target: {
        providerKey: 'mini27.key1.MiniMax-M2.7',
        modelId: 'MiniMax-M2.7'
      },
      metadata: {
        providerKey: 'mini27.key1.minimax',
        targetProviderKey: 'mini27.key1.minimax',
        assignedModelId: 'minimax',
        target: {
          providerKey: 'mini27.key1.MiniMax-M2.7',
          modelId: 'MiniMax-M2.7'
        }
      },
      __rt: {
        __shadowCompareForcedProviderKey: 'mini27.key1.MiniMax-M2.7',
        targetProviderKey: 'mini27.key1.MiniMax-M2.7',
        assignedModelId: 'MiniMax-M2.7',
        target: {
          providerKey: 'mini27.key1.MiniMax-M2.7',
          modelId: 'MiniMax-M2.7'
        }
      }
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-stopmessage-pin-1',
      providerProtocol: 'openai-responses'
    });

    expect(result.mode).toBe('tool_flow');
    const followup = result.execution?.followup as any;
    expect(followup?.metadata?.__shadowCompareForcedProviderKey).toBeUndefined();
    expect(followup?.metadata?.providerKey).toBeUndefined();
    expect(followup?.metadata?.targetProviderKey).toBeUndefined();
    expect(followup?.metadata?.modelId).toBe('MiniMax-M2.7');
    expect(followup?.metadata?.assignedModelId).toBe('MiniMax-M2.7');
    expect(followup?.metadata?.target?.providerKey).toBeUndefined();
    expect(followup?.metadata?.target?.modelId).toBe('MiniMax-M2.7');
  });

  test('servertool orchestration projects stopless to CLI and never reenters or client-injects', async () => {
    const sessionId = 'stopmessage-spec-session-reenter-only';
    writeRoutingStateForSession(sessionId, {
      forcedTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续执行',
      stopMessageMaxRepeats: 2,
      stopMessageUsed: 0
    });

    const clientInjectDispatch = jest.fn(async () => ({ ok: true }));
    const reenterPipeline = jest.fn(async (input: any) => ({
      body: {
        id: `${input.requestId}:done`,
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'continued' }, finish_reason: 'stop' }]
      }
    }));

    const result = await runServerToolOrchestration({
      chat: buildStopChatResponse('chatcmpl-stop-reenter-only'),
      adapterContext: {
        requestId: 'req-stopmessage-reenter-only',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        sessionId,
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'hi' }]
        }
      } as any,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-stopmessage-reenter-only',
      providerProtocol: 'openai-chat',
      clientInjectDispatch,
      reenterPipeline
    });

    expect(clientInjectDispatch).not.toHaveBeenCalled();
    expect(reenterPipeline).not.toHaveBeenCalled();
    const { cmd } = readStopMessageCliProjection(result, 'ok');
    expect(cmd).toContain('"repeatCount":1');
    expect(cmd).toContain('"maxRepeats":3');
    expect(cmd).toContain('第一轮核对');
  });

  test('missing stop schema followup increments schema rejection budget', async () => {
    const sessionId = 'stopmessage-spec-session-missing-schema-budget';
    writeRoutingStateForSession(sessionId, {
      forcedTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续执行',
      stopMessageMaxRepeats: 3,
      stopMessageUsed: 0
    });

    const reenterPipeline = jest.fn(async () => {
      throw new Error('stop_message_auto CLI projection must not reenter pipeline');
    });
    const result = await runServerToolOrchestration({
      chat: buildStopChatResponse('chatcmpl-stop-missing-schema-budget'),
      adapterContext: {
        requestId: 'req-stopmessage-missing-schema-budget',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        sessionId,
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'debug this' }]
        }
      } as any,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-stopmessage-missing-schema-budget',
      providerProtocol: 'openai-chat',
      reenterPipeline
    });

    expect(result.executed).toBe(true);
    expect(result.flowId).toBe('stop_message_flow');
    expect(reenterPipeline).not.toHaveBeenCalled();
    const projectedChoice = (result.chat.choices as any[])[0];
    expect(projectedChoice.finish_reason).toBe('tool_calls');
    const projectedMessage = projectedChoice.message as any;
    expect(projectedMessage.reasoning_content).toBe('ok');
    const toolCall = projectedMessage.tool_calls?.[0];
    expect(toolCall?.function?.name).toBe('exec_command');
    const toolArgs = JSON.parse(String(toolCall?.function?.arguments ?? '{}')) as { cmd?: string };
    expect(toolArgs.cmd).toContain('routecodex servertool run stop_message_auto');
    expect(toolArgs.cmd).toContain('"repeatCount":1');
    expect(toolArgs.cmd).toContain('"maxRepeats":3');

    const persisted = await readJsonFileUntil<{ state?: { stopMessageMaxRepeats?: number; stopMessageUsed?: number } }>(
      resolveStopStatePath(sessionId),
      (data) => data?.state?.stopMessageMaxRepeats === 3 && data?.state?.stopMessageUsed === 1
    );
    expect(persisted.state?.stopMessageMaxRepeats).toBe(3);
    expect(persisted.state?.stopMessageUsed).toBe(1);
  });

  test('strips stop schema control payload from final visible stop text', async () => {
    const sessionId = 'stopmessage-spec-session-strip-schema-visible';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
        allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续执行',
      stopMessageMaxRepeats: 5,
      stopMessageUsed: 1
    };
    writeRoutingStateForSession(sessionId, state);

    const chatResponse = buildStopChatResponse('chatcmpl-strip-schema-visible');
    ((chatResponse.choices as any[])[0].message as any).content = [
      '停止原因：工具权限被拒，任务阻塞。',
      terminalStopSchema({
        stopreason: 1,
        reason: '工具权限被拒',
        evidence: 'exec_command rejected',
        issueCause: '客户端拒绝工具执行',
        excludedFactors: '非 stop schema 解析问题',
        diagnosticOrder: '工具调用 -> 拒绝日志 -> 阻塞判定',
        doneSteps: '确认工具权限被拒'
      })
    ].join('\n');

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext: {
        requestId: 'req-stopmessage-strip-schema-visible',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        sessionId,
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'debug this' }]
        }
      } as any,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-stopmessage-strip-schema-visible',
      providerProtocol: 'openai-chat'
    });

    expect(result.mode).toBe('tool_flow');
    const content = String(((result.finalChatResponse.choices as any[])[0].message as any).content);
    expect(content).toContain('## 当前结果');
    expect(content).toContain('结论: 工具权限被拒');
    expect(content).toContain('证据: exec_command rejected');
    expect(content).not.toContain('停止原因：工具权限被拒');
    expect(content).not.toContain('<stop_schema>');
    expect(content).not.toContain('"stopreason"');
  });

  test('terminal final visible stop text removes reasoning fields instead of leaking cleaned reasoning', async () => {
    const sessionId = 'stopmessage-spec-session-strip-schema-reasoning-summary';
    writeRoutingStateForSession(sessionId, {
      forcedTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续执行',
      stopMessageMaxRepeats: 5,
      stopMessageUsed: 1
    });

    const chatResponse = buildStopChatResponse('chatcmpl-strip-schema-reasoning-summary');
    const message = ((chatResponse.choices as any[])[0].message as any);
    message.content = [
      '已完成本轮校验。',
      terminalStopSchema()
    ].join('\n');
    message.reasoning_content = [
      '先给用户看这一段。',
      terminalStopSchema()
    ].join('\n');
    message.reasoning = {
      summary: [
        {
          type: 'summary_text',
          text: [
            '阶段总结：输出已经可见。',
            terminalStopSchema()
          ].join('\n')
        }
      ]
    };

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext: {
        requestId: 'req-stopmessage-strip-schema-reasoning-summary',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        sessionId,
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'debug this' }]
        }
      } as any,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-stopmessage-strip-schema-reasoning-summary',
      providerProtocol: 'openai-chat'
    });

    expect(result.mode).toBe('tool_flow');
    const finalMessage = ((result.finalChatResponse.choices as any[])[0].message as any);
    expect(finalMessage.reasoning_content).toBeUndefined();
    expect(finalMessage.reasoning_text).toBeUndefined();
    expect(finalMessage.reasoning).toBeUndefined();
    expect(String(finalMessage.content)).toContain('## 完成内容');
    expect(String(finalMessage.content)).not.toContain('"stopreason"');
  });

  test('terminal allow-stop removes visible reasoning fields from final response shell', async () => {
    const sessionId = 'stopmessage-spec-session-terminal-no-reasoning';
    writeRoutingStateForSession(sessionId, {
      forcedTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续执行',
      stopMessageMaxRepeats: 5,
      stopMessageUsed: 1
    });

    const chatResponse = buildStopChatResponse('chatcmpl-terminal-no-reasoning');
    const message = ((chatResponse.choices as any[])[0].message as any);
    message.content = [
      '已完成在线验证。',
      '{"stopreason":0,"reason":"已完成 allow-stop live 验证","has_evidence":1,"evidence":"5555 live probe","issue_cause":"none","excluded_factors":"none","diagnostic_order":"single round allow stop","done_steps":"allow-stop response","next_step":"","next_suggested_path":"","learned":"summary must be markdown"}'
    ].join('\n');
    message.reasoning_text = '模型内部推理包含 stopreason=0 与 has_evidence=1，不应再对用户可见。';
    message.reasoning_content = '这里仍有 stopreason=0 与 needs_user_input=false。';
    message.reasoning = {
      summary: [
        {
          type: 'summary_text',
          text: '阶段推理：stopreason=0，reason=已完成 allow-stop live 验证。'
        }
      ]
    };

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext: {
        requestId: 'req-stopmessage-terminal-no-reasoning',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-chat',
        sessionId,
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'debug this' }]
        }
      } as any,
      entryEndpoint: '/v1/responses',
      requestId: 'req-stopmessage-terminal-no-reasoning',
      providerProtocol: 'openai-chat'
    });

    expect(result.mode).toBe('tool_flow');
    const finalMessage = ((result.finalChatResponse.choices as any[])[0].message as any);
    expect(finalMessage.content).toContain('## 完成内容');
    expect(finalMessage.reasoning_text).toBeUndefined();
    expect(finalMessage.reasoning_content).toBeUndefined();
    expect(finalMessage.reasoning).toBeUndefined();
    expect(String(finalMessage.content)).not.toContain('stopreason');
    expect(String(finalMessage.content)).not.toContain('needs_user_input');
  });

  test('needs_user_input terminal response only shows the question markdown', async () => {
    const sessionId = 'stopmessage-spec-session-needs-user-input-terminal';
    writeRoutingStateForSession(sessionId, {
      forcedTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续执行',
      stopMessageMaxRepeats: 5,
      stopMessageUsed: 1
    });

    const chatResponse = buildStopChatResponse('chatcmpl-needs-user-input-terminal');
    const message = ((chatResponse.choices as any[])[0].message as any);
    message.content = [
      '正在进行部署前检查。',
      '{"stopreason":2,"reason":"需要确认部署窗口","has_evidence":0,"evidence":"","issue_cause":"","excluded_factors":"","diagnostic_order":"","done_steps":"","next_step":"请确认：你希望今天 23:00 部署，还是明天 10:00 部署？","next_suggested_path":"","needs_user_input":true,"learned":""}'
    ].join('\n');

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext: {
        requestId: 'req-stopmessage-needs-user-input-terminal',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-chat',
        sessionId,
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'debug this' }]
        }
      } as any,
      entryEndpoint: '/v1/responses',
      requestId: 'req-stopmessage-needs-user-input-terminal',
      providerProtocol: 'openai-chat'
    });

    expect(result.mode).toBe('tool_flow');
    const finalMessage = ((result.finalChatResponse.choices as any[])[0].message as any);
    const content = String(finalMessage.content);
    expect(content).toContain('## 需要确认');
    expect(content).toContain('请确认：你希望今天 23:00 部署，还是明天 10:00 部署？');
    expect(content).not.toContain('正在进行部署前检查');
    expect(content).not.toContain('needs_user_input');
    expect(content).not.toContain('stopreason');
  });

  test('allow_stop does not fail when only requestId exists and no persisted scope key is available', async () => {
    const chatResponse = buildStopChatResponse('chatcmpl-allow-stop-requestid-only');
    ((chatResponse.choices as any[])[0].message as any).content = [
      '已完成在线验证。',
      '{"stopreason":0,"reason":"已完成 allow-stop live 验证","has_evidence":1,"evidence":"5555 live probe","issue_cause":"none","excluded_factors":"none","diagnostic_order":"single round allow stop","done_steps":"allow-stop response","next_step":"","next_suggested_path":"","learned":"summary must be markdown"}'
    ].join('\n');

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext: {
        requestId: 'req-stopmessage-allow-stop-requestid-only',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-chat',
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'debug this' }]
        }
      } as any,
      entryEndpoint: '/v1/responses',
      requestId: 'req-stopmessage-allow-stop-requestid-only',
      providerProtocol: 'openai-chat'
    });

    expect(result.mode).toBe('tool_flow');
    const content = String(((result.finalChatResponse.choices as any[])[0].message as any).content);
    expect(content).toContain('## 完成内容');
    expect(content).toContain('已完成 allow-stop live 验证');
    expect(content).not.toContain('"stopreason"');
  });

  test('keeps non-control fenced JSON evidence that mentions stopreason', async () => {
    const sessionId = 'stopmessage-spec-session-keep-stopreason-evidence';
    writeRoutingStateForSession(sessionId, {
      forcedTarget: undefined,
        allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续执行',
      stopMessageMaxRepeats: 3,
      stopMessageUsed: 0
    });

    const chatResponse = buildStopChatResponse('chatcmpl-keep-stopreason-evidence');
    ((chatResponse.choices as any[])[0].message as any).content = [
      '停止原因：已阻塞，下面是上游原始日志。',
      '```json',
      '{"event":"audit","message":"model mentioned stopreason in user-visible evidence"}',
      '```',
      '<stop_schema>',
      terminalStopSchema({
        stopreason: 1,
        reason: '上游工具拒绝',
        evidence: '见上方日志',
        issueCause: '上游拒绝当前工具请求',
        excludedFactors: '非 visible evidence JSON 误解析',
        diagnosticOrder: '证据 JSON -> stop schema -> final projection',
        doneSteps: '确认上游工具拒绝'
      }),
      '</stop_schema>'
    ].join('\n');

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext: {
        requestId: 'req-stopmessage-keep-stopreason-evidence',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        sessionId,
        capturedChatRequest: { model: 'gpt-test', messages: [{ role: 'user', content: 'debug this' }] }
      } as any,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-stopmessage-keep-stopreason-evidence',
      providerProtocol: 'openai-chat'
    });

    expect(result.mode).toBe('tool_flow');
    const content = String(((result.finalChatResponse.choices as any[])[0].message as any).content);
    expect(content).toContain('## 当前结果');
    expect(content).toContain('结论: 上游工具拒绝');
    expect(content).toContain('model mentioned stopreason in user-visible evidence');
    expect(content).not.toContain('停止原因：已阻塞');
    expect(content).not.toContain('<stop_schema>');
    expect(content).not.toContain('"stopreason":1');
  });

  test('does not reset consecutive stop budget when schema gate kind changes', async () => {
    const sessionId = 'stopmessage-spec-schema-kind-no-reset';
    writeRoutingStateForSession(sessionId, {
      forcedTarget: undefined,
        allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续完成当前用户目标。\n\nStop schema 校验未通过：你刚才试图停止，但没有提供 stop schema。',
      stopMessageMaxRepeats: 3,
      stopMessageUsed: 1,
      stopMessageStageMode: 'on'
    });

    const chatResponse = buildStopChatResponse('chatcmpl-schema-kind-reset');
    ((chatResponse.choices as any[])[0].message as any).content = '{"stopreason":2,"reason":"仍需继续","has_evidence":0,"next_step":"运行 targeted tests"}';

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext: {
        requestId: 'req-stopmessage-schema-kind-no-reset',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        sessionId,
        capturedChatRequest: { model: 'gpt-test', messages: [{ role: 'user', content: 'debug this' }] }
      } as any,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-stopmessage-schema-kind-no-reset',
      providerProtocol: 'openai-chat'
    });

    expect(result.mode).toBe('tool_flow');
    const persisted = await readJsonFileUntil<{ state?: { stopMessageMaxRepeats?: number; stopMessageUsed?: number; stopMessageText?: string } }>(
      resolveStopStatePath(sessionId),
      (data) => data?.state?.stopMessageMaxRepeats === 3 && data?.state?.stopMessageUsed === 2
    );
    expect(persisted.state?.stopMessageText).toContain('你已经提供 next_step');
    expect(persisted.state?.stopMessageText).toContain('运行 targeted tests');
  });

  test('stop schema budget exhausted returns clean user summary without leaking internal validation report', async () => {
    const sessionId = 'stopmessage-budget-exhausted-clean-summary';
    writeRoutingStateForSession(sessionId, {
      forcedTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续执行',
      stopMessageMaxRepeats: 3,
      stopMessageUsed: 3,
      stopMessageStageMode: 'on'
    });

    const chatResponse = buildStopChatResponse('chatcmpl-budget-exhausted-clean-summary');
    ((chatResponse.choices as any[])[0].message as any).content = [
      '最终用户摘要：AP-008 创建完成；AP-013 创建完成。',
      '<stop_schema>',
      terminalStopSchema({
        reason: '完成',
        evidence: '任务输出',
        issueCause: '任务已创建',
        excludedFactors: '未发现额外阻塞',
        diagnosticOrder: '创建输出 -> summary',
        doneSteps: 'AP-008 创建完成；AP-013 创建完成'
      }),
      '</stop_schema>'
    ].join('\n');

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext: {
        requestId: 'req-stopmessage-budget-exhausted-clean-summary',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        sessionId,
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [
            { role: 'user', content: 'create AP-008 and AP-013' },
            { role: 'assistant', content: '继续执行。' },
            { role: 'user', content: 'Stop schema 校验未通过：继续完成当前用户目标。' }
          ]
        }
      } as any,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-stopmessage-budget-exhausted-clean-summary',
      providerProtocol: 'openai-chat'
    });

    expect(result.mode).toBe('tool_flow');
    const content = String(((result.finalChatResponse.choices as any[])[0].message as any).content);
    expect(content).toContain('最终用户摘要：AP-008 创建完成；AP-013 创建完成。');
    expect(content).not.toContain('Stopless 校验结果');
    expect(content).not.toContain('校验状态');
    expect(content).not.toContain('最后原始 summary');
    expect(content).not.toContain('第 1 次续杯询问');
    expect(content).not.toContain('<stop_schema>');
    expect(content).not.toContain('"stopreason"');
  });

  test('plan mode active skips stopless trigger at the only decision point', async () => {
    const decisionContexts: StopMessageDecisionContext[] = [];
    __setDecideOverrideForTests((ctx: StopMessageDecisionContext): StopMessageDecision => {
      decisionContexts.push(ctx);
      return testStopMessageDecision(ctx as any) as StopMessageDecision;
    });
    try {
      const result = await runServerSideToolEngine({
        chatResponse: buildStopChatResponse('chatcmpl-stop-plan-mode-skip'),
        adapterContext: {
          requestId: 'req-stopmessage-plan-mode-skip',
          entryEndpoint: '/v1/chat/completions',
          providerProtocol: 'openai-chat',
          sessionId: 'stopmessage-spec-session-plan-mode-skip',
          capturedChatRequest: {
            model: 'gpt-test',
            messages: [
              {
                role: 'system',
                content: '<collaboration_mode># Collaboration Mode: Plan\n\nYou are now in Plan mode.\n</collaboration_mode>'
              },
              { role: 'user', content: 'hi' }
            ]
          }
        } as any,
        entryEndpoint: '/v1/chat/completions',
        requestId: 'req-stopmessage-plan-mode-skip',
        providerProtocol: 'openai-chat'
      });

      expect(result.mode).toBe('passthrough');
      expect(decisionContexts[0]?.plan_mode_active).toBe(true);
    } finally {
      __setDecideOverrideForTests(testStopMessageDecision as any);
    }
  });

  test('responses entrypoint chatprocess payload does not skip default stopless as empty reply', async () => {
    process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_ENABLED = '1';
    resetStopMessageRuntimeConfigCacheForTests();
    clearStopStateForSession('stopmessage-spec-session-responses-entry-chatprocess-standard-origin');
    const decisionContexts: StopMessageDecisionContext[] = [];
    __setDecideOverrideForTests((ctx: StopMessageDecisionContext): StopMessageDecision => {
      decisionContexts.push(ctx);
      return testStopMessageDecision(ctx as any) as StopMessageDecision;
    });
    const reenterPipeline = jest.fn(async (input: any) => ({
      body: {
        id: `${input.requestId}:done`,
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'continued' }, finish_reason: 'stop' }]
      }
    }));
    try {
      const enginePreview = await runServerSideToolEngine({
        chatResponse: buildStopChatResponse('chatcmpl-stop-responses-entry-chatprocess-preview'),
        adapterContext: {
          requestId: 'req-stopmessage-responses-entry-chatprocess',
          entryEndpoint: '/v1/responses',
          providerProtocol: 'anthropic-messages',
          sessionId: 'stopmessage-spec-session-responses-entry-chatprocess-standard-origin',
          __rt: {
            stopMessageEnabled: true,
            routecodexPortStopMessageEnabled: true
          },
          capturedChatRequest: {
            model: 'gpt-test',
            messages: [{ role: 'user', content: '继续执行' }]
          }
        } as any,
        entryEndpoint: '/v1/responses',
        requestId: 'req-stopmessage-responses-entry-chatprocess-preview',
        providerProtocol: 'anthropic-messages'
      });
      expect(enginePreview.mode).toBe('tool_flow');
      expect(enginePreview.execution?.flowId).toBe('stop_message_flow');

      const result = await runServerToolOrchestration({
        chat: buildStopChatResponse('chatcmpl-stop-responses-entry-chatprocess'),
        adapterContext: {
          requestId: 'req-stopmessage-responses-entry-chatprocess',
          entryEndpoint: '/v1/responses',
          providerProtocol: 'anthropic-messages',
          sessionId: 'stopmessage-spec-session-responses-entry-chatprocess-standard-origin',
          __rt: {
            stopMessageEnabled: true,
            routecodexPortStopMessageEnabled: true
          },
          capturedChatRequest: {
            model: 'gpt-test',
            messages: [{ role: 'user', content: '继续执行' }]
          }
        } as any,
        entryEndpoint: '/v1/responses',
        requestId: 'req-stopmessage-responses-entry-chatprocess',
        providerProtocol: 'anthropic-messages',
        reenterPipeline
      });

      expect(result.executed).toBe(true);
      expect(result.flowId).toBe('stop_message_flow');
    } finally {
      __setDecideOverrideForTests(testStopMessageDecision as any);
      process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_ENABLED = '0';
      resetStopMessageRuntimeConfigCacheForTests();
    }
  });

  test('persisted active goal without current goal context does not skip stopless', async () => {
    process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_ENABLED = '1';
    resetStopMessageRuntimeConfigCacheForTests();
    clearStopStateForSession('stopmessage-spec-session-persisted-active-not-current-goal');
    const decisionContexts: StopMessageDecisionContext[] = [];
    __setDecideOverrideForTests((ctx: StopMessageDecisionContext): StopMessageDecision => {
      decisionContexts.push(ctx);
      return testStopMessageDecision(ctx as any) as StopMessageDecision;
    });
    try {
      const result = await runServerToolOrchestration({
        chat: buildStopChatResponse('chatcmpl-stop-persisted-active-not-current-goal'),
        adapterContext: {
          requestId: 'req-stopmessage-persisted-active-not-current-goal',
          entryEndpoint: '/v1/chat/completions',
          providerProtocol: 'openai-chat',
          sessionId: 'stopmessage-spec-session-persisted-active-not-current-goal',
          stoplessGoalState: {
            status: 'active',
            objective: '旧会话目标，不属于当前请求',
            createdAt: 1,
            updatedAt: 2
          },
          __rt: {
            stoplessGoalStateSource: 'persisted'
          },
          capturedChatRequest: {
            model: 'gpt-test',
            messages: [{ role: 'user', content: 'hi' }]
          }
        } as any,
        entryEndpoint: '/v1/chat/completions',
        requestId: 'req-stopmessage-persisted-active-not-current-goal',
        providerProtocol: 'openai-chat',
        reenterPipeline: jest.fn(async (input: any) => ({
          body: {
            id: `${input.requestId}:done`,
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: 'continued' }, finish_reason: 'stop' }]
          }
        }))
      });

      expect(decisionContexts[0]?.goal_status).toBe('idle');
      expect(result.executed).toBe(true);
      expect(result.flowId).toBe('stop_message_flow');
    } finally {
      __setDecideOverrideForTests(testStopMessageDecision as any);
      process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_ENABLED = '0';
      resetStopMessageRuntimeConfigCacheForTests();
    }
  });

  test('completed goal with current goal context does not skip stopless as active', async () => {
    process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_ENABLED = '1';
    resetStopMessageRuntimeConfigCacheForTests();
    clearStopStateForSession('stopmessage-spec-session-completed-goal-current-context');
    const decisionContexts: StopMessageDecisionContext[] = [];
    __setDecideOverrideForTests((ctx: StopMessageDecisionContext): StopMessageDecision => {
      decisionContexts.push(ctx);
      return testStopMessageDecision(ctx as any) as StopMessageDecision;
    });
    try {
      const result = await runServerToolOrchestration({
        chat: buildStopChatResponse('chatcmpl-stop-completed-goal-current-context'),
        adapterContext: {
          requestId: 'req-stopmessage-completed-goal-current-context',
          entryEndpoint: '/v1/responses',
          providerProtocol: 'openai-responses',
          sessionId: 'stopmessage-spec-session-completed-goal-current-context',
          stoplessGoalState: {
            status: 'completed',
            objective: '已完成目标',
            createdAt: 1,
            updatedAt: 2
          },
          __rt: {
            stoplessGoalStateSource: 'request'
          },
          capturedEntryRequest: {
            model: 'gpt-5.5',
            input: [
              {
                role: 'user',
                content: [
                  {
                    type: 'input_text',
                    text: '<codex_internal_context source="goal">\\nContinue working toward the active thread goal.\\n<objective>已完成目标</objective>'
                  }
                ]
              }
            ],
            stream: true
          }
        } as any,
        entryEndpoint: '/v1/responses',
        requestId: 'req-stopmessage-completed-goal-current-context',
        providerProtocol: 'openai-responses',
        reenterPipeline: jest.fn(async (input: any) => ({
          body: {
            id: `${input.requestId}:done`,
            object: 'response',
            status: 'completed',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'continued' }] }]
          }
        }))
      });

      expect(decisionContexts[0]?.goal_status).toBe('completed');
      expect(result.executed).toBe(true);
      expect(result.flowId).toBe('stop_message_flow');
    } finally {
      __setDecideOverrideForTests(testStopMessageDecision as any);
      process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_ENABLED = '0';
      resetStopMessageRuntimeConfigCacheForTests();
    }
  });

  test('historical goal context without current goal turn does not skip stopless', async () => {
    process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_ENABLED = '1';
    resetStopMessageRuntimeConfigCacheForTests();
    clearStopStateForSession('stopmessage-spec-session-historical-goal-not-current');
    const decisionContexts: StopMessageDecisionContext[] = [];
    __setDecideOverrideForTests((ctx: StopMessageDecisionContext): StopMessageDecision => {
      decisionContexts.push(ctx);
      return testStopMessageDecision(ctx as any) as StopMessageDecision;
    });
    try {
      const result = await runServerToolOrchestration({
        chat: buildStopChatResponse('chatcmpl-stop-historical-goal-not-current'),
        adapterContext: {
          requestId: 'req-stopmessage-historical-goal-not-current',
          entryEndpoint: '/v1/chat/completions',
          providerProtocol: 'openai-chat',
          sessionId: 'stopmessage-spec-session-historical-goal-not-current',
          capturedChatRequest: {
            model: 'gpt-test',
            messages: [
              { role: 'user', content: '<goal_context>\nContinue working toward the active thread goal.\n<objective>旧目标</objective>\n</goal_context>' },
              { role: 'assistant', content: '历史回复' },
              { role: 'user', content: '继续执行' }
            ]
          }
        } as any,
        entryEndpoint: '/v1/chat/completions',
        requestId: 'req-stopmessage-historical-goal-not-current',
        providerProtocol: 'openai-chat',
        reenterPipeline: jest.fn(async (input: any) => ({
          body: {
            id: `${input.requestId}:done`,
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: 'continued' }, finish_reason: 'stop' }]
          }
        }))
      });

      expect(decisionContexts[0]?.goal_status).toBe('idle');
      expect(result.executed).toBe(true);
      expect(result.flowId).toBe('stop_message_flow');
    } finally {
      __setDecideOverrideForTests(testStopMessageDecision as any);
      process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_ENABLED = '0';
      resetStopMessageRuntimeConfigCacheForTests();
    }
  });

  test('raw responses request body projects stopless to CLI without rebuilding followup payload', async () => {
    const decisionContexts: StopMessageDecisionContext[] = [];
    const reenterPipeline = jest.fn(async (input: any) => ({
      body: {
        id: `${input.requestId}:done`,
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'continued' }, finish_reason: 'stop' }]
      }
    }));
    __setDecideOverrideForTests((ctx: StopMessageDecisionContext): StopMessageDecision => {
      decisionContexts.push(ctx);
      return testStopMessageDecision(ctx as any) as StopMessageDecision;
    });
    try {
      const result = await runServerToolOrchestration({
        chat: buildStopChatResponse('chatcmpl-stop-raw-responses-captured'),
        adapterContext: {
          requestId: 'req-stopmessage-raw-responses-captured',
          entryEndpoint: '/v1/responses',
          providerProtocol: 'openai-chat',
          sessionId: undefined,
          routecodexPortStopMessageEnabled: true,
          stopMessageEnabled: true,
          __raw_request_body: {
            model: 'gpt-test',
            input: [
              { role: 'user', content: [{ type: 'input_text', text: 'hi' }] }
            ]
          },
          responsesRequestContext: {
            payload: {
              model: 'gpt-test',
              input: [
                { role: 'user', content: [{ type: 'input_text', text: 'hi' }] }
              ]
            }
          },
          __rt: {
            sessionDir: '/tmp/rcc-test-session-5555'
          }
        } as any,
        entryEndpoint: '/v1/responses',
        requestId: 'req-stopmessage-raw-responses-captured',
        providerProtocol: 'openai-chat',
        reenterPipeline
      });

      expect(decisionContexts[0]?.goal_status).toBe('idle');
      expect(reenterPipeline).not.toHaveBeenCalled();
      const { cmd } = readStopMessageCliProjection(result, 'ok');
      expect(cmd).toContain('"repeatCount":1');
      expect(cmd).toContain('"maxRepeats":3');
    } finally {
      __setDecideOverrideForTests(testStopMessageDecision as any);
    }
  });

  test('standard captured responses request projects stopless CLI with continuation input', async () => {
    const decisionContexts: StopMessageDecisionContext[] = [];
    const sessionId = 'stopmessage-spec-session-standard-responses-captured-isolated';
    fs.rmSync(path.join(SESSION_DIR, `tmux-${sessionId}.json`), { force: true });
    fs.rmSync(path.join(SESSION_DIR, `session-${sessionId}.json`), { force: true });
    const reenterPipeline = jest.fn(async (input: any) => ({
      body: {
        id: `${input.requestId}:done`,
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'continued' }, finish_reason: 'stop' }]
      }
    }));
    __setDecideOverrideForTests((ctx: StopMessageDecisionContext): StopMessageDecision => {
      decisionContexts.push(ctx);
      return testStopMessageDecision(ctx as any) as StopMessageDecision;
    });
    try {
      const result = await runServerToolOrchestration({
        chat: buildStopChatResponse('chatcmpl-stop-standard-responses-captured'),
        adapterContext: {
          requestId: 'req-stopmessage-standard-responses-captured',
          entryEndpoint: '/v1/responses',
          providerProtocol: 'openai-chat',
          sessionId,
          routecodexPortStopMessageEnabled: true,
          stopMessageEnabled: true,
          capturedChatRequest: {
            model: 'gpt-test',
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
            tools: [{ type: 'function', function: { name: 'exec_command', parameters: { type: 'object' } } }]
          },
          __rt: { sessionDir: '/tmp/rcc-test-session-5555' }
        } as any,
        entryEndpoint: '/v1/responses',
        requestId: 'req-stopmessage-standard-responses-captured',
        providerProtocol: 'openai-chat',
        reenterPipeline
      });

      expect(decisionContexts[0]?.goal_status).toBe('idle');
      expect(reenterPipeline).not.toHaveBeenCalled();
      const { cmd } = readStopMessageCliProjection(result, 'ok');
      expect(cmd).toContain('"repeatCount":1');
      expect(cmd).toContain('"maxRepeats":3');
      expect(cmd).toContain('第一轮核对');
      expect(cmd).toContain('Stop schema 校验未通过');
      expect(cmd).toContain('JSON 对象');
    } finally {
      __setDecideOverrideForTests(testStopMessageDecision as any);
    }
  });

  test('historical goal-context repeated stop projects CLI and preserves assistant stop text', async () => {
    const assistantText = '立刻跑全测试 + 远端验证。';
    const sessionId = 'stopmessage-spec-session-goal-loop';
    fs.rmSync(path.join(SESSION_DIR, `tmux-${sessionId}.json`), { force: true });
    fs.rmSync(path.join(SESSION_DIR, `session-${sessionId}.json`), { force: true });
    const result = await runServerToolOrchestration({
        chat: {
          id: 'chatcmpl-goal-loop-stop',
          object: 'chat.completion',
          model: 'gpt-test',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: assistantText },
              finish_reason: 'stop'
            }
          ]
        } as JsonObject,
        adapterContext: {
          requestId: 'req-goal-active-stop-loop',
          entryEndpoint: '/v1/chat/completions',
          providerProtocol: 'openai-chat',
          sessionId,
          capturedChatRequest: {
            model: 'gpt-test',
            messages: [
              {
                role: 'user',
                content: '<codex_internal_context source="goal">\nContinue working toward the active thread goal.\n<objective>完成验证</objective>'
              },
              { role: 'assistant', content: assistantText },
              { role: 'user', content: 'Continue working toward the active thread goal.' },
              { role: 'assistant', content: assistantText }
            ]
          }
        } as any,
        entryEndpoint: '/v1/chat/completions',
        requestId: 'req-goal-active-stop-loop',
        providerProtocol: 'openai-chat'
      });
    const { cmd } = readStopMessageCliProjection(result, assistantText);
    expect(cmd).toContain('"repeatCount":1');
    expect(cmd).toContain('第一轮核对');
  });

  test('stop_message_flow uses CLI projection and never clientInjectDispatch or reenterPipeline', async () => {
    const sessionId = 'stopmessage-client-inject-only';
    writeRoutingStateForSession(sessionId, {
      forcedTarget: undefined,
        allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续执行',
      stopMessageMaxRepeats: 3,
      stopMessageUsed: 0,
      stopMessageStageMode: 'auto'
    });

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-client-inject-only',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      tmuxSessionId: sessionId,
      clientTmuxSessionId: sessionId,
      clientInjectReady: true,
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: '继续处理' }]
      }
    } as any;

    const clientInjectDispatch = jest.fn(async () => ({ ok: true } as any));
    const reenterPipeline = jest.fn(async () => ({
      body: {
        id: 'chatcmpl-stopmessage-reentered',
        object: 'chat.completion',
        model: 'gpt-test',
        choices: [{ index: 0, message: { role: 'assistant', content: 'reentered' }, finish_reason: 'stop' }]
      } as JsonObject
    }));

    const result = await runServerToolOrchestration({
      chat: buildStopChatResponse(),
      adapterContext,
      requestId: 'req-stopmessage-client-inject-only',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      clientInjectDispatch,
      reenterPipeline
    });

    expect(clientInjectDispatch).not.toHaveBeenCalled();
    expect(reenterPipeline).not.toHaveBeenCalled();
    const { cmd } = readStopMessageCliProjection(result, 'ok');
    expect(cmd).toContain('"repeatCount":1');
  });

  test('triggers stopMessage when a later choice has finish_reason=stop', async () => {
    const sessionId = 'stopmessage-spec-session-multi-choice-stop';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
        allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '立即执行待处理任务',
      stopMessageMaxRepeats: 2,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stop-multi-choice',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'ignored'
          },
          finish_reason: 'content_filter'
        },
        {
          index: 1,
          message: {
            role: 'assistant',
            content: 'ok'
          },
          finish_reason: 'stop'
        }
      ]
    };

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-multi-choice',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-chat',
      sessionId,
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: '继续处理' }]
      }
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-stopmessage-multi-choice',
      providerProtocol: 'openai-chat'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('stop_message_flow');
  });

  test('does not trigger stopMessage when latest choice finish_reason is non-stop even if earlier choice is stop', async () => {
    const sessionId = 'stopmessage-spec-session-multi-choice-latest-nonstop';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
        allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续执行',
      stopMessageMaxRepeats: 2,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stop-multi-choice-latest-nonstop',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'old' },
          finish_reason: 'stop'
        },
        {
          index: 1,
          message: { role: 'assistant', content: 'new' },
          finish_reason: 'content_filter'
        }
      ]
    };

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-multi-choice-latest-nonstop',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-chat',
      sessionId,
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: '继续处理' }]
      }
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-stopmessage-multi-choice-latest-nonstop',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => ({ body: {} as JsonObject })
    });

    expect(result.mode).toBe('passthrough');
    expect(result.execution).toBeUndefined();
  });


  test('does not resolve stopMessage scope from adapterContext.metadata.sessionId without tmux (openai-chat)', async () => {
    const sessionId = 'stopmessage-spec-session-metadata-scope';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
        allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '立即执行待处理任务',
      stopMessageMaxRepeats: 2,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stop-metadata-scope',
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
      requestId: 'req-stopmessage-metadata-scope',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      metadata: {
        sessionId
      },
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [
          {
            role: 'user',
            content: '继续处理'
          }
        ]
      }
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-stopmessage-metadata-scope',
      providerProtocol: 'openai-chat'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('stop_message_flow');
  });


  test('uses adapterContext.originalRequest as captured seed fallback (openai-chat)', async () => {
    const sessionId = 'stopmessage-spec-session-original-request-fallback';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
        allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '立即执行待处理任务',
      stopMessageMaxRepeats: 2,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stop-original-fallback',
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
      requestId: 'req-stopmessage-original-fallback',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      tmuxSessionId: sessionId,
      originalRequest: {
        model: 'gpt-test',
        messages: [
          {
            role: 'user',
            content: '继续处理'
          }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'exec_command',
              parameters: {
                type: 'object',
                properties: {
                  cmd: { type: 'string' }
                },
                required: ['cmd']
              }
            }
          }
        ]
      }
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-stopmessage-original-fallback',
      providerProtocol: 'openai-chat'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('stop_message_flow');
    const followup = result.execution?.followup as any;
    expect(followup).toBeDefined();
    const injectMeta = readClientInjectMeta(followup);
    expect(injectMeta.clientInjectOnly).toBe(false);
    expect(injectMeta.clientInjectText.length).toBeGreaterThan(0);
  });

  test('does not resolve stopMessage session scope from capturedContext fallback (prevents cross-session leakage)', async () => {
    const sessionId = 'stopmessage-spec-session-captured-context-only';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
        allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '立即执行待处理任务',
      stopMessageMaxRepeats: 2,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stop-captured-context-only',
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
      requestId: 'req-stopmessage-captured-context-only',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      metadata: {
        capturedContext: {
          __hub_capture: {
            context: {
              sessionId
            }
          }
        }
      },
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [
          {
            role: 'user',
            content: '继续处理'
          }
        ]
      }
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-stopmessage-captured-context-only',
      providerProtocol: 'openai-chat'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('stop_message_flow');
  });

  test('stopMessage routing state key uses client inject scope', () => {
    const key = resolveStateKey({
      providerProtocol: 'openai-responses',
      requestId: 'req-responses-stopmessage',
      clientTmuxSessionId: 'tmux-stop-1'
    });

    expect(key).toBe('tmux:tmux-stop-1');
  });

  test('stopMessage routing state key falls back to session scope without inject scope', () => {
    const key = resolveStateKey({
      providerProtocol: 'openai-responses',
      requestId: 'req-responses-stopmessage',
      sessionId: 'session-should-win'
    });

    expect(key).toBe('session:session-should-win');
  });

  test('openai-responses does not trigger stop_message when session stage mode is off', async () => {
    const sessionId = 'stopmessage-spec-session-responses-mode-off';
    clearStopStateForSession(sessionId);
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
        allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageStageMode: 'off'
    };
    writeRoutingStateForSession(sessionId, state);

    const chatResponse: JsonObject = {
      id: 'resp-stop-mode-off',
      object: 'response',
      status: 'completed',
      model: 'gpt-test',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'ok' }]
        }
      ]
    };

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-responses-mode-off',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      sessionId,
      capturedChatRequest: {
        model: 'gpt-test',
        input: [{ role: 'user', content: [{ type: 'input_text', text: '继续处理' }] }]
      }
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-stopmessage-responses-mode-off',
      providerProtocol: 'openai-responses'
    });

    expect(result.mode).toBe('passthrough');
    expect(result.execution).toBeUndefined();
  });

  test('stop_message followup pins exact routed provider and model from adapter context', async () => {
    const sessionId = 'stopmessage-spec-session-pin';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
        allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续执行',
      stopMessageMaxRepeats: 2,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);
    const capturedChatRequest = {
      model: 'minimax',
      messages: [
        {
          role: 'user',
          content: '继续执行'
        }
      ]
    };
    const chatResponse = {
      id: 'chatcmpl-stop-pin',
      object: 'chat.completion',
      model: 'MiniMax-M2.7',
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
      requestId: 'req-stopmessage-pin',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-chat',
      sessionId,
      providerKey: 'mini27.key1.minimax',
      targetProviderKey: 'mini27.key1.MiniMax-M2.7',
      routecodexPortMode: 'router',
      target: {
        providerKey: 'mini27.key1.MiniMax-M2.7',
        modelId: 'MiniMax-M2.7'
      },
      capturedChatRequest
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-stopmessage-pin',
      providerProtocol: 'openai-chat'
    });

    expect(result.execution?.flowId).toBe('stop_message_flow');
    const followup = result.execution?.followup as any;
    expect(followup?.metadata?.__shadowCompareForcedProviderKey).toBeUndefined();
    expect(followup?.metadata?.targetProviderKey).toBeUndefined();
    expect(followup?.metadata?.assignedModelId).toBe('MiniMax-M2.7');
    expect(followup?.metadata?.target).toEqual({ modelId: 'MiniMax-M2.7' });
    expect(followup?.metadata?.routecodexPortMode).toBe('router');
  });

  test('skips stop_message retrigger on stop_message_flow followup hops', async () => {
    const sessionId = 'stopmessage-spec-session-followup-allow';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
        allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '立即执行待处理任务',
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

    expect(result.execution?.flowId).toBe('stop_message_flow');

    const persisted = await readJsonFileWithRetry<{ state?: { stopMessageUsed?: number } }>(
      resolveStopStatePath(sessionId),
    );
    expect(persisted?.state?.stopMessageUsed).toBe(1);
  });

  test('maps stop_message_flow loop state into runtime stop snapshot on followup hops', () => {
    const snapshot = resolveRuntimeStopMessageState({
      serverToolFollowup: true,
      serverToolFollowupSource: 'servertool.stop_message',
      stopMessageEnabled: true,
      serverToolLoopState: {
        flowId: 'stop_message_flow',
        repeatCount: 1,
        maxRepeats: 3,
        payloadHash: '__servertool_auto__'
      }
    });

    expect(snapshot).toEqual({
      text: '继续执行',
      maxRepeats: 3,
      used: 0,
      source: 'servertool.stop_message',
      stageMode: 'on'
    });
  });

  test('skips stop_message retrigger for non-stop followup flows', async () => {
    const sessionId = 'stopmessage-spec-session-followup-cross-flow';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
        allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '立即执行待处理任务',
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
    expect(result.execution).toBeUndefined();

    const persisted = await readJsonFileWithRetry<{ state?: { stopMessageUsed?: number } }>(
      resolveStopStatePath(sessionId)
    );
    expect(persisted?.state?.stopMessageUsed).toBe(0);
  });
  test.skip('builds /v1/responses followup and preserves parameters (non-streaming)', async () => {
    const sessionId = 'stopmessage-spec-session-responses';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
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

    expect(fs.existsSync(resolveStopStatePath(sessionId))).toBe(false);

    expect(capturedFollowup).toBeTruthy();
    expect(capturedFollowup?.entryEndpoint).toBe('/v1/responses');
    expect(capturedFollowup?.metadata?.__rt).toBeDefined();
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

  test.skip('builds /v1/responses followup when captured request is a Responses payload', async () => {
    const sessionId = 'stopmessage-spec-session-responses-captured';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
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

  test('does not arm stopMessage followup when client is already disconnected', async () => {
    const sessionId = 'stopmessage-spec-session-disconnected';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
        allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '立即执行待处理任务',
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

    await expect(runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-stopmessage-2',
      providerProtocol: 'openai-chat'
    })).rejects.toThrow(/client disconnected/i);
  });

  test('does not run stop compare when client is already disconnected', async () => {
    const sessionId = 'stopmessage-spec-session-disconnected-compare';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
        allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '立即执行待处理任务',
      stopMessageMaxRepeats: 2,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stop-disconnected-compare',
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
      requestId: 'req-stopmessage-disconnected-compare',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hi' }]
      },
      clientConnectionState: { disconnected: true }
    } as any;

    const records: Array<{ stage: string; payload: Record<string, unknown> }> = [];
    const stageRecorder = {
      record(stage: string, payload: Record<string, unknown>) {
        records.push({ stage, payload });
      }
    } as any;

    await expect(runServerToolOrchestration({
      chat: chatResponse,
      adapterContext,
      requestId: 'req-stopmessage-disconnected-compare',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      stageRecorder
    })).rejects.toThrow(/client disconnected/i);
    expect(records.find((entry) => entry.stage === 'servertool.stop_compare')).toBeUndefined();
  });

  test('does not wait for reenter when client disconnects during CLI projection', async () => {
    const sessionId = 'stopmessage-spec-session-disconnect-during-followup';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
        allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '立即执行待处理任务',
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
      id: 'chatcmpl-stop-disconnect-during-followup',
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

    const connectionState = { disconnected: false };
    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-disconnect-during-followup',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      capturedChatRequest,
      clientConnectionState: connectionState
    } as any;

    let reenterCalls = 0;
    setTimeout(() => {
      connectionState.disconnected = true;
      (adapterContext as any).clientDisconnected = true;
    }, 30);

    const result = await runServerToolOrchestration({
      chat: chatResponse,
      adapterContext,
      requestId: 'req-stopmessage-disconnect-during-followup',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => {
        reenterCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 220));
        return {
          body: {
            id: 'chatcmpl-stop-disconnect-during-followup-final',
            object: 'chat.completion',
            model: 'gpt-test',
            choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }]
          } as JsonObject
        };
      }
    });

    expect(reenterCalls).toBe(0);
    const { cmd } = readStopMessageCliProjection(result, 'ok');
    expect(cmd).toContain('"repeatCount":1');
  });

  test('stop followup never uses client injection even when client inject is ready', async () => {
    const sessionId = 'stopmessage-spec-session-client-inject-fail';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
        allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '立即执行待处理任务',
      stopMessageMaxRepeats: 2,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const capturedChatRequest: JsonObject = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }]
    };
    const chatResponse: JsonObject = {
      id: 'chatcmpl-stop-client-inject-fail',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
    };
    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-client-inject-fail',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      tmuxSessionId: sessionId,
      clientTmuxSessionId: sessionId,
      clientInjectReady: true,
      capturedChatRequest
    } as any;

    const enginePreview = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-stopmessage-client-inject-fail',
      providerProtocol: 'openai-chat'
    });
    expect(enginePreview.mode).toBe('tool_flow');
    expect(enginePreview.execution?.flowId).toBe('stop_message_flow');
    expect(enginePreview.execution?.followup).toBeDefined();
    writeRoutingStateForSession(sessionId, state);

    const clientInjectDispatch = jest.fn(async () => ({ ok: false as const, reason: 'inject_failed' }));
    const reenterPipeline = jest.fn(async () => ({ body: chatResponse }));
    const orchestration = await runServerToolOrchestration({
      chat: chatResponse,
      adapterContext,
      requestId: 'req-stopmessage-client-inject-fail',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      clientInjectDispatch,
      reenterPipeline
    });

    expect(clientInjectDispatch).not.toHaveBeenCalled();
    expect(reenterPipeline).not.toHaveBeenCalled();
    const { cmd } = readStopMessageCliProjection(orchestration, 'ok');
    expect(cmd).toContain('"repeatCount":1');
  });

  test.skip('forces followup stream=false even when captured parameters.stream=true', async () => {
    const sessionId = 'stopmessage-spec-session-stream-override';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
        allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '立即执行待处理任务',
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

  test.skip('client-inject stop followup runs once and returns original response', async () => {
    const sessionId = 'stopmessage-spec-session-empty-retry';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
        allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '立即执行待处理任务',
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
    expect(callCount).toBe(1);
    expect((orchestration.chat as any)?.id).toBe('chatcmpl-stop-empty-1');
  });


  test.skip('errors when stop_followup stays empty after retry', async () => {
    const sessionId = 'stopmessage-spec-session-empty-error';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
        allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '立即执行待处理任务',
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

    await expect(
      runServerToolOrchestration({
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
      })
    ).rejects.toMatchObject({
      code: 'SERVERTOOL_EMPTY_FOLLOWUP'
    });

    expect(fs.existsSync(resolveStopStatePath(sessionId))).toBe(false);
  });

  test.skip('does not throw empty-followup error when both followup and original response are empty in client-inject mode', async () => {
    const sessionId = 'stopmessage-spec-session-empty-error-empty-original';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
        allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '立即执行待处理任务',
      stopMessageMaxRepeats: 1,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const capturedChatRequest: JsonObject = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }]
    };

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stop-empty-original',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: ''
          },
          finish_reason: 'stop'
        }
      ]
    };

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-empty-original',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      capturedChatRequest
    } as any;

    let callCount = 0;
    const orchestration = await runServerToolOrchestration({
      chat: chatResponse,
      adapterContext,
      requestId: 'req-stopmessage-empty-original',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => {
        callCount += 1;
        return {
          body: {
            id: 'chatcmpl-followup-empty-empty-original',
            object: 'chat.completion',
            model: 'gpt-test',
            choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }]
          } as JsonObject
        };
      }
    });
    expect(orchestration.executed).toBe(true);
    expect(orchestration.flowId).toBe('stop_message_flow');
    expect((orchestration.chat as any)?.id).toBe('chatcmpl-stop-empty-original');
    expect(callCount).toBe(1);

    expect(fs.existsSync(resolveStopStatePath(sessionId))).toBe(false);
  });

  test('does not inject loop-break warning through nested stopMessage followup rounds', async () => {
    const sessionId = 'stopmessage-spec-session-loop-warn';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
        allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '立即执行待处理任务',
      stopMessageMaxRepeats: 30,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const capturedChatRequest: JsonObject = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }]
    };

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stop-loop-warn',
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

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-loop-warn',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      capturedChatRequest
    } as any;

    let nextRuntime: Record<string, unknown> | undefined;
    let lastFollowupBody: JsonObject | undefined;
    const first = await runServerToolOrchestration({
        chat: chatResponse,
        adapterContext,
      requestId: 'req-stopmessage-loop-warn-1',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        reenterPipeline: async (opts: any) => {
          nextRuntime = opts?.metadata?.__rt as Record<string, unknown> | undefined;
          lastFollowupBody = opts?.body as JsonObject;
          return {
            body: {
              id: 'chatcmpl-followup-loop-warn',
              object: 'chat.completion',
              model: 'gpt-test',
              choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }]
            } as JsonObject
          };
        }
      });
    expect(first.executed).toBe(true);
    expect(first.flowId).toBe('stop_message_flow');
    adapterContext.__rt = nextRuntime;

    const nested = await runServerToolOrchestration({
      chat: chatResponse,
      adapterContext,
      requestId: 'req-stopmessage-loop-warn-2',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => {
        return {
          body: {
            id: 'chatcmpl-followup-loop-warn-nested',
            object: 'chat.completion',
            model: 'gpt-test',
            choices: [{ index: 0, message: { role: 'assistant', content: 'nested done' }, finish_reason: 'stop' }]
          } as JsonObject
        };
      }
    });
    expect(nested.executed).toBe(true);
    expect(nested.flowId).toBe('stop_message_flow');

    const messages = Array.isArray((lastFollowupBody as any)?.messages) ? ((lastFollowupBody as any).messages as any[]) : [];
    expect(
      messages.some(
        (item) =>
          item &&
          typeof item === 'object' &&
          item.role === 'system' &&
          typeof item.content === 'string' &&
          item.content.includes('连续 5 轮一致')
      )
    ).toBe(false);
  });

  test('does not run timeout loop through nested stopMessage followup rounds', async () => {
    const sessionId = 'stopmessage-spec-session-loop-fail';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
        allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '立即执行待处理任务',
      stopMessageMaxRepeats: 30,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const capturedChatRequest: JsonObject = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }]
    };

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stop-loop-fail',
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

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-loop-fail',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      capturedChatRequest
    } as any;

    const first = await runServerToolOrchestration({
        chat: chatResponse,
        adapterContext,
      requestId: 'req-stopmessage-loop-fail-1',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        reenterPipeline: async () => {
          return {
            body: {
              id: 'chatcmpl-followup-loop-fail',
              object: 'chat.completion',
              model: 'gpt-test',
              choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }]
            } as JsonObject
          };
        }
      });
    const firstProjection = readStopMessageCliProjection(first, 'ok');
    expect(firstProjection.cmd).toContain('"repeatCount":1');

    let followupCalled = false;
    const nested = await runServerToolOrchestration({
        chat: chatResponse,
        adapterContext,
      requestId: 'req-stopmessage-loop-fail-2',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        reenterPipeline: async () => {
          followupCalled = true;
          return {
            body: {
              id: 'chatcmpl-followup-loop-fail-10',
              object: 'chat.completion',
              model: 'gpt-test',
              choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }]
            } as JsonObject
          };
        }
      });
    expect(nested.executed).toBe(true);
    expect(nested.flowId).toBe('stop_message_flow');
    expect(followupCalled).toBe(false);
    const nestedProjection = readStopMessageCliProjection(nested, 'ok');
    expect(nestedProjection.cmd).toContain('"repeatCount":2');
  });

  test('skips elapsed-time timeout check on stopMessage followup hop', async () => {
    const sessionId = 'stopmessage-spec-session-stage-timeout';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
        allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '立即执行待处理任务',
      stopMessageMaxRepeats: 30,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const capturedChatRequest: JsonObject = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }]
    };

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stop-stage-timeout',
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

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-stage-timeout',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      capturedChatRequest,
      __rt: {
        serverToolLoopState: {
          flowId: 'stop_message_flow',
          payloadHash: '__servertool_auto__',
          repeatCount: 1,
          startedAtMs: Date.now()
        }
      }
    } as any;

    let followupCalled = false;
    const result = await runServerToolOrchestration({
        chat: chatResponse,
        adapterContext,
        requestId: 'req-stopmessage-stage-timeout-1',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        reenterPipeline: async () => {
          followupCalled = true;
          return {
            body: {
              id: 'chatcmpl-followup-stage-timeout',
              object: 'chat.completion',
              model: 'gpt-test',
              choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }]
            } as JsonObject
          };
        }
      });
    expect(followupCalled).toBe(false);
    const { cmd } = readStopMessageCliProjection(result, 'ok');
    expect(cmd).toContain('"repeatCount":1');
  });
  test.skip('ignores stage policy templates in stop_message_auto followup flow', async () => {
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
      const injectMeta = readClientInjectMeta(followup);
      expect(injectMeta.clientInjectOnly).toBe(false);
      expect(injectMeta.clientInjectText).toBe('继续执行');

      const persisted = await readJsonFileUntil<{ state?: { stopMessageUsed?: number; stopMessageStage?: unknown } }>(
        resolveStopStatePath(sessionId),
        (data) => data?.state?.stopMessageUsed === 0
      );
      expect(injectMeta.clientInjectText).not.toContain('阶段A：先看 BD 状态');
      expect(persisted?.state?.stopMessageStage).toBeUndefined();
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


  test('mode-only stopMessage does not trigger followup without text', async () => {
    const tempUserDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp', 'stopmessage-stage-mode-only-userdir-'));
    const prevUserDir = process.env.ROUTECODEX_USER_DIR;
    const prevStageMode = process.env.ROUTECODEX_STOPMESSAGE_STAGE_MODE;
    const prevBdMode = process.env.ROUTECODEX_STOPMESSAGE_BD_MODE;
    try {
      fs.mkdirSync(path.join(tempUserDir, 'stopMessage'), { recursive: true });
      fs.writeFileSync(
        path.join(tempUserDir, 'stopMessage', 'stage-status-check.md'),
        '阶段A：状态确认\n{{BASE_STOP_MESSAGE}}',
        'utf8'
      );
      fs.writeFileSync(
        path.join(tempUserDir, 'stopMessage', 'stage-active-continue.md'),
        '阶段A2：根据 BD 状态继续执行\n{{BASE_STOP_MESSAGE}}',
        'utf8'
      );
      fs.writeFileSync(
        path.join(tempUserDir, 'stopMessage', 'stage-loop-self-check.md'),
        '阶段B：循环自检\n{{BASE_STOP_MESSAGE}}',
        'utf8'
      );
      process.env.ROUTECODEX_USER_DIR = tempUserDir;
      process.env.ROUTECODEX_STOPMESSAGE_STAGE_MODE = 'on';
      process.env.ROUTECODEX_STOPMESSAGE_BD_MODE = 'heuristic';

      const sessionId = 'stopmessage-spec-session-stage-mode-only';
      const state: RoutingInstructionState = {
        forcedTarget: undefined,
            allowedProviders: new Set(),
        disabledProviders: new Set(),
        disabledKeys: new Map(),
        disabledModels: new Map(),
        stopMessageMaxRepeats: 10,
        stopMessageUsed: 0,
        stopMessageStageMode: 'on'
      };
      writeRoutingStateForSession(sessionId, state);

      const chatResponse: JsonObject = {
        id: 'chatcmpl-stage-mode-only',
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
        requestId: 'req-stopmessage-stage-mode-only',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        sessionId,
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [
            { role: 'user', content: '继续执行' },
            { role: 'tool', content: 'bd --no-db show routecodex-95\nstatus: in_progress' }
          ]
        }
      } as any;

  const result = await runServerSideToolEngine({
    chatResponse,
    adapterContext,
    entryEndpoint: '/v1/chat/completions',
    requestId: 'req-stopmessage-stage-mode-only',
        providerProtocol: 'openai-chat'
      });

      expect(result.mode).toBe('passthrough');
      expect(result.execution).toBeUndefined();
      const persisted = await readJsonFileUntil<{ state?: { stopMessageText?: unknown; stopMessageStageMode?: unknown; stopMessageUsed?: unknown } }>(
        resolveStopStatePath(sessionId),
        (data) =>
          data?.state?.stopMessageText === undefined &&
          data?.state?.stopMessageStageMode === 'on' &&
          data?.state?.stopMessageUsed === 0
      );
      expect(persisted?.state?.stopMessageText).toBeUndefined();
      expect(persisted?.state?.stopMessageStageMode).toBe('on');
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
      if (prevBdMode === undefined) {
        delete process.env.ROUTECODEX_STOPMESSAGE_BD_MODE;
      } else {
        process.env.ROUTECODEX_STOPMESSAGE_BD_MODE = prevBdMode;
      }
      fs.rmSync(tempUserDir, { recursive: true, force: true });
    }
  });

  test('non-stop finish_reason resets only stopMessageUsed and preserves config', async () => {
    const sessionId = 'stopmessage-spec-session-reset-used';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      preferTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续执行',
      stopMessageMaxRepeats: 3,
      stopMessageUsed: 2,
      stopMessageStageMode: 'on'
    };
    writeRoutingStateForSession(sessionId, state);

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stopmessage-reset-used',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'ok'
          },
          finish_reason: 'length'
        }
      ]
    };

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-reset-used',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: '继续执行' }]
      }
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-stopmessage-reset-used',
      providerProtocol: 'openai-chat'
    });

    expect(result.mode).toBe('passthrough');
    const persisted = await readJsonFileUntil<{ state?: { stopMessageText?: unknown; stopMessageMaxRepeats?: unknown; stopMessageUsed?: unknown; stopMessageStageMode?: unknown } }>(
      resolveStopStatePath(sessionId),
      (data) => data?.state?.stopMessageUsed === 0
    );
    expect(persisted?.state?.stopMessageText).toBe('继续执行');
    expect(persisted?.state?.stopMessageMaxRepeats).toBe(3);
    expect(persisted?.state?.stopMessageStageMode).toBe('on');
  });

  test('mode-only stopMessage remains inactive by default without text', async () => {
    const sessionId = 'stopmessage-spec-session-stage-mode-only-default';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
        allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageMaxRepeats: 10,
      stopMessageUsed: 0,
      stopMessageStageMode: 'on'
    };
    writeRoutingStateForSession(sessionId, state);

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stage-mode-only-default',
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
      requestId: 'req-stopmessage-stage-mode-only-default',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: '继续执行' }]
      }
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-stopmessage-stage-mode-only-default',
      providerProtocol: 'openai-chat'
    });

    expect(result.mode).toBe('passthrough');
    expect(result.execution).toBeUndefined();
    const persisted = await readJsonFileUntil<{ state?: { stopMessageUsed?: unknown; stopMessageStageMode?: unknown } }>(
      resolveStopStatePath(sessionId),
      (data) => data?.state?.stopMessageUsed === 0
    );
    expect(persisted?.state?.stopMessageUsed).toBe(0);
    expect(persisted?.state?.stopMessageStageMode).toBe('on');
  });

  test('legacy mode-only session state without text does not self-activate', async () => {
    const sessionId = 'stopmessage-spec-session-legacy-mode-only-no-max';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
        allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageUsed: 0,
      stopMessageStageMode: 'on'
    };
    writeRoutingStateForSession(sessionId, state);

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stage-legacy-no-max',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '继续'
          },
          finish_reason: 'stop'
        }
      ]
    };

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-legacy-mode-only-no-max',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages',
      sessionId,
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: '继续' }]
      }
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/messages',
      requestId: 'req-stopmessage-legacy-mode-only-no-max',
      providerProtocol: 'anthropic-messages'
    });

    expect(result.mode).toBe('passthrough');
    expect(result.execution).toBeUndefined();

    const persisted = await readJsonFileUntil<{ state?: { stopMessageText?: unknown; stopMessageStageMode?: unknown; stopMessageMaxRepeats?: unknown; stopMessageUsed?: unknown } }>(
      resolveStopStatePath(sessionId),
      (data) =>
        data?.state?.stopMessageText === undefined &&
        data?.state?.stopMessageStageMode === 'on' &&
        data?.state?.stopMessageMaxRepeats === undefined &&
        data?.state?.stopMessageUsed === 0
    );
    expect(persisted?.state?.stopMessageText).toBeUndefined();
    expect(persisted?.state?.stopMessageStageMode).toBe('on');
    expect(persisted?.state?.stopMessageMaxRepeats).toBeUndefined();
  });


  test.skip('keeps base stopMessage text even when stage templates and bd in_progress are present', async () => {
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
      const injectMeta = readClientInjectMeta(followup);
      expect(injectMeta.clientInjectOnly).toBe(false);
      expect(injectMeta.clientInjectText).toBe('继续执行');
      const persisted = await readJsonFileUntil<{ state?: { stopMessageUsed?: number; stopMessageStage?: unknown } }>(
        resolveStopStatePath(sessionId),
        (data) => data?.state?.stopMessageUsed === 0
      );
      expect(persisted?.state?.stopMessageStage).toBeUndefined();
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

  test('keeps plain stopMessage followup across repeated rounds', async () => {
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
      await readJsonFileUntil<{ state?: { stopMessageUsed?: number } }>(
        resolveStopStatePath(sessionId),
        (data) => data?.state?.stopMessageUsed === 1
      );

      const second = await runServerSideToolEngine({
        chatResponse,
        adapterContext,
        entryEndpoint: '/v1/chat/completions',
        requestId: 'req-stopmessage-stage-loop-2',
        providerProtocol: 'openai-chat'
      });
      expect(second.mode).toBe('tool_flow');
      await readJsonFileUntil<{ state?: { stopMessageUsed?: number } }>(
        resolveStopStatePath(sessionId),
        (data) => data?.state?.stopMessageUsed === 2
      );

      const third = await runServerSideToolEngine({
        chatResponse,
        adapterContext,
        entryEndpoint: '/v1/chat/completions',
        requestId: 'req-stopmessage-stage-loop-3',
        providerProtocol: 'openai-chat'
      });
      expect(third.mode).toBe('tool_flow');

      await readJsonFileUntil<{ state?: { stopMessageUsed?: number } }>(
        resolveStopStatePath(sessionId),
        (data) => data?.state?.stopMessageUsed === 3
      );
      const fourth = await runServerSideToolEngine({
        chatResponse,
        adapterContext,
        entryEndpoint: '/v1/chat/completions',
        requestId: 'req-stopmessage-stage-loop-4',
        providerProtocol: 'openai-chat'
      });
      expect(fourth.mode).toBe('tool_flow');

      const persisted = await readJsonFileUntil<{ state?: { stopMessageText?: unknown; stopMessageMaxRepeats?: unknown; stopMessageUsed?: number } }>(
        resolveStopStatePath(sessionId),
        (data) => data?.state?.stopMessageUsed === 4
      );
      expect(typeof persisted?.state?.stopMessageText).toBe('string');
      expect(String(persisted?.state?.stopMessageText ?? '')).toContain('第三轮最终收尾');
      expect(String(persisted?.state?.stopMessageText ?? '')).toContain('用户可读 summary');
      expect(String(persisted?.state?.stopMessageText ?? '')).not.toContain('直接发出工具调用');
      expect(persisted?.state?.stopMessageMaxRepeats).toBe(10);
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


  test('extracts structured blocked JSON report from assistant text payload', () => {
    const report = extractBlockedReportFromMessagesForTests([
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: [
              '执行受阻，请建单：',
              '```json',
              '{"type":"blocked","summary":"deepseek token refresh failed","blocker":"HTTP 401 from oauth endpoint","impact":"cannot continue auth flow","next_action":"rotate credential and retry","evidence":["requestId=req_1","provider=deepseek-web.3"]}',
              '```'
            ].join('\n')
          }
        ]
      }
    ]);

    expect(report).toBeTruthy();
    expect(report?.summary).toBe('deepseek token refresh failed');
    expect(report?.blocker).toBe('HTTP 401 from oauth endpoint');
    expect(report?.nextAction).toBe('rotate credential and retry');
    expect(report?.evidence).toEqual(['requestId=req_1', 'provider=deepseek-web.3']);
  });

});
