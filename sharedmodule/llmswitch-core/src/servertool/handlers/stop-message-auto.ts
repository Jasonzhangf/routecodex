import type { JsonObject } from '../../conversion/hub/types/json.js';
import type {
  ServerToolHandler,
  ServerToolHandlerContext,
  ServerToolHandlerPlan
} from '../types.js';
import { registerServerToolHandler } from '../registry.js';
import type { ServerToolFollowupPlan } from '../types.js';
import { isCompactionRequest } from './compaction-detect.js';
import { extractCapturedChatSeed } from '../followup-seed.js';
import { readRuntimeMetadata } from '../../conversion/runtime-metadata.js';
import { isStopEligibleForServerTool, resolveStopGatewayContext } from '../stop-gateway-context.js';
import { attachStopMessageCompareContext, type StopMessageCompareContext } from '../stop-message-compare-context.js';
import {
  resolveStopMessageDebugEnabled,
  resolveStopMessageDefaultEnabled,
  resolveStopMessageDefaultMaxRepeats,
  resolveStopMessageDefaultText
} from './stop-message-auto/config.js';
import { sanitizeFollowupText } from './followup-sanitize.js';
import {
  getCapturedRequest,
  hasCompactionFlag,
  persistStopMessageState,
  readServerToolFollowupFlowId,
  resolveClientConnectionState,
  resolveDefaultStopMessageSnapshot,
  resolveImplicitGeminiStopMessageSnapshot,
  resolveRuntimeStopMessageState,
  planStopMessagePersistedLookup,
  readRuntimeStopMessageStageMode
} from './stop-message-auto/runtime-utils.js';
import { readStoplessGoalState } from './stopless-goal-state.js';
import { loadRoutingInstructionStateSync } from '../../router/virtual-router/routing-state-store.js';
import type {
  StopMessageDecisionContext,
  StopMessageDecision
} from '../../router/virtual-router/engine-selection/native-stop-message-auto-semantics.js';
import {
  evaluateGoalActiveStopLoopGuardWithNative,
  evaluateStopSchemaGateWithNative,
  runStopMessageAutoHandlerWithNative
} from '../../router/virtual-router/engine-selection/native-stop-message-auto-semantics.js';
import { detectProviderResponseShapeWithNative } from '../../router/virtual-router/engine-selection/native-chat-process-servertool-orchestration-semantics.js';
import {
  applyStopMessageSnapshotToState,
  clearStopMessageState,
  normalizeStopMessageStageMode,
  resolveStopMessageSnapshot
} from './stop-message-auto/routing-state.js';
import {
  resolveWorkingDirectoryFromAdapterContext,
  writeStoplessLearnedNoteEntry
} from './memory/cache-writer.js';

export { extractBlockedReportFromMessagesForTests } from './stop-message-auto/blocked-report.js';

/** Pluggable decision function — default calls native, overridable for tests. */
let decideOverride: ((ctx: StopMessageDecisionContext) => StopMessageDecision) | null = null;

export function __setDecideOverrideForTests(
  fn: ((ctx: StopMessageDecisionContext) => StopMessageDecision) | null
): void {
  decideOverride = fn;
}

async function decideStopMessageAction(
  ctx: StopMessageDecisionContext
): Promise<StopMessageDecision> {
  if (decideOverride) {
    return decideOverride(ctx);
  }
  const { decideStopMessageActionWithNative: nativeFn } = await import(
    '../../router/virtual-router/engine-selection/native-stop-message-auto-semantics.js'
  );
  return nativeFn(ctx);
}

async function evaluateGoalActiveStopLoopGuard(args: {
  capturedRequest: Record<string, unknown>;
  assistantText: string;
  threshold?: number;
}) {
  return evaluateGoalActiveStopLoopGuardWithNative(args);
}

