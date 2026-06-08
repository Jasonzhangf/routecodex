// Native bridge for servertool-core functions.
// Provides inspect_stop_gateway_signal, evaluate_loop_guard, calculate_budget.

import { readNativeFunction } from './native-shared-conversion-semantics-core.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface StopGatewayContext {
  observed: boolean;
  eligible: boolean;
  source: 'chat' | 'responses' | 'none';
  reason: string;
  choiceIndex?: number;
  hasToolCalls?: boolean;
}

export interface LoopGuardInput {
  started_at_ms?: number;
  stop_pair_repeat_count?: number;
  stop_pair_warned?: boolean;
  now_ms?: number;
  warn_threshold: number;
  fail_threshold: number;
}

export interface LoopGuardOutput {
  should_inject_warning: boolean;
  stop_pair_warned?: boolean;
  hit_limit: boolean;
  elapsed_ms: number;
  repeat_count: number;
}

export interface BudgetDecision {
  observed: boolean;
  stop_eligible: boolean;
  next_used: number;
  max_repeats: number;
}

export interface StopMessageCompareContext {
  armed: boolean;
  mode: 'off' | 'on' | 'auto';
  allowModeOnly: boolean;
  textLength: number;
  maxRepeats: number;
  used: number;
  remaining: number;
  active: boolean;
  stopEligible: boolean;
  hasCapturedRequest: boolean;
  compactionRequest: boolean;
  hasSeed: boolean;
  decision: 'trigger' | 'skip';
  reason: string;
  stage?: string;
  bdWorkState?: string;
  observationHash?: string;
  observationStableCount?: number;
  toolSignatureHash?: string;
}

export interface BudgetSnapshot {
  text: string;
  max_repeats: number;
  used: number;
  source: string;
}

export interface DefaultBudgetConfig {
  enabled: boolean;
  text: string;
  max_repeats: number;
  is_non_active_managed_goal: boolean;
}

export interface ClientExecCliProjectionInput {
  toolName: string;
  flowId?: string;
  input?: unknown;
  repeatCount?: number;
  maxRepeats?: number;
}

export interface ClientExecCliProjectionOutput {
  toolName: string;
  flowId: string;
  execCommand: string;
  continuationPrompt?: string;
  repeatCount?: number;
  maxRepeats?: number;
  schemaGuidance?: unknown;
}

export interface ServertoolBackendRoutePolicyInput {
  toolName: string;
  flowId?: string;
  input?: unknown;
  entryEndpoint?: string;
}

export interface ServertoolBackendRoutePolicyOutput {
  toolName: string;
  flowId: string;
  routeHint: string;
  executionMode: 'reenter';
  shapeGuard: {
    allowRequiresAction: boolean;
    preserveStreaming: boolean;
    failOnMissingPayload: boolean;
  };
  originDelta: {
    requiresOriginSeed: boolean;
    applyAssistantDelta: boolean;
  };
  finalize: {
    contextDecorationMode?: string;
    shortCircuitRequiresAction: boolean;
  };
  input: unknown;
}

// ── Stop gateway context ────────────────────────────────────────────────────

export function inspectStopGatewaySignalWithNative(payload: unknown): StopGatewayContext {
  const capability = 'inspectStopGatewaySignal';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('inspectStopGatewaySignal native unavailable');
  }
  const payloadJson = JSON.stringify(payload);
  const resultJson = fn(payloadJson);
  if (typeof resultJson !== 'string') {
    throw new Error(`inspectStopGatewaySignal native returned non-string: ${typeof resultJson}`);
  }
  const raw = JSON.parse(resultJson);
  return {
    observed: raw.observed,
    eligible: raw.eligible,
    source: raw.source,
    reason: raw.reason,
    ...(raw.choice_index !== undefined && raw.choice_index !== null ? { choiceIndex: raw.choice_index } : {}),
    ...(raw.has_tool_calls !== undefined && raw.has_tool_calls !== null ? { hasToolCalls: raw.has_tool_calls } : {}),
  };
}

// ── Loop guard ──────────────────────────────────────────────────────────────

export function evaluateLoopGuardWithNative(input: LoopGuardInput): LoopGuardOutput {
  const capability = 'evaluateLoopGuard';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('evaluateLoopGuard native unavailable');
  }
  const inputJson = JSON.stringify(input);
  const resultJson = fn(inputJson);
  if (typeof resultJson !== 'string') {
    throw new Error(`evaluateLoopGuard native returned non-string: ${typeof resultJson}`);
  }
  return JSON.parse(resultJson);
}

// ── Budget counter ──────────────────────────────────────────────────────────

export function calculateBudgetWithNative(
  observed: boolean,
  stop_eligible: boolean,
  snapshot: BudgetSnapshot | undefined,
  default_config: DefaultBudgetConfig | undefined,
): BudgetDecision {
  const capability = 'calculateBudget';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('calculateBudget native unavailable');
  }
  const resultJson = fn(
    observed,
    stop_eligible,
    snapshot ? JSON.stringify(snapshot) : undefined,
    default_config ? JSON.stringify(default_config) : undefined,
  );
  if (typeof resultJson !== 'string') {
    throw new Error(`calculateBudget native returned non-string: ${typeof resultJson}`);
  }
  return JSON.parse(resultJson);
}

export function buildClientExecCliProjectionOutputWithNative(
  input: ClientExecCliProjectionInput,
): ClientExecCliProjectionOutput {
  const capability = 'buildClientExecCliProjectionOutputJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('buildClientExecCliProjectionOutputJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`buildClientExecCliProjectionOutputJson native returned non-string: ${typeof resultJson}`);
  }
  return JSON.parse(resultJson);
}

export function validateClientExecCommandResultWithNative(rawOutput: string): Record<string, unknown> {
  const capability = 'validateClientExecCommandResultJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('validateClientExecCommandResultJson native unavailable');
  }
  const resultJson = fn(rawOutput);
  if (typeof resultJson !== 'string') {
    throw new Error(`validateClientExecCommandResultJson native returned non-string: ${typeof resultJson}`);
  }
  return JSON.parse(resultJson) as Record<string, unknown>;
}

export function planServertoolBackendRoutePolicyWithNative(
  input: ServertoolBackendRoutePolicyInput,
): ServertoolBackendRoutePolicyOutput {
  const capability = 'planServertoolBackendRoutePolicyJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolBackendRoutePolicyJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolBackendRoutePolicyJson native returned non-string: ${typeof resultJson}`);
  }
  return JSON.parse(resultJson) as ServertoolBackendRoutePolicyOutput;
}
