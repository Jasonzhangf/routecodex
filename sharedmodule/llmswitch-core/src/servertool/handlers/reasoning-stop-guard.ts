import type { JsonObject } from '../../conversion/hub/types/json.js';
import type { ServerToolHandler, ServerToolHandlerPlan } from '../types.js';
import { registerServerToolHandler } from '../registry.js';
import { readRuntimeMetadata } from '../../conversion/runtime-metadata.js';
import { isStopEligibleForServerTool } from '../stop-gateway-context.js';
import { cloneJson } from '../server-side-tools.js';
import {
  type ReasoningStopMode,
  clearReasoningStopState,
  readReasoningStopState,
  readReasoningStopFailCount,
  incrementReasoningStopFailCount,
  resetReasoningStopFailCount,
  readReasoningStopGuardTriggerCount,
  incrementReasoningStopGuardTriggerCount,
  resetReasoningStopGuardTriggerCount,
  syncReasoningStopModeFromRequest
} from './reasoning-stop-state.js';
import { appendLearningToMemory } from './memory-appender.js';
import { extractStopMessageAutoResponseSnapshot } from './stop-message-auto/ai-followup.js';
import { stripReasoningTransportNoise } from '../../conversion/shared/reasoning-normalizer.js';
import { readStopMessageCompareContext } from '../stop-message-compare-context.js';

const FLOW_ID_GUARD = 'reasoning_stop_guard_flow';
const FLOW_ID_FINALIZE = 'reasoning_stop_finalize_flow';
const FLOW_ID_CONTINUE = 'reasoning_stop_continue_flow';
const HOOK_ID = 'reasoning_stop_guard';
const ON_MODE_MAX_FAIL_COUNT = 5;
const GUARD_MAX_TRIGGER_COUNT = 3; // Storm protection: max guard triggers before auto-pass
const GUARD_TRIGGER_WINDOW_MS = 10000; // 10 seconds window for storm detection
const REASONING_STOP_FINALIZED_MARKER = '[app.finished:reasoning.stop]';
const REASONING_STOP_BLOCK_MARKER = '[reasoning.stop]';
const REASONING_STOP_ALLOWED_PREFIXES = [
  '用户任务目标:',
  '是否完成:',
  '完成证据:',
  '停止原因:',
  '下一步:',
  '需用户参与:',
  '用户问题:',
  '已穷尽可行尝试:',
  '穷尽所有尝试:',
  '无法完成原因:',
  '阻塞证据:',
  '经验沉淀:',
  '是否简单问题:',
  '简单问题:',
  '结束标记:'
] as const;

const ON_CONTINUE_TEXT =
  '禁止直接停止。你当前处于 reasoning.stop 模式。每次停止前必须调用 reasoning.stop 工具并提供以下信息：\n' +
  '- 是否完成: 是/否\n' +
  '- 停止原因(stop_reason): 可选。若当前是 plan mode / audit / 其他只读任务，且请求的交付物已经完成，可填 plan_mode\n' +
  '- 完成证据(completion_evidence): 如果任务完成，提供具体证据\n' +
  '- 未完成原因(cannot_complete_reason): 如果未完成，说明为什么\n' +
  '- 阻塞证据(blocking_evidence): 如果被阻塞，提供具体阻塞点\n' +
  '- 下一步(next_step): 你计划的下一步行动（如果有）\n' +
  '- 需用户参与(user_input_required): 是否需要用户参与才能继续\n' +
  '- 用户问题(user_question): 如果需要用户参与，具体问什么\n' +
  '你现在立即继续执行，不要停止。';

const ENDLESS_CONTINUE_TEXT =
  '你当前处于 stopless:endless 模式。默认必须继续执行，不要轻易停止。\n' +
  '只有满足以下任一条件才允许停止：\n' +
  'A. 任务已经完成，并提供 completion_evidence；\n' +
  'A2. 如果这是 plan mode / audit / 其他有意只读任务，且请求的交付物已完成，可在 is_completed=true 的同时设置 stop_reason=plan_mode；\n' +
  'B. 你已经穷尽所有可行尝试，且遇到不可抗阻塞：next_step 为空、attempts_exhausted=true、cannot_complete_reason 非空、blocking_evidence 非空；若必须用户参与，再额外提供 user_input_required=true 与 user_question。\n' +
  '只要还有任何可执行的 next_step，你就必须继续执行，不得停止。\n' +
  '你现在立即继续执行；只有在“已完成”或“不可抗阻塞”时才允许停止。';

