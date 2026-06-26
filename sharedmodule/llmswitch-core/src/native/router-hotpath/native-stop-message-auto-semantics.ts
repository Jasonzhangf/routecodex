/**
 * Native bridge for stop-message-core decision engine.
 *
 * Types defined inline — no self-import.
 *
 * NOTE: All functions in this file are kept for type re-export only.
 * The actual implementation now calls the Rust NAPI entry points directly.
 * This file preserves the exported TypeScript types that are used by
 * stop-message-auto.ts and other TS consumers.
 */

import { readNativeFunction } from './native-shared-conversion-semantics-core.js';
import { failNativeRequired } from './native-router-hotpath-policy.js';
import type { ServerToolFollowupPlan } from '../../servertool/types.js';

// ── Types (re-exported for TS consumers) ─────────────────────────────────────

export type StageMode = 'on' | 'off' | 'auto';
export type SnapshotSource = 'persisted' | 'default' | 'implicit_gemini';
export type DecisionAction = 'skip' | 'trigger';

export interface StopMessageSnapshot {
  text: string;
  provider_key?: string;
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
  has_responses_submit_tool_outputs_resume: boolean;
  persisted_snapshot?: StopMessageSnapshot;
  runtime_snapshot?: StopMessageSnapshot;
  persisted_default_exhausted: boolean;
  explicit_mode?: StageMode;
  plan_mode_active: boolean;
  default_enabled: boolean;
  default_max_repeats: number;
  default_text: string;
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

// ── Native bridge (kept for TS callers that have not yet migrated) ──────────

export type StopSchemaGateDecision = {
  action: 'allow_stop' | 'followup' | 'fail_fast';
  reason_code: string;
  reasonCode?: string;
  summary_prefix?: string;
  summaryPrefix?: string;
  followup_text?: string;
  followupText?: string;
  count_budget?: boolean;
  countBudget?: boolean;
  no_change_count?: number;
  noChangeCount?: number;
  observation_hash?: string;
  observationHash?: string;
  max_repeats?: number;
  maxRepeats?: number;
  missing_fields?: string[];
  missingFields?: string[];
  parsed?: Record<string, unknown>;
};

export type StoplessLoopGuardDecision = {
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
  followupFlowId?: string;
  candidateKeys?: string[];
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
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as StopMessageHandlerResult;
    }
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
  reasoningStopArguments?: string;
  used: number;
  maxRepeats: number;
  prevObservationHash?: string;
  prevNoChangeCount?: number;
}): StopSchemaGateDecision {
  const capability = 'evaluateStopSchemaGateJson';
  const fail = (reason?: string) => failNativeRequired<StopSchemaGateDecision>(capability, reason);
  try {
    const fn = readNativeFunction(capability);
    if (!fn) {
      return fail('native_unavailable');
    }
    const raw = fn(
      args.assistantText,
      args.used,
      args.maxRepeats,
      args.prevObservationHash ?? '',
      args.prevNoChangeCount ?? 0,
      typeof args.reasoningStopArguments === 'string' && args.reasoningStopArguments.trim()
        ? args.reasoningStopArguments
        : undefined
    );
    if (typeof raw !== 'string') {
      return fail(`native_returned_non_string: ${typeof raw}`);
    }
    const parsed = JSON.parse(raw) as StopSchemaGateDecision & Record<string, unknown>;
    const normalized: StopSchemaGateDecision = {
      ...parsed,
      reason_code: String(parsed.reason_code ?? parsed.reasonCode ?? ''),
      ...(typeof (parsed.summary_prefix ?? parsed.summaryPrefix) === 'string'
        ? {
            summary_prefix: String(parsed.summary_prefix ?? parsed.summaryPrefix),
            summaryPrefix: String(parsed.summary_prefix ?? parsed.summaryPrefix)
          }
        : {}),
      ...(typeof (parsed.followup_text ?? parsed.followupText) === 'string'
        ? {
            followup_text: String(parsed.followup_text ?? parsed.followupText),
            followupText: String(parsed.followup_text ?? parsed.followupText)
          }
        : {}),
      ...(typeof (parsed.count_budget ?? parsed.countBudget) === 'boolean'
        ? {
            count_budget: Boolean(parsed.count_budget ?? parsed.countBudget),
            countBudget: Boolean(parsed.count_budget ?? parsed.countBudget)
          }
        : {}),
      ...(typeof (parsed.no_change_count ?? parsed.noChangeCount) === 'number'
        ? {
            no_change_count: Number(parsed.no_change_count ?? parsed.noChangeCount),
            noChangeCount: Number(parsed.no_change_count ?? parsed.noChangeCount)
          }
        : {}),
      ...(typeof (parsed.observation_hash ?? parsed.observationHash) === 'string'
        ? {
            observation_hash: String(parsed.observation_hash ?? parsed.observationHash),
            observationHash: String(parsed.observation_hash ?? parsed.observationHash)
          }
        : {}),
      ...(typeof (parsed.max_repeats ?? parsed.maxRepeats) === 'number'
        ? {
            max_repeats: Number(parsed.max_repeats ?? parsed.maxRepeats),
            maxRepeats: Number(parsed.max_repeats ?? parsed.maxRepeats)
          }
        : {}),
      ...(Array.isArray(parsed.missing_fields ?? parsed.missingFields)
        ? {
            missing_fields: [...((parsed.missing_fields ?? parsed.missingFields) as unknown[])]
              .map((value) => String(value)),
            missingFields: [...((parsed.missing_fields ?? parsed.missingFields) as unknown[])]
              .map((value) => String(value))
          }
        : {})
    };
    return normalized;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function evaluateStoplessLoopGuardWithNative(args: {
  capturedRequest: Record<string, unknown>;
  assistantText: string;
  threshold?: number;
}): StoplessLoopGuardDecision {
  const capability = 'evaluateStoplessLoopGuardJson';
  const fail = (reason?: string) => failNativeRequired<StoplessLoopGuardDecision>(capability, reason);
  try {
    const fn = readNativeFunction(capability);
    if (!fn) {
      return fail('native_unavailable');
    }
    const raw = fn(JSON.stringify(args));
    if (typeof raw !== 'string') {
      return fail(`native_returned_non_string: ${typeof raw}`);
    }
    return JSON.parse(raw) as StoplessLoopGuardDecision;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

// ── Internal types ──────────────────────────────────────────────────────────

type StopMessageHandlerResult = {
  chatResponse: Record<string, unknown>;
  flowId: string;
  followup: ServerToolFollowupPlan | null;
  stoplessRuntimeState: Record<string, unknown> | null;
};
