import path from 'node:path';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const nativeBinding = nodeRequire(
  path.resolve(process.cwd(), 'sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node')
) as Record<string, unknown>;

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

export type StopSchemaGateDecision = {
  action: 'allow_stop' | 'followup' | 'fail_fast';
  reason_code: string;
  summary_prefix?: string;
  followup_text?: string;
  count_budget?: boolean;
  no_change_count?: number;
  observation_hash?: string;
  max_repeats?: number;
  missing_fields?: string[];
  parsed?: Record<string, unknown>;
};

function nativeFn(name: string): (...args: unknown[]) => unknown {
  const fn = nativeBinding[name];
  if (typeof fn !== 'function') {
    throw new Error(`${name} native export is required`);
  }
  return fn as (...args: unknown[]) => unknown;
}

function parseNativeJson<T>(raw: unknown, capability: string): T {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`${capability} returned invalid payload`);
  }
  return JSON.parse(raw) as T;
}

export function decideStopMessageActionDirectNative(
  ctx: StopMessageDecisionContext
): StopMessageDecision {
  return parseNativeJson<StopMessageDecision>(
    nativeFn('decideStopMessageAction')(JSON.stringify(ctx)),
    'decideStopMessageAction'
  );
}

export function evaluateStopSchemaGateDirectNative(args: {
  assistantText: string;
  reasoningStopArguments?: string;
  used: number;
  maxRepeats: number;
  prevObservationHash?: string;
  prevNoChangeCount?: number;
}): StopSchemaGateDecision {
  return parseNativeJson<StopSchemaGateDecision>(
    nativeFn('evaluateStopSchemaGateJson')(
      args.assistantText,
      args.used,
      args.maxRepeats,
      args.prevObservationHash ?? '',
      args.prevNoChangeCount ?? 0,
      typeof args.reasoningStopArguments === 'string' && args.reasoningStopArguments.trim()
        ? args.reasoningStopArguments
        : undefined
    ),
    'evaluateStopSchemaGateJson'
  );
}
