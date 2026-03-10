import type { JsonObject } from '../../conversion/hub/types/json.js';
import * as path from 'node:path';
import type {
  ServerToolHandler,
  ServerToolHandlerContext,
  ServerToolHandlerPlan
} from '../types.js';
import { registerServerToolHandler } from '../registry.js';
import { isCompactionRequest } from './compaction-detect.js';
import { extractCapturedChatSeed } from './followup-request-builder.js';
import { readRuntimeMetadata } from '../../conversion/runtime-metadata.js';
import { isStopEligibleForServerTool } from '../stop-gateway-context.js';
import { attachStopMessageCompareContext, type StopMessageCompareContext } from '../stop-message-compare-context.js';
import {
  extractStopMessageAutoResponseSnapshot,
  renderStopMessageAutoFollowupViaAi,
  resolveStopMessageAiApprovedMarker,
  resolveStopMessageAiDoneMarker,
  type StopMessageAiFollowupHistoryEntry
} from './stop-message-auto/iflow-followup.js';
import { sanitizeFollowupText } from './followup-sanitize.js';
import {
  getCapturedRequest,
  hasCompactionFlag,
  persistStopMessageState,
  readServerToolFollowupFlowId,
  resolveBdWorkingDirectoryForRecord,
  resolveClientConnectionState,
  resolveDefaultStopMessageSnapshot,
  resolveEntryEndpoint,
  resolveImplicitGeminiStopMessageSnapshot,
  resolveRuntimeStopMessageState,
  resolveStopMessageSessionScope,
  resolveStickyKey,
  resolveStopMessageFollowupProviderKey,
  resolveStopMessageFollowupToolContentMaxChars,
  readRuntimeStopMessageStageMode
} from './stop-message-auto/runtime-utils.js';
import { loadRoutingInstructionStateSync } from '../../router/virtual-router/sticky-session-store.js';
import {
  clearStopMessageState,
  createStopMessageState,
  resolveStopMessageSnapshot
} from './stop-message-auto/routing-state.js';

export { extractBlockedReportFromMessagesForTests } from './stop-message-auto/blocked-report.js';

const STOPMESSAGE_DEBUG = (process.env.ROUTECODEX_STOPMESSAGE_DEBUG || '').trim() === '1';
const STOPMESSAGE_IMPLICIT_GEMINI = false;
const STOPMESSAGE_DEFAULT_ENABLED = false;
const STOPMESSAGE_DEFAULT_TEXT = (() => {
  const raw = process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_TEXT;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : '继续执行';
})();
const STOPMESSAGE_DEFAULT_MAX_REPEATS = (() => {
  const raw = process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_MAX_REPEATS;
  const parsed = typeof raw === 'string' ? Number(raw.trim()) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1;
})();

function debugLog(message: string, extra?: JsonObject): void {
  if (!STOPMESSAGE_DEBUG) {
    return;
  }
  try {
    // eslint-disable-next-line no-console
    console.log(
      `\x1b[38;5;33m[stopMessage][debug] ${message}` +
        (extra ? ` ${JSON.stringify(extra)}` : '') +
        '\x1b[0m'
    );
  } catch {
    /* ignore logging failures */
  }
}

const FLOW_ID = 'stop_message_flow';

function hasStopMessageDoneMarker(snapshot: {
  assistantText?: string;
  reasoningText?: string;
  responseExcerpt?: string;
} | null | undefined, marker: string): boolean {
  if (!snapshot || !marker) {
    return false;
  }
  const normalizedMarker = marker.trim();
  if (!normalizedMarker) {
    return false;
  }
  const candidates = [snapshot.assistantText, snapshot.reasoningText, snapshot.responseExcerpt];
  return candidates.some((value) => typeof value === 'string' && value.includes(normalizedMarker));
}

function hasStopMessageMarkerLine(text: string, marker: string): boolean {
  const content = typeof text === 'string' ? text.trim() : '';
  const normalizedMarker = typeof marker === 'string' ? marker.trim() : '';
  if (!content || !normalizedMarker) {
    return false;
  }
  const escapedMarker = normalizedMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const markerLinePattern = new RegExp(`(^|\\n)\\s*${escapedMarker}\\s*(?=\\n|$)`);
  return markerLinePattern.test(content);
}

function readStopMessageStageMode(raw: unknown): 'on' | 'off' | 'auto' | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const value = (raw as Record<string, unknown>).stopMessageStageMode;
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'on' || normalized === 'off' || normalized === 'auto') {
    return normalized;
  }
  return undefined;
}