const STOPMESSAGE_DEBUG = resolveStopMessageDebugEnabled() ?? (process.env.ROUTECODEX_STOPMESSAGE_DEBUG || '').trim() === '1';
const STOPMESSAGE_IMPLICIT_GEMINI = false;
const FLOW_ID = 'stop_message_flow';
const STOP_MESSAGE_EXECUTION_APPEND = '继续完成当前用户目标。若仍需操作、检查或验证，必须调用可用工具继续执行；不要只总结、道歉、复述状态或输出计划。只有目标已经完成时，才输出最终简短结果。';

function extractCurrentAssistantStopText(payload: unknown): string {
  const row = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : null;
  if (!row) return '';
  const choices = Array.isArray(row.choices) ? row.choices : [];
  const texts: string[] = [];
  for (const choice of choices) {
    const choiceRow = choice && typeof choice === 'object' && !Array.isArray(choice) ? choice as Record<string, unknown> : null;
    const message = choiceRow?.message && typeof choiceRow.message === 'object' && !Array.isArray(choiceRow.message)
      ? choiceRow.message as Record<string, unknown>
      : null;
    collectTextBlocks(message?.content, texts);
  }
  const output = Array.isArray(row.output) ? row.output : [];
  for (const item of output) {
    const itemRow = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : null;
    collectTextBlocks(itemRow?.content, texts);
  }
  return texts.join('\n').trim();
}

function collectTextBlocks(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    const text = value.trim();
    if (text) out.push(text);
    return;
  }
  if (!Array.isArray(value)) return;
  for (const part of value) {
    if (typeof part === 'string') {
      const text = part.trim();
      if (text) out.push(text);
      continue;
    }
    const partRow = part && typeof part === 'object' && !Array.isArray(part) ? part as Record<string, unknown> : null;
    const text = typeof partRow?.text === 'string'
      ? partRow.text
      : typeof partRow?.output_text === 'string'
        ? partRow.output_text
        : typeof partRow?.content === 'string'
          ? partRow.content
          : '';
    const trimmed = text.trim();
    if (trimmed) out.push(trimmed);
  }
}

function applyStopSummaryPrefix(payload: JsonObject, prefix: unknown): JsonObject {
  const text = typeof prefix === 'string' ? prefix.trim() : '';
  if (!text) return payload;
  const cloned = JSON.parse(JSON.stringify(payload)) as JsonObject;
  if (prefixChatChoiceContent(cloned, text)) return cloned;
  if (prefixResponsesOutputContent(cloned, text)) return cloned;
  return cloned;
}

function buildStopSchemaBudgetExhaustedSummary(args: {
  reasonCode?: string;
  capturedRequest?: JsonObject | null;
  currentSummary?: string;
} = {}): string {
  const current = typeof args.currentSummary === 'string' ? args.currentSummary.trim() : '';
  const rounds = extractStoplessRounds(args.capturedRequest, current);
  const lines = [
    'Stopless 校验结果：连续 stop 预算已耗尽。',
    `校验状态：${args.reasonCode ?? 'stop_schema_budget_exhausted'}`,
    '处理结果：不再继续自动续杯；以下保留三次续杯询问、模型返回内容与最后原始 summary，请完整呈现当前问题、已做事项、未完成事项与阻塞点。'
  ];
  rounds.forEach((round, index) => {
    lines.push(`\n第 ${index + 1} 次续杯询问：\n${round.question}`);
    lines.push(`第 ${index + 1} 次模型返回：\n${round.answer || '(空)'}`);
  });
  lines.push(`\n最后原始 summary：\n${current || '(空)'}`);
  return lines.join('\n');
}