function parseReasoningStopSummary(summary: string): {
  taskGoal: string;
  completed?: boolean;
  completionEvidence: string;
  stopReason?: string;
  nextStep: string;
  userInputRequired?: boolean;
  userQuestion: string;
  attemptsExhausted?: boolean;
  cannotCompleteReason: string;
  blockingEvidence: string;
 learning?: string;
  isSimpleQuestion?: boolean;
} {
  const normalized = typeof summary === 'string' ? summary.trim() : '';
  if (!normalized) {
    return {
      taskGoal: '',
      completionEvidence: '',
      nextStep: '',
      userQuestion: '',
      cannotCompleteReason: '',
      blockingEvidence: ''
    };
  }
  const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean);
  let taskGoal = '';
  let completed: boolean | undefined;
  let completionEvidence = '';
  let stopReason: string | undefined;
  let nextStep = '';
  let userInputRequired: boolean | undefined;
  let userQuestion = '';
  let attemptsExhausted: boolean | undefined;
  let cannotCompleteReason = '';
  let blockingEvidence = '';
  let learning = '';
  let isSimpleQuestion: boolean | undefined;
  for (const line of lines) {
    if (line.startsWith('用户任务目标:')) {
      taskGoal = line.slice('用户任务目标:'.length).trim();
      continue;
    }
    if (line.startsWith('是否完成:')) {
      const value = line.slice('是否完成:'.length).trim();
      if (value === '是') {
        completed = true;
      } else if (value === '否') {
        completed = false;
      }
      continue;
    }
    if (line.startsWith('完成证据:')) {
      completionEvidence = line.slice('完成证据:'.length).trim();
      continue;
    }
    if (line.startsWith('停止原因:')) {
      const value = line.slice('停止原因:'.length).trim();
      stopReason = value || undefined;
      continue;
    }
    if (line.startsWith('下一步:')) {
      nextStep = line.slice('下一步:'.length).trim();
      continue;
    }
    if (line.startsWith('需用户参与:')) {
      const value = line.slice('需用户参与:'.length).trim();
      if (value === '是') {
        userInputRequired = true;
      } else if (value === '否') {
        userInputRequired = false;
      }
      continue;
    }
    if (line.startsWith('用户问题:')) {
      userQuestion = line.slice('用户问题:'.length).trim();
      continue;
    }
    if (line.startsWith('已穷尽可行尝试:') || line.startsWith('穷尽所有尝试:')) {
      const prefix = line.startsWith('已穷尽可行尝试:') ? '已穷尽可行尝试:' : '穷尽所有尝试:';
      const value = line.slice(prefix.length).trim();
      if (value === '是') {
        attemptsExhausted = true;
      } else if (value === '否') {
        attemptsExhausted = false;
      }
      continue;
    }
    if (line.startsWith('无法完成原因:')) {
      cannotCompleteReason = line.slice('无法完成原因:'.length).trim();
      continue;
    }
    if (line.startsWith('阻塞证据:')) {
      blockingEvidence = line.slice('阻塞证据:'.length).trim();
      continue;
    }
   if (line.startsWith('经验沉淀:')) {
     learning = line.slice('经验沉淀:'.length).trim();
     continue;
   }
    if (line.startsWith('是否简单问题:') || line.startsWith('简单问题:')) {
      const prefix = line.startsWith('是否简单问题:') ? '是否简单问题:' : '简单问题:';
      const value = line.slice(prefix.length).trim();
      if (value === '是' || value === 'yes' || value === 'true') {
        isSimpleQuestion = true;
      } else if (value === '否' || value === 'no' || value === 'false') {
        isSimpleQuestion = false;
      }
      continue;
    }
  }
  return {
    taskGoal,
    completed,
    completionEvidence,
    stopReason,
    nextStep,
    userInputRequired,
    userQuestion,
    attemptsExhausted,
    cannotCompleteReason,
    blockingEvidence,
    learning,
    isSimpleQuestion
  };
}

