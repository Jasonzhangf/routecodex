// Native bridge for stop-message-core decision engine.
// Types defined inline — no self-import.

import { readNativeFunction } from './native-shared-conversion-semantics-core.js';
import { failNativeRequired } from './native-router-hotpath-policy.js';

// ── Types ───────────────────────────────────────────────────────────────────

export type StageMode = 'on' | 'off' | 'auto';
export type SnapshotSource = 'persisted' | 'default' | 'implicit_gemini';
export type GoalStatus = 'idle' | 'active' | 'paused' | 'stopped' | 'completed';
export type DecisionAction = 'skip' | 'trigger';

export interface StopMessageSnapshot {
  text: string;
  max_repeats: number;
  used: number;
  source: SnapshotSource;
  stage_mode: StageMode;
}

export interface ProviderPin {
  provider_key?: string;
  model_id?: string;
  routecodex_port_mode?: string;
}

export interface StopMessageDecisionContext {
  port_stop_message_disabled: boolean;
  followup_flow_id?: string;
  stop_eligible: boolean;
  finish_reasons?: string[];
  has_responses_submit_tool_outputs_resume: boolean;
  persisted_snapshot?: StopMessageSnapshot;
  runtime_snapshot?: StopMessageSnapshot;
  persisted_default_exhausted: boolean;
  explicit_mode?: StageMode;
  goal_status: GoalStatus;
  plan_mode_active: boolean;
  default_enabled: boolean;
  default_max_repeats: number;
  default_text: string;
  empty_reply_continue_local: boolean;
  provider_pin?: ProviderPin;
}

export interface StopMessageDecision {
  action: DecisionAction;
  skip_reason?: string;
  used: number;
  max_repeats: number;
  followup_text?: string;
  provider_pin?: ProviderPin;
}

// ── Fallback ────────────────────────────────────────────────────────────────

function fallbackSkip(reason: string): StopMessageDecision {
  return { action: 'skip', skip_reason: reason, used: 0, max_repeats: 0 };
}

// ── Native bridge ───────────────────────────────────────────────────────────

type StopMessageHandlerResult = {
  chatResponse: Record<string, unknown>;
  flowId: string;
  followup: Record<string, unknown> | null;
  persistKeys: string[];
  stateUpdate: Record<string, unknown> | null;
};

export type StopSchemaGateDecision = {
  action: 'allow_stop' | 'followup' | 'fail_fast';
  reason_code: string;
  summary_prefix?: string;
  followup_text?: string;
  count_budget?: boolean;
  max_repeats?: number;
  parsed?: Record<string, unknown>;
};

export type GoalActiveStopLoopDecision = {
  loopDetected: boolean;
  repeatCount: number;
  threshold: number;
  goalContextCount: number;
  reasonCode: string;
};

export function runStopMessageAutoHandlerWithNative(input: {
  decision: StopMessageDecision;
  adapterContext: Record<string, unknown>;
  base: Record<string, unknown>;
  candidateKeys: string[];
  stickyKey?: string;
  strictSessionScope?: string;
  followupFlowId?: string;
}): StopMessageHandlerResult {
  const capability = 'runStopMessageAutoHandlerJson';
  const fail = (reason?: string) => failNativeRequired<StopMessageHandlerResult>(capability, reason);
  try {
    const fn = readNativeFunction(capability);
    if (!fn) {
      return fail('native_unavailable');
    }
    const inputJson = JSON.stringify(input);
    const raw = fn(inputJson);
    if (typeof raw !== 'string') {
      return fail(`native_returned_non_string: ${typeof raw}`);
    }
    const parsed = JSON.parse(raw) as StopMessageHandlerResult;
    return parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function decideStopMessageActionWithNative(ctx: StopMessageDecisionContext): StopMessageDecision {
  const capability = 'decideStopMessageAction';
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fallbackSkip('native_unavailable');
  }
  const inputJson = JSON.stringify(ctx);
  const resultJson = fn(inputJson);
  if (typeof resultJson !== 'string') {
    return fallbackSkip(`native_returned_non_string: ${typeof resultJson}`);
  }
  try {
    return JSON.parse(resultJson) as StopMessageDecision;
  } catch {
    return fallbackSkip('native_parse_failed');
  }
}

export function evaluateStopSchemaGateWithNative(args: {
  assistantText: string;
  used: number;
  maxRepeats: number;
}): StopSchemaGateDecision {
  const capability = 'evaluateStopSchemaGateJson';
  const fail = (reason?: string) => failNativeRequired<StopSchemaGateDecision>(capability, reason);
  try {
    const fn = readNativeFunction(capability);
    if (!fn) {
      return fail('native_unavailable');
    }
    const raw = fn(args.assistantText, args.used, args.maxRepeats);
    if (typeof raw !== 'string') {
      return fail(`native_returned_non_string: ${typeof raw}`);
    }
    return JSON.parse(raw) as StopSchemaGateDecision;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function evaluateGoalActiveStopLoopGuardWithNative(args: {
  capturedRequest: Record<string, unknown>;
  assistantText: string;
  threshold?: number;
}): GoalActiveStopLoopDecision {
  const capability = 'evaluateGoalActiveStopLoopGuardJson';
  const fail = (reason?: string) => failNativeRequired<GoalActiveStopLoopDecision>(capability, reason);
  try {
    const fn = readNativeFunction(capability);
    if (!fn) {
      return fail('native_unavailable');
    }
    const raw = fn(JSON.stringify(args));
    if (typeof raw !== 'string') {
      return fail(`native_returned_non_string: ${typeof raw}`);
    }
    return JSON.parse(raw) as GoalActiveStopLoopDecision;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