function extractStoplessRounds(capturedRequest: JsonObject | null | undefined, currentSummary?: string): Array<{ question: string; answer: string }> {
  const messages = capturedRequest && Array.isArray((capturedRequest as { messages?: unknown }).messages)
    ? (capturedRequest as { messages: unknown[] }).messages
    : [];
  const rounds: Array<{ question: string; answer: string }> = [];
  for (let index = 0; index < messages.length; index += 1) {
    const row = messages[index] && typeof messages[index] === 'object' && !Array.isArray(messages[index])
      ? messages[index] as Record<string, unknown>
      : null;
    if (row?.role !== 'user') continue;
    const question = flattenMessageContent(row.content).trim();
    if (!isStoplessFollowupQuestion(question)) continue;
    let answer = '';
    for (let next = index + 1; next < messages.length; next += 1) {
      const nextRow = messages[next] && typeof messages[next] === 'object' && !Array.isArray(messages[next])
        ? messages[next] as Record<string, unknown>
        : null;
      if (nextRow?.role === 'assistant') {
        answer = flattenMessageContent(nextRow.content).trim();
        break;
      }
      if (nextRow?.role === 'user') break;
    }
    rounds.push({ question, answer });
  }
  const last = rounds[rounds.length - 1];
  const current = typeof currentSummary === 'string' ? currentSummary.trim() : '';
  if (last && !last.answer && current) {
    last.answer = current;
  }
  return rounds.slice(-3);
}

function flattenMessageContent(content: unknown): string {
  const texts: string[] = [];
  collectTextBlocks(content, texts);
  return texts.join('\n');
}

function isStoplessFollowupQuestion(text: string): boolean {
  return text.includes('Stop schema 校验未通过') ||
    text.includes('继续完成当前用户目标') ||
    text.includes('你刚才再次停止') ||
    text.includes('最后一次续杯预算') ||
    text.includes('你已经提供 next_step') ||
    text.includes('按当前目标继续执行');
}

function buildStopSchemaFinalPlan(chatResponse: JsonObject): ServerToolHandlerPlan {
  return {
    flowId: FLOW_ID,
    finalize: async () => ({
      chatResponse,
      execution: { flowId: FLOW_ID }
    })
  };
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function persistStoplessLearnedNoteOnAllowStop(args: {
  adapterContext: Record<string, unknown>;
  requestId: string;
  parsed?: Record<string, unknown>;
}): void {
  const learned = readNonEmptyString(args.parsed?.learned);
  if (!learned) {
    return;
  }
  writeStoplessLearnedNoteEntry({
    workingDirectory: resolveWorkingDirectoryFromAdapterContext(args.adapterContext),
    requestId: args.requestId,
    sessionId: readNonEmptyString(args.adapterContext.sessionId),
    timestampMs: Date.now(),
    learned,
    reason: readNonEmptyString(args.parsed?.reason),
    evidence: readNonEmptyString(args.parsed?.evidence)
  });
}

function prefixChatChoiceContent(payload: JsonObject, prefix: string): boolean {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  let changed = false;
  for (const choice of choices) {
    const choiceRow = choice && typeof choice === 'object' && !Array.isArray(choice) ? choice as Record<string, unknown> : null;
    const message = choiceRow?.message && typeof choiceRow.message === 'object' && !Array.isArray(choiceRow.message)
      ? choiceRow.message as Record<string, unknown>
      : null;
    if (!message) continue;
    if (typeof message.content === 'string') {
      message.content = `${prefix}\n${message.content}`;
      changed = true;
      continue;
    }
    if (Array.isArray(message.content)) {
      message.content.unshift({ type: 'text', text: `${prefix}\n` });
      changed = true;
    }
  }
  return changed;
}

function prefixResponsesOutputContent(payload: JsonObject, prefix: string): boolean {
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    const itemRow = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : null;
    const content = Array.isArray(itemRow?.content) ? itemRow.content : null;
    if (!content) continue;
    content.unshift({ type: 'output_text', text: `${prefix}\n` });
    return true;
  }
  return false;
}

function clearPersistedStopMessageRuntimeState(keys: string[]): void {
  for (const key of keys) {
    if (!isPersistentStickyKey(key)) continue;
    const persistedState = loadRoutingInstructionStateSync(key) ?? null;
    if (!persistedState) continue;
    clearStopMessageState(persistedState, Date.now());
    persistStopMessageState(key, persistedState);
  }
}