const STOP_MESSAGE_EXECUTION_DIRECTIVE = [
  '执行策略（必须遵守）：',
  '- 禁止输出口播式状态汇报（如“继续执行中”“我会继续”）。',
  '- 以当前上下文目标为准，优先推进可验证的工程动作，不要停留在任务管理操作。',
  '- 优先完成真实动作（改代码/补测试/运行验证），再做简短汇报。',
  '- 禁止连续执行纯只读/纯汇报动作（如 cargo llvm-cov report、cat/head/tail/rg/git status）；若上一轮没有代码修改证据，本轮必须先完成写动作（修改文件或新增测试）。',
  '- 覆盖率命令仅用于“写动作之后的验证”，不得作为本轮唯一或首要动作。',
  '- 任何阻塞等待任务都应优先用 clock.schedule 改成非阻塞推进；若预计等待达到或超过 3 分钟，必须立即设置定时，不得只口头说明等待。',
  '- 可为同一目标设置多次提醒，避免遗忘关键后续动作。',
  '- 对复杂等待任务，先把上下文、待办清单、下一步动作写入当前工作目录下的 clock.md；下次 clock 提醒触发时，优先读取 clock.md 再继续。',
  '- clock.md 必须按固定模板维护：## 背景 / ## 当前阻塞点 / ## 下次提醒要做的第一步 / ## 不能忘的检查项。',
  '- 若仅需汇报任务进度，必须按顺序：先调用 CONTINUE execution（continue_execution，参数示例 {"reason":"progress_update"}），再做 <=5 行简短汇报，然后立即继续执行。',
  '- 若遇阻塞，请按 JSON 输出结构化阻塞信息（type=blocked, summary, blocker, impact, next_action, evidence）。',
  '- 如果即将返回 finish_reason=stop 或协议等价 end_turn，先调用 continue_execution 工具，不要直接结束会话。',
  '- 仅当总体目标完成时，才允许停止。'
].join('\n');

const STOP_MESSAGE_AI_HISTORY_MAX = 8;
const STOP_MESSAGE_EXECUTION_APPEND = '请直接继续执行，不要进行状态汇总；优先写动作（改代码/补测试），覆盖率命令只用于写动作后的验证，不得连续只做汇报/只读检查；仅在完成一个阶段性任务或已完成总体目标时再停止并回复。';

function readStopMessageAiSeedPrompt(state: unknown): string {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return '';
  }
  const raw = (state as Record<string, unknown>).stopMessageAiSeedPrompt;
  return typeof raw === 'string' ? raw.trim() : '';
}

function readStopMessageAiHistory(state: unknown): StopMessageAiFollowupHistoryEntry[] {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return [];
  }
  const raw = (state as Record<string, unknown>).stopMessageAiHistory;
  if (!Array.isArray(raw)) {
    return [];
  }
  const normalized: StopMessageAiFollowupHistoryEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const item: StopMessageAiFollowupHistoryEntry = {};
    if (typeof record.ts === 'number' && Number.isFinite(record.ts)) {
      item.ts = Math.floor(record.ts);
    }
    if (typeof record.round === 'number' && Number.isFinite(record.round)) {
      item.round = Math.max(0, Math.floor(record.round));
    }
    for (const key of ['assistantText', 'reasoningText', 'responseExcerpt', 'followupText'] as const) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) {
        item[key] = value.trim();
      }
    }
    if (Object.keys(item).length > 0) {
      normalized.push(item);
    }
  }
  return normalized.slice(-STOP_MESSAGE_AI_HISTORY_MAX);
}

function appendStopMessageAiHistory(
  history: StopMessageAiFollowupHistoryEntry[],
  item: StopMessageAiFollowupHistoryEntry
): StopMessageAiFollowupHistoryEntry[] {
  const next = [...history, item].filter((entry) => entry && Object.keys(entry).length > 0);
  return next.slice(-STOP_MESSAGE_AI_HISTORY_MAX);
}

function enforceStopMessageExecutionFollowupText(text: string, doneMarker: string): string {
  const rawBase = sanitizeFollowupText(text);
  const marker = doneMarker && doneMarker.trim() ? doneMarker.trim() : '[STOPMESSAGE_DONE]';
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const markerLinePattern = new RegExp(`(^|\\n)\\s*${escapedMarker}\\s*(?=\\n|$)`, 'g');
  const strippedBase = rawBase.replace(markerLinePattern, '$1').replace(/\n{3,}/g, '\n\n').trim();
  const base = sanitizeFollowupText(strippedBase) || '继续执行';
  let next = base;
  if (!next.includes(STOP_MESSAGE_EXECUTION_APPEND)) {
    next = `${next}\n\n${STOP_MESSAGE_EXECUTION_APPEND}`;
  }
  return sanitizeFollowupText(next);
}

