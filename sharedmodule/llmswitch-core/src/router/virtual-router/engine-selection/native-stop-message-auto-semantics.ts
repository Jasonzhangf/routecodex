// Native bridge for stop-message-core decision engine.
// Types defined inline — no self-import.

import { readNativeFunction } from './native-shared-conversion-semantics-core.js';

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
  has_responses_submit_tool_outputs_resume: boolean;
  persisted_snapshot?: StopMessageSnapshot;
  runtime_snapshot?: StopMessageSnapshot;
  persisted_default_exhausted: boolean;
  explicit_mode?: StageMode;
  goal_status: GoalStatus;
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