function handlerResultPersistKeys(candidateKeys: string[], stickyKey?: string, strictSessionScope?: string): string[] {
  const out: string[] = [];
  for (const key of [stickyKey, strictSessionScope, ...candidateKeys]) {
    if (!isPersistentStickyKey(key)) continue;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

function shouldYieldToEmptyReplyContinueLocal(args: {
  base: unknown;
  providerProtocol?: string;
  entryEndpoint?: string;
}): boolean {
  const endpoint = String(args.entryEndpoint || '').toLowerCase();
  const providerProtocol = String(args.providerProtocol || '').toLowerCase();
  const payload = args.base && typeof args.base === 'object' && !Array.isArray(args.base)
    ? (args.base as Record<string, unknown>)
    : null;
  if (endpoint.includes('/v1/responses')) {
    if (detectProviderResponseShapeWithNative(payload) !== 'openai-responses') {
      return false;
    }
    const status = typeof payload?.status === 'string' ? payload.status.trim().toLowerCase() : '';
    const output = Array.isArray(payload?.output) ? payload.output as unknown[] : [];
    const requiredAction = payload?.required_action && typeof payload.required_action === 'object';
    if ((!status || status === 'completed') && output.length === 0 && !requiredAction) {
      return true;
    }
  }
  if (providerProtocol === 'gemini-chat') {
    const choices = Array.isArray(payload?.choices) ? payload.choices as unknown[] : [];
    const first = choices[0] && typeof choices[0] === 'object' && !Array.isArray(choices[0]) ? choices[0] as Record<string, unknown> : null;
    const finishReason = typeof first?.finish_reason === 'string' ? first.finish_reason.trim().toLowerCase() : '';
    if (finishReason === 'length') {
      return true;
    }
  }
  return false;
}

function isPersistentStickyKey(value: unknown): value is string {
  return typeof value === 'string' && (
    value.startsWith('tmux:') || value.startsWith('session:') || value.startsWith('conversation:')
  );
}

function readPersistedStopMessageSnapshotFromCandidateKeys(candidateKeys: string[]): ReturnType<typeof resolveStopMessageSnapshot> {
  for (const key of candidateKeys) {
    if (!isPersistentStickyKey(key)) {
      continue;
    }
    const snapshot = resolveStopMessageSnapshot(loadRoutingInstructionStateSync(key));
    if (snapshot) {
      return snapshot;
    }
  }
  return null;
}

function readPersistedStopMessageTombstoneFromCandidateKeys(candidateKeys: string[]): {
  exhaustedDefault: boolean;
} {
  for (const key of candidateKeys) {
    if (!isPersistentStickyKey(key)) {
      continue;
    }
    const state = loadRoutingInstructionStateSync(key);
    if (!state) {
      continue;
    }
    if (state.stopMessageSource === 'default_exhausted') {
      return { exhaustedDefault: true };
    }
  }
  return { exhaustedDefault: false };
}

function resolveStopMessageDefaultEnabledLive(): boolean {
  return resolveStopMessageDefaultEnabled() ?? true;
}

function resolveStopMessageDefaultTextLive(): string {
  const fromConfig = resolveStopMessageDefaultText();
  if (typeof fromConfig === 'string' && fromConfig.trim().length > 0) {
    return fromConfig.trim();
  }
  const raw = process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_TEXT;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : STOP_MESSAGE_EXECUTION_APPEND;
}

function resolveStopMessageDefaultMaxRepeatsLive(): number {
  const fromConfig = resolveStopMessageDefaultMaxRepeats();
  if (Number.isFinite(fromConfig) && Number(fromConfig) > 0) {
    return Math.floor(Number(fromConfig));
  }
  const raw = process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_MAX_REPEATS;
  const parsed = typeof raw === 'string' ? Number(raw.trim()) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 3;
}

function debugLog(message: string, extra?: JsonObject): void {
  if (!STOPMESSAGE_DEBUG) {
    return;
  }
  try {
    // eslint-disable-next-line no-console
    console.log(`\x1b[38;5;33m[stopMessage][debug] ${message}` + (extra ? ` ${JSON.stringify(extra)}` : '') + '\x1b[0m');
  } catch {
    /* ignore logging failures */
  }
}

function hasResponsesSubmitToolOutputsResume(adapterContext: unknown): boolean {
  if (!adapterContext || typeof adapterContext !== 'object' || Array.isArray(adapterContext)) {
    return false;
  }
  const record = adapterContext as Record<string, unknown>;
  const runtime = readRuntimeMetadata(record) ?? {};
  const metadata =
    record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
      ? (record.metadata as Record<string, unknown>)
      : {};
  const candidates = [record.responsesResume, metadata.responsesResume, runtime.responsesResume];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      continue;
    }
    const resume = candidate as Record<string, unknown>;
    if (Array.isArray(resume.toolOutputsDetailed) && resume.toolOutputsDetailed.length > 0) {
      return true;
    }
  }
  return false;
}