const handler: ServerToolHandler = async (
  ctx: ServerToolHandlerContext
): Promise<ServerToolHandlerPlan | null> => {
  const record = ctx.adapterContext as unknown as {
    clientDisconnected?: unknown;
    clientConnectionState?: unknown;
    sessionId?: unknown;
    conversationId?: unknown;
    providerProtocol?: unknown;
    providerKey?: unknown;
    providerId?: unknown;
    entryEndpoint?: unknown;
    metadata?: unknown;
    workdir?: unknown;
    cwd?: unknown;
    workingDirectory?: unknown;
  };
  const rt = readRuntimeMetadata(ctx.adapterContext as unknown as Record<string, unknown>);
  const compare: StopMessageCompareContext = {
    armed: false,
    mode: 'off',
    allowModeOnly: false,
    textLength: 0,
    maxRepeats: 0,
    used: 0,
    remaining: 0,
    active: false,
    stopEligible: false,
    hasCapturedRequest: false,
    compactionRequest: false,
    hasSeed: false,
    decision: 'skip',
    reason: 'handler_start'
  };

  const syncCompareRound = (): void => {
    const max = Number.isFinite(compare.maxRepeats) ? Math.max(0, Math.floor(compare.maxRepeats)) : 0;
    const used = Number.isFinite(compare.used) ? Math.max(0, Math.floor(compare.used)) : 0;
    compare.maxRepeats = max;
    compare.used = used;
    compare.remaining = max > 0 ? Math.max(0, max - used) : 0;
    compare.active =
      compare.armed &&
      compare.mode !== 'off' &&
      max > 0 &&
      (compare.textLength > 0 || compare.allowModeOnly);
  };

  const updateCompare = (patch: Partial<StopMessageCompareContext>): void => {
    Object.assign(compare, patch);
    syncCompareRound();
  };

  const markSkip = (reason: string, patch?: Partial<StopMessageCompareContext>): null => {
    updateCompare({
      decision: 'skip',
      reason,
      ...(patch || {})
    });
    return null;
  };

  debugLog('handler_start', {
    requestId: (record as { requestId?: unknown }).requestId as string | undefined,
    providerProtocol: (record as { providerProtocol?: unknown }).providerProtocol as string | undefined
  });

  try {
    const followupFlagRaw = (rt as any)?.serverToolFollowup;
    const followupFlowId = readServerToolFollowupFlowId(rt);
    const isFollowupRequest =
      followupFlagRaw === true ||
      (typeof followupFlagRaw === 'string' && followupFlagRaw.trim().toLowerCase() === 'true');
    // stop_message_flow followup is single-hop by design:
    // once one internal followup is sent, the next stop handling must wait for a new client request.
    if (isFollowupRequest) {
      debugLog('skip_followup_request', { followupFlowId } as JsonObject);
      return markSkip('skip_followup_request');
    }

    if (hasCompactionFlag(rt)) {
      debugLog('skip_compaction_flag');
      return markSkip('skip_compaction_flag');
    }

    const connectionState = resolveClientConnectionState(record.clientConnectionState);
    const strictSessionScope = resolveStopMessageSessionScope(record, rt);
    if (!strictSessionScope) {
      debugLog('skip_missing_session_scope');
      return markSkip('skip_missing_session_scope');
    }
    const stickyKey = strictSessionScope || resolveStickyKey(record, rt);
    let stickyState = stickyKey ? loadRoutingInstructionStateSync(stickyKey) : null;
    const runtimeStopMessageState = resolveRuntimeStopMessageState(rt);
    let snapshot = resolveStopMessageSnapshot(stickyState) ?? runtimeStopMessageState;
    const stickyMode = readStopMessageStageMode(stickyState);
    const runtimeMode = readRuntimeStopMessageStageMode(rt);
    const explicitMode = stickyMode ?? runtimeMode;
    if (!snapshot && explicitMode === 'off') {
      debugLog('skip_explicit_mode_off', { stickyKey } as JsonObject);
      return markSkip('skip_explicit_mode_off', {
        armed: true,
        mode: 'off',
        allowModeOnly: true,
        textLength: 0,
        maxRepeats: 0,
        used: 0
      });
    }
    if (!snapshot) {
      const implicit = STOPMESSAGE_IMPLICIT_GEMINI
        ? resolveImplicitGeminiStopMessageSnapshot(ctx, record)
        : null;
      const defaultSnapshot = STOPMESSAGE_DEFAULT_ENABLED
        ? resolveDefaultStopMessageSnapshot(ctx, {
            text: STOPMESSAGE_DEFAULT_TEXT,
            maxRepeats: STOPMESSAGE_DEFAULT_MAX_REPEATS
          })
        : null;
      const fallback = implicit
        ? {
            text: implicit.text,
            maxRepeats: implicit.maxRepeats,
            used: implicit.used,
            source: implicit.source,
            updatedAt: implicit.updatedAt,
            lastUsedAt: implicit.lastUsedAt,
            stageMode: 'on' as const
          }
        : defaultSnapshot
          ? {
              text: defaultSnapshot.text,
              maxRepeats: defaultSnapshot.maxRepeats,
              used: defaultSnapshot.used,
              source: defaultSnapshot.source,
              updatedAt: defaultSnapshot.updatedAt,
              lastUsedAt: defaultSnapshot.lastUsedAt,
              stageMode: 'on' as const
            }
          : null;
      if (!fallback) {
        if (!STOPMESSAGE_DEFAULT_ENABLED && !implicit) {
          debugLog('skip_default_disabled');
          return markSkip('skip_default_disabled', { armed: false, mode: 'off' });
        }
        debugLog('skip_no_stop_message_state');
        return markSkip('skip_no_stop_message_state', { armed: false, mode: 'off' });
      }
      snapshot = fallback;
      if (stickyKey) {
        stickyState = createStopMessageState(snapshot);
        persistStopMessageState(stickyKey, stickyState);
      }
    } else if (!stickyState && stickyKey && snapshot) {
      stickyState = createStopMessageState(snapshot);
      persistStopMessageState(stickyKey, stickyState);
    }

    const mode = snapshot.stageMode ?? 'on';
    if (mode === 'off') {
      debugLog('skip_explicit_mode_off', { stickyKey } as JsonObject);
      return markSkip('skip_explicit_mode_off', {
        armed: true,
        mode: 'off',
        allowModeOnly: true,
        textLength: 0,
        maxRepeats: 0,
        used: 0
      });
    }
    const text = typeof snapshot.text === 'string' ? snapshot.text.trim() : '';
    const maxRepeats =
      typeof snapshot.maxRepeats === 'number' && Number.isFinite(snapshot.maxRepeats)
        ? Math.max(1, Math.floor(snapshot.maxRepeats))
        : 0;
    const aiMode = snapshot.aiMode === 'on' ? 'on' : 'off';
    const used =
      typeof snapshot.used === 'number' && Number.isFinite(snapshot.used)
        ? Math.max(0, Math.floor(snapshot.used))
        : 0;
    updateCompare({
      armed: true,
      mode,
      allowModeOnly: false,
      textLength: text.length,
      maxRepeats,
      used
    });
    if (used >= maxRepeats) {
      if (stickyKey && stickyState) {
        clearStopMessageState(stickyState, Date.now());
        persistStopMessageState(stickyKey, stickyState);
      }
      debugLog('skip_reached_max_repeats', {
        stickyKey,
        used,
        maxRepeats
      } as JsonObject);
      return markSkip('skip_reached_max_repeats');
    }

    const injectReadyRaw = (rt as any)?.stopMessageClientInjectReady;
    const injectReadyExplicitlyFalse =
      injectReadyRaw === false ||
      (typeof injectReadyRaw === 'string' && injectReadyRaw.trim().toLowerCase() === 'false');
    if (injectReadyExplicitlyFalse) {
      const injectReason =
        typeof (rt as any)?.stopMessageClientInjectReason === 'string'
          ? String((rt as any).stopMessageClientInjectReason).trim()
          : '';
      if (stickyKey) {
        const nextState =
          stickyState ??
          createStopMessageState({
            text,
            maxRepeats,
            used,
            ...(snapshot.source ? { source: snapshot.source } : {}),
            ...(snapshot.updatedAt ? { updatedAt: snapshot.updatedAt } : {}),
            ...(snapshot.lastUsedAt ? { lastUsedAt: snapshot.lastUsedAt } : {}),
            ...(snapshot.stageMode ? { stageMode: snapshot.stageMode } : {}),
            aiMode
          });
        clearStopMessageState(nextState, Date.now());
        persistStopMessageState(stickyKey, nextState);
      }
      debugLog('skip_client_inject_unready', {
        stickyKey,
        injectReadyRaw: injectReadyRaw as unknown as string,
        injectReason
      } as JsonObject);
      const normalizedInjectReason =
        injectReason && /^[a-z0-9_:-]+$/i.test(injectReason) ? injectReason.toLowerCase() : 'unknown';
      return markSkip(`skip_client_inject_unready_${normalizedInjectReason}`);
    }

    const stopEligible = isStopEligibleForServerTool(ctx.base, ctx.adapterContext);
    updateCompare({ stopEligible });
    if (!stopEligible) {
      debugLog('skip_not_stop_finish_reason');
      return markSkip('skip_not_stop_finish_reason');
    }
    const autoResponseSnapshot = extractStopMessageAutoResponseSnapshot(ctx.base, ctx.adapterContext);
    const doneMarker = resolveStopMessageAiDoneMarker();
    const approvedMarker = resolveStopMessageAiApprovedMarker();
    const completionClaimedByMainModel =
      aiMode === 'on' && hasStopMessageDoneMarker(autoResponseSnapshot, doneMarker);

    const captured = getCapturedRequest(ctx.adapterContext);
    updateCompare({ hasCapturedRequest: Boolean(captured) });
    if (!captured) {
      debugLog('skip_no_captured_request');
      return markSkip('skip_no_captured_request');
    }

    const compactionRequest = isCompactionRequest(captured);
    updateCompare({ compactionRequest });
    if (compactionRequest) {
      debugLog('skip_compaction_request');
      return markSkip('skip_compaction_request');
    }

    const entryEndpoint = resolveEntryEndpoint(record);
    const seed = extractCapturedChatSeed(captured);
    updateCompare({ hasSeed: Boolean(seed) });
    if (!seed) {
      debugLog('skip_failed_build_followup');
      return markSkip('skip_failed_build_followup');
    }
    const historyStateCandidate = stickyState;
    const existingSeedPrompt = readStopMessageAiSeedPrompt(historyStateCandidate);
    const existingHistory = readStopMessageAiHistory(historyStateCandidate);
    const fallbackCandidateFollowupText = existingSeedPrompt || text || '继续执行';
    const isFirstPrompt = existingHistory.length === 0;
    let followupText = '';

    if (aiMode === 'on') {
      const aiFollowupText = renderStopMessageAutoFollowupViaAi({
        baseStopMessageText: text,
        candidateFollowupText: fallbackCandidateFollowupText,
        responseSnapshot: autoResponseSnapshot,
        requestId:
          typeof (record as { requestId?: unknown }).requestId === 'string'
            ? ((record as { requestId?: string }).requestId as string).trim()
            : undefined,
        sessionId:
          typeof record.sessionId === 'string'
            ? record.sessionId.trim()
            : undefined,
        workingDirectory: resolveBdWorkingDirectoryForRecord(record, rt),
        providerKey: resolveStopMessageFollowupProviderKey({ record, runtimeMetadata: rt }),
        model: typeof seed.model === 'string' ? seed.model : undefined,
        usedRepeats: used,
        maxRepeats,
        doneMarker,
        approvedMarker,
        completionClaimed: completionClaimedByMainModel,
        isFirstPrompt,
        historyEntries: existingHistory
      });
      if (aiFollowupText) {
        followupText = sanitizeFollowupText(aiFollowupText);
        debugLog('ai_followup_applied', {
          textLength: followupText.length
        } as JsonObject);
      } else {
        followupText = '继续执行';
        debugLog('ai_followup_fallback_to_continue_execution');
      }
    } else {
      followupText = sanitizeFollowupText(fallbackCandidateFollowupText);
      debugLog('fixed_followup_applied', { textLength: followupText.length } as JsonObject);
    }

    if (hasStopMessageMarkerLine(followupText, approvedMarker)) {
      if (stickyKey) {
        const nextState =
          stickyState ??
          createStopMessageState({
            text,
            maxRepeats,
            used,
            ...(snapshot.source ? { source: snapshot.source } : {}),
            ...(snapshot.updatedAt ? { updatedAt: snapshot.updatedAt } : {}),
            ...(snapshot.lastUsedAt ? { lastUsedAt: snapshot.lastUsedAt } : {}),
            ...(snapshot.stageMode ? { stageMode: snapshot.stageMode } : {}),
            aiMode
          });
        clearStopMessageState(nextState, Date.now());
        persistStopMessageState(stickyKey, nextState);
      }
      const approvedInjectText = typeof followupText === 'string' && sanitizeFollowupText(followupText)
        ? sanitizeFollowupText(followupText)
        : approvedMarker;
      debugLog('trigger_done_marker_approved', {
        stickyKey,
        doneMarker,
        approvedMarker
      } as JsonObject);
      updateCompare({
        decision: 'trigger',
        reason: 'done_marker_approved'
      });
      return {
        flowId: FLOW_ID,
        finalize: async () => ({
          chatResponse: ctx.base,
          execution: {
            flowId: FLOW_ID,
            followup: {
              requestIdSuffix: ':stop_followup',
              metadata: {
                ...(connectionState ? { clientConnectionState: connectionState as JsonObject } : {}),
                clientInjectOnly: true,
                clientInjectText: approvedInjectText,
                clientInjectSource: 'servertool.stop_message.done'
              } as JsonObject
            }
          }
        })
      };
    }

    if (aiMode === 'on') {
      followupText = enforceStopMessageExecutionFollowupText(followupText || '继续执行', doneMarker);
    } else {
      followupText = sanitizeFollowupText(followupText || '继续执行');
    }
    const nextHistory =
      aiMode === 'on'
        ? appendStopMessageAiHistory(existingHistory, {
            ts: Date.now(),
            round: used + 1,
            ...(autoResponseSnapshot.assistantText ? { assistantText: autoResponseSnapshot.assistantText } : {}),
            ...(autoResponseSnapshot.reasoningText ? { reasoningText: autoResponseSnapshot.reasoningText } : {}),
            ...(autoResponseSnapshot.responseExcerpt ? { responseExcerpt: autoResponseSnapshot.responseExcerpt } : {}),
            followupText
          })
        : [];
    const nextUsed = used + 1;
    updateCompare({ used: nextUsed });
    if (stickyKey) {
      const nextState =
        stickyState ??
        createStopMessageState({
          text,
          maxRepeats,
          used,
          ...(snapshot.source ? { source: snapshot.source } : {}),
          ...(snapshot.updatedAt ? { updatedAt: snapshot.updatedAt } : {}),
          ...(snapshot.lastUsedAt ? { lastUsedAt: snapshot.lastUsedAt } : {}),
          ...(snapshot.stageMode ? { stageMode: snapshot.stageMode } : {}),
          aiMode,
          aiSeedPrompt: fallbackCandidateFollowupText,
          aiHistory: existingHistory as Array<Record<string, unknown>>
        });
      const now = Date.now();
      if (nextUsed >= maxRepeats) {
        clearStopMessageState(nextState, now);
      } else {
        nextState.stopMessageText = text;
        nextState.stopMessageMaxRepeats = maxRepeats;
        nextState.stopMessageUsed = nextUsed;
        nextState.stopMessageStageMode = mode;
        nextState.stopMessageAiMode = aiMode;
        nextState.stopMessageLastUsedAt = now;
        nextState.stopMessageAiSeedPrompt = fallbackCandidateFollowupText;
        nextState.stopMessageAiHistory =
          aiMode === 'on' && nextHistory.length > 0
            ? nextHistory.map((entry) => ({ ...(entry as Record<string, unknown>) }))
            : undefined;
      }
      persistStopMessageState(stickyKey, nextState);
    }

    updateCompare({
      decision: 'trigger',
      reason: 'triggered'
    });

    // stop_message uses clientInjectOnly path only (tmux injection), no servertool followup reenter
    return {
      flowId: FLOW_ID,
      finalize: async () => ({
        chatResponse: ctx.base,
        execution: {
          flowId: FLOW_ID,
          followup: {
            requestIdSuffix: ':stop_followup',
            metadata: {
              ...(connectionState ? { clientConnectionState: connectionState as JsonObject } : {}),
              clientInjectOnly: true,
              clientInjectText: followupText,
              clientInjectSource: 'servertool.stop_message'
            } as JsonObject
          }
        }
      })
    };
  } finally {
    attachStopMessageCompareContext(ctx.adapterContext, compare);
  }
};

registerServerToolHandler('stop_message_auto', handler, { trigger: 'auto', hook: { phase: 'default', priority: 40 } });