function isIrrecoverablyBlockedStop(parsed: {
  nextStep: string;
  attemptsExhausted?: boolean;
  cannotCompleteReason: string;
  blockingEvidence: string;
  userInputRequired?: boolean;
  userQuestion: string;
}): boolean {
  if (parsed.nextStep) {
    return false;
  }
  if (parsed.attemptsExhausted !== true) {
    return false;
  }
  if (!parsed.cannotCompleteReason || !parsed.blockingEvidence) {
    return false;
  }
  if (parsed.userInputRequired === true && !parsed.userQuestion) {
    return false;
  }
  return true;
}

function isValidCompletedStop(parsed: {
  completed?: boolean;
  completionEvidence: string;
  userInputRequired?: boolean;
  userQuestion: string;
  nextStep: string;
  cannotCompleteReason: string;
  blockingEvidence: string;
}): boolean {
  if (parsed.completed !== true) {
    return false;
  }
  if (!parsed.completionEvidence) {
    return false;
  }
  if (parsed.userInputRequired === true) {
    return false;
  }
  if (parsed.userQuestion) {
    return false;
  }
  if (parsed.nextStep || parsed.cannotCompleteReason || parsed.blockingEvidence) {
    return false;
  }
  return true;
}

function buildExecuteNextStepText(nextStep: string): string {
  return [
    '你在上一轮 reasoning.stop 自查中给出了下一步计划。',
    `next_step: ${nextStep}`,
    '现在立即执行该 next_step，不要停止。',
    '只有满足以下任一条件才允许停止：A) 已完成任务并提供 completion_evidence；B) 已尝试完所有可行路径且阻塞，并提供 cannot_complete_reason + blocking_evidence（attempts_exhausted=true）。'
  ].join('\n');
}

function resolveGuardPromptByMode(mode: ReasoningStopMode): string {
  return mode === 'endless' ? ENDLESS_CONTINUE_TEXT : ON_CONTINUE_TEXT;
}

function buildReasoningStopFinalizedMarker(summary: string): string {
  const parsed = parseReasoningStopSummary(summary);
  const payload: Record<string, unknown> = {
    tool: 'reasoning.stop',
    completed: parsed.completed === true
  };
  if (parsed.taskGoal) {
    payload.task_goal = parsed.taskGoal;
  }
  if (parsed.completionEvidence) {
    payload.completion_evidence = parsed.completionEvidence;
  }
  if (parsed.stopReason) {
    payload.stop_reason = parsed.stopReason;
  }
  if (parsed.cannotCompleteReason) {
    payload.cannot_complete_reason = parsed.cannotCompleteReason;
  }
  if (parsed.blockingEvidence) {
    payload.blocking_evidence = parsed.blockingEvidence;
  }
  if (typeof parsed.attemptsExhausted === 'boolean') {
    payload.attempts_exhausted = parsed.attemptsExhausted;
  }
  if (typeof parsed.userInputRequired === 'boolean') {
    payload.user_input_required = parsed.userInputRequired;
  }
  if (parsed.userQuestion) {
    payload.user_question = parsed.userQuestion;
  }
  if (parsed.nextStep) {
    payload.next_step = parsed.nextStep;
  }
  return `${REASONING_STOP_FINALIZED_MARKER} ${JSON.stringify(payload)}`;
}

function buildReasoningStopFollowupOps(promptText: string): Array<Record<string, unknown>> {
  const ops: Array<Record<string, unknown>> = [
    { op: 'preserve_tools' },
    { op: 'ensure_standard_tools' }
  ];
  ops.push(
    { op: 'append_assistant_message', required: false },
    { op: 'append_user_text', text: promptText }
  );
  return ops;
}

function isReasoningStopGuardEnabled(): boolean {
  const envValue =
    process.env.LLMSWITCHCORE_REASONING_STOP_GUARD_ENABLED ??
    process.env.ROUTECODEX_REASONING_STOP_GUARD_ENABLED ??
    process.env.RCC_REASONING_STOP_GUARD_ENABLED;
  const normalized = typeof envValue === 'string' ? envValue.trim().toLowerCase() : '';
  if (normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'no') {
    return false;
  }
  return true;
}