function isStopMessageDisabledByPort(adapterContext: unknown): boolean {
  if (!adapterContext || typeof adapterContext !== 'object' || Array.isArray(adapterContext)) {
    return false;
  }
  const record = adapterContext as Record<string, unknown>;
  const runtime = readRuntimeMetadata(record) ?? {};
  const metadata =
    record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
      ? (record.metadata as Record<string, unknown>)
      : {};
  const candidates = [
    record.stopMessageEnabled,
    record.routecodexPortStopMessageEnabled,
    metadata.stopMessageEnabled,
    metadata.routecodexPortStopMessageEnabled,
    runtime.stopMessagePortEnabled,
    runtime.stopMessageEnabled,
    runtime.routecodexPortStopMessageEnabled
  ];
  return candidates.some((value) => value === false);
}

function isDirectStoplessGoalStateSnapshot(value: unknown): value is {
  status: string;
  objective: string;
  updatedAt: number;
  createdAt: number;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.status === 'string' &&
    typeof record.objective === 'string' &&
    typeof record.updatedAt === 'number' &&
    Number.isFinite(record.updatedAt) &&
    typeof record.createdAt === 'number' &&
    Number.isFinite(record.createdAt)
  );
}

function readRequestScopedGoalState(adapterContext: unknown): {
  state?: {
    status: string;
    objective: string;
    updatedAt: number;
    createdAt: number;
  };
  explicit: boolean;
} {
  if (!adapterContext || typeof adapterContext !== 'object' || Array.isArray(adapterContext)) {
    return { explicit: false };
  }
  const record = adapterContext as Record<string, unknown>;
  const directState = isDirectStoplessGoalStateSnapshot(record.stoplessGoalState)
    ? record.stoplessGoalState
    : undefined;
  const rt =
    record.__rt && typeof record.__rt === 'object' && !Array.isArray(record.__rt)
      ? (record.__rt as Record<string, unknown>)
      : undefined;
  const source =
    typeof rt?.stoplessGoalStateSource === 'string'
      ? rt.stoplessGoalStateSource.trim().toLowerCase()
      : '';
  const explicit = Boolean(directState) && source !== 'persisted';
  return {
    ...(directState ? { state: directState } : {}),
    explicit
  };
}

function collectFinishReasonsFromCurrentPayload(base: unknown): string[] | undefined {
  if (!base || typeof base !== 'object' || Array.isArray(base)) {
    return undefined;
  }
  const choices = Array.isArray((base as { choices?: unknown }).choices)
    ? ((base as { choices: unknown[] }).choices as unknown[])
    : [];
  if (!choices.length) {
    return undefined;
  }
  const reasons: string[] = [];
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object' || Array.isArray(choice)) continue;
    const finishReason = (choice as { finish_reason?: unknown }).finish_reason;
    if (typeof finishReason === 'string') {
      reasons.push(finishReason);
    }
  }
  return reasons.length > 0 ? reasons : undefined;
}

function isPlanModeActiveFromCapturedRequest(adapterContext: unknown): boolean {
  const captured = getCapturedRequest(adapterContext as any);
  if (!captured) {
    return false;
  }
  try {
    const text = JSON.stringify(captured).toLowerCase();
    return text.includes('<collaboration_mode>')
      && text.includes('collaboration mode: plan')
      && !text.includes('collaboration mode: default');
  } catch {
    return false;
  }
}

const handler: ServerToolHandler = async (
  ctx: ServerToolHandlerContext
): Promise<ServerToolHandlerPlan | null> => {
  const record = ctx.adapterContext as unknown as Record<string, unknown>;
  const rt = readRuntimeMetadata(ctx.adapterContext as unknown as Record<string, unknown>) ?? {};

  // ── Build native decision context ──
  const followupFlowId = readServerToolFollowupFlowId(rt)
    || (rt.serverToolFollowup === true ? '__servertool_followup__' : '');
  const persistedLookupPlan = planStopMessagePersistedLookup(record, rt, {
    includeSnapshotLookup: true,
    includeTombstoneLookup: true
  });
  const candidateKeys = persistedLookupPlan.candidateKeys;
  const persistedSnap = persistedLookupPlan.readStopMessageSnapshot
    ? readPersistedStopMessageSnapshotFromCandidateKeys(candidateKeys)
    : null;
  const runtimeSnap = resolveRuntimeStopMessageState(rt);
  const requestScopedGoal = readRequestScopedGoalState(ctx.adapterContext);
  const persistedGoal = readStoplessGoalState(ctx.adapterContext).state;
  const effectiveGoal = requestScopedGoal.state ?? persistedGoal;
  const tombstone = persistedLookupPlan.readStopMessageTombstone
    ? readPersistedStopMessageTombstoneFromCandidateKeys(candidateKeys)
    : { exhaustedDefault: false };
  const explicitMode = (normalizeStopMessageStageMode(undefined) ?? readRuntimeStopMessageStageMode(rt));
  const stopGateway = resolveStopGatewayContext(ctx.base, ctx.adapterContext);
  const captured = getCapturedRequest(ctx.adapterContext);
  const assistantStopText = extractCurrentAssistantStopText(ctx.base);
  const goalLoopContext = captured
    ? await evaluateGoalActiveStopLoopGuard({
        capturedRequest: captured as Record<string, unknown>,
        assistantText: assistantStopText,
        threshold: 3
      })
    : undefined;

  const stopMessageFollowupPolicy =
    rt.stopMessageFollowupPolicy === 'preserve_eligibility'
      ? 'preserve_eligibility'
      : rt.stopMessageFollowupPolicy === 'disable'
        ? 'disable'
        : followupFlowId === 'stop_message_flow'
          ? 'preserve_eligibility'
          : undefined;

  const decisionCtx: StopMessageDecisionContext = {
    port_stop_message_disabled: isStopMessageDisabledByPort(ctx.adapterContext),
    followup_flow_id: followupFlowId || undefined,
    stop_message_followup_policy: stopMessageFollowupPolicy,
    stop_eligible: stopGateway.eligible,
    finish_reasons: collectFinishReasonsFromCurrentPayload(ctx.base),
    has_responses_submit_tool_outputs_resume: hasResponsesSubmitToolOutputsResume(ctx.adapterContext),
    persisted_snapshot: persistedSnap ? {
      text: String(persistedSnap.text ?? ''),
      max_repeats: typeof persistedSnap.maxRepeats === 'number' ? Math.max(0, Math.floor(persistedSnap.maxRepeats)) : 0,
      used: typeof persistedSnap.used === 'number' ? Math.max(0, Math.floor(persistedSnap.used)) : 0,
      source: (persistedSnap.source === 'default' ? 'default' : 'persisted') as any,
      stage_mode: (persistedSnap.stageMode ?? 'on') as any,
    } : undefined,
    runtime_snapshot: runtimeSnap ? {
      text: String(runtimeSnap.text ?? ''),
      max_repeats: typeof runtimeSnap.maxRepeats === 'number' ? Math.max(0, Math.floor(runtimeSnap.maxRepeats)) : 0,
      used: typeof runtimeSnap.used === 'number' ? Math.max(0, Math.floor(runtimeSnap.used)) : 0,
      source: 'default' as any,
      stage_mode: 'on' as any,
    } : undefined,
    persisted_default_exhausted: tombstone.exhaustedDefault,
    explicit_mode: explicitMode === 'on' ? 'on' as any : explicitMode === 'auto' ? 'auto' as any : undefined,
    goal_status: goalLoopContext && goalLoopContext.goalContextCount > 0
      ? 'active' as any
      : (requestScopedGoal.explicit && effectiveGoal?.status === 'active'
        ? 'active' as any
        : (!effectiveGoal || effectiveGoal.status === 'idle' || effectiveGoal.status === 'active'
          ? 'idle' as any
          : effectiveGoal.status as any)),
    plan_mode_active: isPlanModeActiveFromCapturedRequest(ctx.adapterContext),
    default_enabled: resolveStopMessageDefaultEnabledLive(),
    default_max_repeats: resolveStopMessageDefaultMaxRepeatsLive(),
    default_text: resolveStopMessageDefaultTextLive(),
    empty_reply_continue_local: shouldYieldToEmptyReplyContinueLocal({
      base: ctx.base, providerProtocol: ctx.providerProtocol, entryEndpoint: ctx.entryEndpoint
    }),
    provider_pin: undefined,
  };

  // ── Call decision (native by default, overridable for tests) ──
  const decision = await decideStopMessageAction(decisionCtx);

  // ── Build compare context ──
  const compare: StopMessageCompareContext = {
    armed: decision.action === 'trigger',
    mode: decision.action === 'trigger' ? 'on' : 'off',
    allowModeOnly: false,
    textLength: decision.followup_text?.length ?? 0,
    maxRepeats: decision.max_repeats,
    used: decision.used,
    remaining: decision.max_repeats > decision.used ? decision.max_repeats - decision.used : 0,
    active: decision.action === 'trigger',
    stopEligible: stopGateway.eligible,
    hasCapturedRequest: Boolean(captured),
    compactionRequest: Boolean(captured && isCompactionRequest(captured)),
    hasSeed: Boolean(captured && extractCapturedChatSeed(captured)),
    decision: decision.action === 'trigger' ? 'trigger' : 'skip',
    reason: decision.skip_reason ?? 'native_decision',
  };

  try {
    if (decision.action !== 'trigger' && decision.skip_reason === 'skip_reached_max_repeats') {
      const prefixed = applyStopSummaryPrefix(
        ctx.base,
        buildStopSchemaBudgetExhaustedSummary({
          reasonCode: 'stop_schema_budget_exhausted',
          capturedRequest: captured,
          currentSummary: extractCurrentAssistantStopText(ctx.base)
        })
      );
      clearPersistedStopMessageRuntimeState(handlerResultPersistKeys(candidateKeys, persistedLookupPlan.stickyKey || undefined, persistedLookupPlan.strictSessionScope || undefined));
      compare.reason = 'stop_schema_budget_exhausted';
      return buildStopSchemaFinalPlan(prefixed);
    }
    if (decision.action !== 'trigger') {
      if (decision.skip_reason === 'skip_no_stopmessage_snapshot' || decision.skip_reason === 'skip_goal_active') {
        const assistantText = assistantStopText;
        if (assistantText && captured) {
          const goalLoop = goalLoopContext ?? await evaluateGoalActiveStopLoopGuard({
            capturedRequest: captured as Record<string, unknown>,
            assistantText,
            threshold: 3
          });
          if (goalLoop.loopDetected) {
            compare.reason = goalLoop.reasonCode || 'goal_active_repeated_stop';
            throw Object.assign(
              new Error(
                `[servertool] goal active stop loop detected: repeat=${goalLoop.repeatCount}/${goalLoop.threshold}; ` +
                `assistant repeatedly stopped without tool progress: ${assistantText.slice(0, 160)}`
              ),
              {
                code: 'GOAL_ACTIVE_STOP_LOOP_DETECTED',
                status: 500,
                repeatCount: goalLoop.repeatCount,
                threshold: goalLoop.threshold,
                goalContextCount: goalLoop.goalContextCount
              }
            );
          }
        }
      }
      return null;
    }

    const schemaGate = evaluateStopSchemaGateWithNative({
      assistantText: extractCurrentAssistantStopText(ctx.base),
      used: decision.used,
      maxRepeats: decision.max_repeats
    });
    compare.reason = schemaGate.reason_code || compare.reason;
    if (schemaGate.action === 'fail_fast') {
      const prefixed = applyStopSummaryPrefix(
        ctx.base,
        buildStopSchemaBudgetExhaustedSummary({
          reasonCode: schemaGate.reason_code,
          capturedRequest: captured,
          currentSummary: extractCurrentAssistantStopText(ctx.base)
        })
      );
      clearPersistedStopMessageRuntimeState(handlerResultPersistKeys(candidateKeys, persistedLookupPlan.stickyKey || undefined, persistedLookupPlan.strictSessionScope || undefined));
      return buildStopSchemaFinalPlan(prefixed);
    }

    if (schemaGate.action === 'allow_stop') {
      const prefixed = applyStopSummaryPrefix(ctx.base, schemaGate.summary_prefix);
      persistStoplessLearnedNoteOnAllowStop({
        adapterContext: ctx.adapterContext as unknown as Record<string, unknown>,
        requestId: ctx.requestId,
        parsed: schemaGate.parsed
      });
      clearPersistedStopMessageRuntimeState(handlerResultPersistKeys(candidateKeys, persistedLookupPlan.stickyKey || undefined, persistedLookupPlan.strictSessionScope || undefined));
      return buildStopSchemaFinalPlan(prefixed);
    }

    const effectiveDecision = schemaGate.followup_text
      ? { ...decision, followup_text: schemaGate.followup_text, followupText: schemaGate.followup_text }
      : decision;

    // ── Call native handler result assembler ──
    const stickyKey = persistedLookupPlan.stickyKey || undefined;
    const strictSessionScope = persistedLookupPlan.strictSessionScope || undefined;
    const handlerResult = runStopMessageAutoHandlerWithNative({
      decision: effectiveDecision as any,
      adapterContext: record,
      base: { ...ctx.base } as Record<string, unknown>,
      candidateKeys,
      stickyKey,
      strictSessionScope,
      followupFlowId: followupFlowId || undefined,
    });

    // ── Execute persist I/O (TS writes state files) ──
    const usedAt = Date.now();
    const stateUpdate = handlerResult.stateUpdate || {};
    const shouldCountBudget = schemaGate.count_budget !== false;
    const nextUsed = shouldCountBudget
      ? (typeof stateUpdate.used === 'number' ? stateUpdate.used : decision.used + 1)
      : decision.used;
    const snapInput = {
      text: String(stateUpdate.text ?? STOP_MESSAGE_EXECUTION_APPEND),
      maxRepeats: typeof stateUpdate.maxRepeats === 'number' ? stateUpdate.maxRepeats : decision.max_repeats,
      used: nextUsed,
      source: typeof stateUpdate.source === 'string' ? stateUpdate.source : 'default',
      stageMode: typeof stateUpdate.stageMode === 'string' ? stateUpdate.stageMode as any : 'on' as any,
      aiMode: 'off' as any,
      updatedAt: usedAt,
      lastUsedAt: usedAt
    };
    for (const key of handlerResult.persistKeys) {
      const persistedState = loadRoutingInstructionStateSync(key) ?? null;
      const nextState = applyStopMessageSnapshotToState(persistedState, snapInput);
      persistStopMessageState(key, nextState);
    }

    return {
      flowId: FLOW_ID,
      finalize: async () => {
        return {
          chatResponse: ctx.base,
          execution: {
            flowId: FLOW_ID,
            ...(stickyKey ? { stopMessageReservation: { stickyKey, previousState: null } } : {}),
            followup: handlerResult.followup as unknown as ServerToolFollowupPlan
          }
        };
      }
    };
  } finally {
    attachStopMessageCompareContext(ctx.adapterContext, compare);
  }
};

registerServerToolHandler('stop_message_auto', handler, { trigger: 'auto', hook: { phase: 'default', priority: 40 } });