function readFollowupClientInjectSource(adapterContext: unknown): string {
  if (!adapterContext || typeof adapterContext !== 'object' || Array.isArray(adapterContext)) {
    return '';
  }
  const record = adapterContext as Record<string, unknown>;
  const direct =
    typeof record.clientInjectSource === 'string' && record.clientInjectSource.trim().length
      ? record.clientInjectSource.trim()
      : '';
  if (direct) {
    return direct;
  }
  const rt = readRuntimeMetadata(record);
  const runtimeValue =
    rt && typeof (rt as Record<string, unknown>).clientInjectSource === 'string'
      ? String((rt as Record<string, unknown>).clientInjectSource).trim()
      : '';
  return runtimeValue;
}

function shouldSkipGuardForReasoningOnlyResponse(base: JsonObject, adapterContext: unknown): boolean {
  const choices = Array.isArray((base as any).choices) ? ((base as any).choices as unknown[]) : [];
  if (choices.length === 0) {
    return false;
  }
  const first = choices[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) {
    return false;
  }
  const message = (first as Record<string, unknown>).message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return false;
  }
  const content = (message as Record<string, unknown>).content;
  if (typeof content === 'string' && content.trim() === '') {
    return true;
  }
  return false;
}

function shouldDeferToStopMessageAuto(adapterContext: unknown): boolean {
  const stopCompare = readStopMessageCompareContext(adapterContext);
  if (!stopCompare) {
    return false;
  }
  return stopCompare.armed === true;
}

function collectAssistantTextCandidates(base: JsonObject): string[] {
  const out: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value !== 'string') {
      return;
    }
    const trimmed = value.trim();
    if (trimmed) {
      out.push(trimmed);
    }
  };

  const choices = Array.isArray((base as any).choices) ? ((base as any).choices as unknown[]) : [];
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object' || Array.isArray(choice)) {
      continue;
    }
    const message = (choice as Record<string, unknown>).message;
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      continue;
    }
    push((message as Record<string, unknown>).content);
  }

  const output = Array.isArray((base as any).output) ? ((base as any).output as unknown[]) : [];
  for (const item of output) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const row = item as Record<string, unknown>;
    const itemType = typeof row.type === 'string' ? row.type.trim().toLowerCase() : '';
    const role = typeof row.role === 'string' ? row.role.trim().toLowerCase() : '';
    if (itemType !== 'message' || role !== 'assistant') {
      continue;
    }
    const content = Array.isArray(row.content) ? row.content : [];
    for (const part of content) {
      if (!part || typeof part !== 'object' || Array.isArray(part)) {
        continue;
      }
      const record = part as Record<string, unknown>;
      push(record.text);
      push(record.output_text);
    }
  }

  push((base as any).output_text);
  return out;
}

function extractEmbeddedReasoningStopSummary(base: JsonObject): string {
  const candidates = collectAssistantTextCandidates(base);
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const text = candidates[i];
    const markerIndex = text.lastIndexOf(REASONING_STOP_BLOCK_MARKER);
    if (markerIndex < 0) {
      continue;
    }
    const block = text.slice(markerIndex + REASONING_STOP_BLOCK_MARKER.length);
    const lines = block
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) {
      continue;
    }
    const collected: string[] = [];
    for (const line of lines) {
      if (REASONING_STOP_ALLOWED_PREFIXES.some((prefix) => line.startsWith(prefix))) {
        collected.push(line);
        continue;
      }
      if (collected.length > 0) {
        break;
      }
    }
    if (collected.length > 0) {
      return collected.join('\n');
    }
  }
  return '';
}

export function appendReasoningStopSummaryToChatResponse(base: JsonObject, summary: string): JsonObject {
  const rawSummary = typeof summary === 'string' ? summary.trim() : '';
  const markerLine = rawSummary ? `结束标记: ${buildReasoningStopFinalizedMarker(rawSummary)}` : '';
  const normalizedSummary = rawSummary
    ? rawSummary.includes(REASONING_STOP_FINALIZED_MARKER)
      ? rawSummary
      : `${rawSummary}\n${markerLine}`
    : '';
  if (!normalizedSummary) {
    return base;
  }
  const cloned = cloneJson(base) as JsonObject;
  const block = `[reasoning.stop]\n${normalizedSummary}`;
  const choices = Array.isArray((cloned as any).choices) ? ((cloned as any).choices as unknown[]) : [];
  if (choices.length > 0) {
    const first = choices[0];
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      const message =
        (first as Record<string, unknown>).message &&
        typeof (first as Record<string, unknown>).message === 'object' &&
        !Array.isArray((first as Record<string, unknown>).message)
          ? ((first as Record<string, unknown>).message as Record<string, unknown>)
          : null;
      if (message) {
        const rawContent = typeof message.content === 'string' ? message.content.trim() : '';
        if (rawContent.includes(REASONING_STOP_FINALIZED_MARKER)) {
          return cloned;
        }
        message.content = rawContent ? `${rawContent}\n\n${block}` : block;
        return cloned;
      }
    }
  }
  const output = Array.isArray((cloned as any).output) ? ((cloned as any).output as unknown[]) : [];
  if (output.length > 0) {
    for (const item of output) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        continue;
      }
      const row = item as Record<string, unknown>;
      const itemType = typeof row.type === 'string' ? row.type.trim().toLowerCase() : '';
      const role = typeof row.role === 'string' ? row.role.trim().toLowerCase() : '';
      if (itemType !== 'message' || role !== 'assistant') {
        continue;
      }
      const content = Array.isArray(row.content) ? [...row.content] : [];
      const hasMarker = content.some((part) => {
        if (!part || typeof part !== 'object' || Array.isArray(part)) {
          return false;
        }
        const text = typeof (part as Record<string, unknown>).text === 'string'
          ? String((part as Record<string, unknown>).text)
          : typeof (part as Record<string, unknown>).output_text === 'string'
            ? String((part as Record<string, unknown>).output_text)
            : '';
        return text.includes(REASONING_STOP_FINALIZED_MARKER);
      });
      if (!hasMarker) {
        content.push({ type: 'output_text', text: block });
      }
      row.content = content;
      const outputText = typeof (cloned as any).output_text === 'string'
        ? String((cloned as any).output_text).trim()
        : '';
      (cloned as any).output_text = outputText ? `${outputText}\n\n${block}` : block;
      return cloned;
    }
  }
  const outputText = typeof (cloned as any).output_text === 'string' ? String((cloned as any).output_text).trim() : '';
  (cloned as any).output_text = outputText ? `${outputText}\n\n${block}` : block;
  return cloned;
}

function logReasoningStopFinalizedMarker(args: {
  requestId: string;
  mode: ReasoningStopMode;
  summary: string;
  reason:
    | 'completed'
    | 'blocked'
    | 'fail_count_exceeded'
    | 'finalized_fallback'
    | 'simple_question';
}): void {
  const marker = buildReasoningStopFinalizedMarker(args.summary);
  console.log(
    `[servertool][reasoning.stop.finalized] requestId=${args.requestId} mode=${args.mode} reason=${args.reason} marker=${marker}`
  );
}

  const handler: ServerToolHandler = async (ctx): Promise<ServerToolHandlerPlan | null> => {
  if (!isReasoningStopGuardEnabled()) {
    return null;
  }
  // Most servertool followups should bypass this guard to avoid recursion.
  // But reasoning_stop_guard / reasoning_stop_continue followups must re-enter
  // the guard/finalize logic; otherwise a second plain stop on the followup hop
  // is silently accepted as success.
  const rt = readRuntimeMetadata(ctx.adapterContext as unknown as Record<string, unknown>);
  const followupSource = readFollowupClientInjectSource(ctx.adapterContext);
  const allowReasoningStopFollowupReentry =
    followupSource === 'servertool.reasoning_stop_guard'
    || followupSource === 'servertool.reasoning_stop_continue';
  if ((rt as Record<string, unknown>)?.serverToolFollowup === true && !allowReasoningStopFollowupReentry) {
    return null;
  }

  const stoplessMode = syncReasoningStopModeFromRequest(ctx.adapterContext);
  if (stoplessMode === 'off') {
    return null;
  }
  // Storm protection: check if guard triggered too many times within window
  const { count: guardTriggerCount, lastTriggerAt: lastGuardTriggerAt } = readReasoningStopGuardTriggerCount(ctx.adapterContext);
  const now = Date.now();
  if (guardTriggerCount >= GUARD_MAX_TRIGGER_COUNT) {
    // Keep stopless contract authoritative: even during storms we may reset counters,
    // but we must not auto-pass a stop response that has not satisfied reasoning.stop.
    resetReasoningStopGuardTriggerCount(ctx.adapterContext);
  }
  // Increment guard trigger count
  incrementReasoningStopGuardTriggerCount(ctx.adapterContext);
  if (!isStopEligibleForServerTool(ctx.base, ctx.adapterContext)) {
    return null;
  }
  if (shouldSkipGuardForReasoningOnlyResponse(ctx.base, ctx.adapterContext)) {
    return null;
  }
  if (shouldDeferToStopMessageAuto(ctx.adapterContext)) {
    return null;
  }
  const stopState = readReasoningStopState(ctx.adapterContext);
    if (!stopState.armed) {
    return {
      flowId: FLOW_ID_GUARD,
      finalize: async () => ({
        chatResponse: ctx.base,
        execution: {
          flowId: FLOW_ID_GUARD,
          followup: {
              requestIdSuffix: ':reasoning_stop_guard',
              entryEndpoint: ctx.entryEndpoint,
              injection: {
              ops: buildReasoningStopFollowupOps(resolveGuardPromptByMode(stoplessMode))
              },
              metadata: {
                clientInjectSource: 'servertool.reasoning_stop_guard'
              }
          }
        }
      })
    };
  }

  return {
    flowId: FLOW_ID_FINALIZE,
    finalize: async () => {
      const freshSummary = extractEmbeddedReasoningStopSummary(ctx.base);
      const summary = freshSummary || stopState.summary;
      const parsed = parseReasoningStopSummary(summary);
      const canFinalizeCurrentTurn =
        !allowReasoningStopFollowupReentry || freshSummary.length > 0;
      
      if (stoplessMode === 'on') {
       if (canFinalizeCurrentTurn && isValidCompletedStop(parsed)) {
          // Allow stop for simple questions
          if (parsed.isSimpleQuestion === true) {
            const patched = appendReasoningStopSummaryToChatResponse(ctx.base, summary);
            logReasoningStopFinalizedMarker({
              requestId: ctx.requestId,
              mode: stoplessMode,
              summary,
              reason: 'simple_question'
            });
            clearReasoningStopState(ctx.adapterContext);
            resetReasoningStopFailCount(ctx.adapterContext);
            return {
              chatResponse: patched,
              execution: {
                flowId: FLOW_ID_FINALIZE,
                context: {
                  reasoning_stop: {
                    finalized: true,
                    simple_question: true
                  }
                }
              }
            };
          }
          const patched = appendReasoningStopSummaryToChatResponse(ctx.base, summary);
          logReasoningStopFinalizedMarker({
            requestId: ctx.requestId,
            mode: stoplessMode,
            summary,
            reason: 'completed'
          });
          clearReasoningStopState(ctx.adapterContext);

          if (parsed.learning) {
            try {
              appendLearningToMemory({ learning: parsed.learning, cwd: process.cwd() });
            } catch (e) {
              console.error("[reasoning-stop-guard] failed to append learning:", e);
            }
          }
          resetReasoningStopFailCount(ctx.adapterContext);
          return {
            chatResponse: patched,
            execution: {
              flowId: FLOW_ID_FINALIZE,
              context: {
                reasoning_stop: {
                  finalized: true,
                  completed: true
                }
              }
            }
          };
        }
        
        if (canFinalizeCurrentTurn && parsed.completed === false && isIrrecoverablyBlockedStop(parsed)) {
          const patched = appendReasoningStopSummaryToChatResponse(ctx.base, summary);
          logReasoningStopFinalizedMarker({
            requestId: ctx.requestId,
            mode: stoplessMode,
            summary,
            reason: 'blocked'
          });
          clearReasoningStopState(ctx.adapterContext);
          resetReasoningStopFailCount(ctx.adapterContext);
          return {
            chatResponse: patched,
            execution: {
              flowId: FLOW_ID_FINALIZE,
              context: {
                reasoning_stop: {
                  finalized: true,
                  attempts_exhausted: true,
                  blocked: true,
                  ...(parsed.userInputRequired === true ? { user_input_required: true } : {})
                }
              }
            }
          };
        }
        
        if (parsed.completed === false && parsed.nextStep) {
          incrementReasoningStopFailCount(ctx.adapterContext);
          return {
            chatResponse: ctx.base,
            execution: {
              flowId: FLOW_ID_CONTINUE,
              followup: {
                requestIdSuffix: ':reasoning_stop_continue',
                entryEndpoint: ctx.entryEndpoint,
                injection: {
                  ops: buildReasoningStopFollowupOps(buildExecuteNextStepText(parsed.nextStep))
                },
                metadata: {
                  clientInjectSource: 'servertool.reasoning_stop_continue'
                }
              }
            }
          };
        }
        
        incrementReasoningStopFailCount(ctx.adapterContext);
        return {
          chatResponse: ctx.base,
          execution: {
            flowId: FLOW_ID_GUARD,
            followup: {
              requestIdSuffix: ':reasoning_stop_guard',
              entryEndpoint: ctx.entryEndpoint,
              injection: {
                ops: buildReasoningStopFollowupOps(ON_CONTINUE_TEXT)
              },
              metadata: {
                clientInjectSource: 'servertool.reasoning_stop_guard'
              }
            }
          }
        };
      }
      
      if (stoplessMode === 'endless') {
        if (canFinalizeCurrentTurn && isValidCompletedStop(parsed)) {
          const patched = appendReasoningStopSummaryToChatResponse(ctx.base, summary);
          logReasoningStopFinalizedMarker({
            requestId: ctx.requestId,
            mode: stoplessMode,
            summary,
            reason: 'completed'
          });
          clearReasoningStopState(ctx.adapterContext);
          return {
            chatResponse: patched,
            execution: {
              flowId: FLOW_ID_FINALIZE,
              context: {
                reasoning_stop: {
                  finalized: true,
                  completed: true
                }
              }
            }
          };
        }
        
        if (canFinalizeCurrentTurn && isIrrecoverablyBlockedStop(parsed)) {
          const patched = appendReasoningStopSummaryToChatResponse(ctx.base, summary);
          logReasoningStopFinalizedMarker({
            requestId: ctx.requestId,
            mode: stoplessMode,
            summary,
            reason: 'blocked'
          });
          clearReasoningStopState(ctx.adapterContext);
          return {
            chatResponse: patched,
            execution: {
              flowId: FLOW_ID_FINALIZE,
              context: {
                reasoning_stop: {
                  finalized: true,
                  attempts_exhausted: true,
                  blocked: true,
                  ...(parsed.userInputRequired === true ? { user_input_required: true } : {})
                }
              }
            }
          };
        }
        
        if (parsed.nextStep) {
          return {
            chatResponse: ctx.base,
            execution: {
              flowId: FLOW_ID_CONTINUE,
              followup: {
                requestIdSuffix: ':reasoning_stop_continue',
                entryEndpoint: ctx.entryEndpoint,
                injection: {
                  ops: buildReasoningStopFollowupOps(buildExecuteNextStepText(parsed.nextStep))
                },
                metadata: {
                  clientInjectSource: 'servertool.reasoning_stop_continue'
                }
              }
            }
          };
        }
        
        return {
          chatResponse: ctx.base,
          execution: {
            flowId: FLOW_ID_GUARD,
            followup: {
              requestIdSuffix: ':reasoning_stop_guard',
              entryEndpoint: ctx.entryEndpoint,
              injection: {
                ops: buildReasoningStopFollowupOps(ENDLESS_CONTINUE_TEXT)
              },
              metadata: {
                clientInjectSource: 'servertool.reasoning_stop_guard'
              }
            }
          }
        };
      }
      
      const patched = appendReasoningStopSummaryToChatResponse(ctx.base, summary);
      logReasoningStopFinalizedMarker({
        requestId: ctx.requestId,
        mode: stoplessMode,
        summary,
        reason: 'finalized_fallback'
      });
      clearReasoningStopState(ctx.adapterContext);
      return {
        chatResponse: patched,
        execution: {
          flowId: FLOW_ID_FINALIZE,
          context: {
            reasoning_stop: {
              finalized: true
            }
          }
        }
      };
    }
  };
};

registerServerToolHandler(HOOK_ID, handler, {
  trigger: 'auto',
  hook: {
    phase: 'post',
    priority: 160
  }
});
