// Native bridge for followup-core helper functions.

import { readNativeFunction } from './native-shared-conversion-semantics-core.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface LoopWarningInput {
  messages: Array<{ role: string; content: string }>;
  repeat_count: number;
  warn_threshold: number;
  fail_threshold: number;
}

export interface BudgetResetDecision {
  should_reset: boolean;
  next_used: number;
}

export interface FollowupFlowDecision {
  flowId?: string;
  outcomeMode: 'skip' | 'client_inject_only' | 'reenter';
  noFollowup: boolean;
  autoLimit: boolean;
  flowOnlyLoopLimit: boolean;
  clientInjectOnly: boolean;
  clearStateOnFollowupFailure: boolean;
  seedLoopPayload: boolean;
  clientInjectSource?: string;
  transparentReplayRequestSuffix?: string;
  ignoreRequiresActionFollowup: boolean;
  contextDecorationMode?: 'continue_execution_summary' | 'web_search_summary';
}

function requireNativeFunction(capability: string): (...args: unknown[]) => unknown {
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error(`native ${capability} is required`);
  }
  return fn;
}

function parseNativeJson(capability: string, raw: unknown): unknown {
  if (typeof raw !== 'string') {
    throw new Error(`native ${capability} returned non-string: ${typeof raw}`);
  }
  return JSON.parse(raw) as unknown;
}

function assertLoopWarningMessages(
  capability: string,
  parsed: unknown
): Array<{ role: string; content: string }> {
  if (!Array.isArray(parsed)) {
    throw new Error(`native ${capability} returned non-array messages`);
  }
  for (const [index, item] of parsed.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`native ${capability} returned invalid message at index ${index}`);
    }
    const record = item as Record<string, unknown>;
    if (typeof record.role !== 'string' || typeof record.content !== 'string') {
      throw new Error(`native ${capability} returned invalid message fields at index ${index}`);
    }
  }
  return parsed as Array<{ role: string; content: string }>;
}

function assertBudgetResetDecision(capability: string, parsed: unknown): BudgetResetDecision {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`native ${capability} returned non-object decision`);
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.should_reset !== 'boolean') {
    throw new Error(`native ${capability} returned invalid should_reset`);
  }
  if (!Number.isInteger(record.next_used) || (record.next_used as number) < 0) {
    throw new Error(`native ${capability} returned invalid next_used`);
  }
  return {
    should_reset: record.should_reset,
    next_used: record.next_used as number
  };
}

// ── Followup request ID builder ─────────────────────────────────────────────

export function buildFollowupRequestIdWithNative(base: string, suffix?: string | null): string {
  const capability = 'buildFollowupRequestId';
  const fn = requireNativeFunction(capability);
  const result = fn(base, suffix ?? null);
  if (typeof result !== 'string') {
    throw new Error(`native ${capability} returned non-string: ${typeof result}`);
  }
  return result;
}

// ── Loop warning injector ───────────────────────────────────────────────────

export function injectLoopWarningWithNative(input: LoopWarningInput): Array<{ role: string; content: string }> {
  const capability = 'injectLoopWarningJson';
  const fn = requireNativeFunction(capability);
  const inputJson = JSON.stringify(input);
  return assertLoopWarningMessages(capability, parseNativeJson(capability, fn(inputJson)));
}

// ── Budget reset decision ───────────────────────────────────────────────────

export function decideBudgetResetWithNative(
  stopObserved: boolean,
  stopEligible: boolean,
  currentUsed: number
): BudgetResetDecision {
  const capability = 'decideBudgetResetJson';
  const fn = requireNativeFunction(capability);
  return assertBudgetResetDecision(capability, parseNativeJson(
    capability,
    fn(stopObserved, stopEligible, currentUsed)
  ));
}

// ── Skeleton config types ───────────────────────────────────────────────────
// Truth source: servertool_skeleton_config.rs (Rust).

export type ServertoolTriggerMode = 'tool_call' | 'auto';
export type ServertoolAutoHookPhase = 'pre' | 'default' | 'post';
export type ServertoolExecutionMode =
  | 'guarded'
  | 'client_inject_only'
  | 'auto_hook'
  | 'reenter'
  | 'backend'
  | 'passthrough';

export interface ServertoolSkeletonStageConfig {
  enabled: boolean;
  requireFinalizedMarker?: boolean;
}

export interface ServertoolSkeletonConfig {
  requestPrepare: ServertoolSkeletonStageConfig;
  internalDispatch: ServertoolSkeletonStageConfig;
  finalizeStrip: ServertoolSkeletonStageConfig;
  autoHooks: { optionalPrimaryOrder: string[]; mandatoryOrder: string[] };
  pendingInjection: { messageKinds: string[] };
  progress: {
    toolNameByFlowId: Record<string, string>;
    goldHighlightFlowIds: string[];
  };
  followup: {
    genericInjectionOps: string[];
    nativeSupportedOps: string[];
    flowPolicy: {
      profilesByFlowId: Record<string, {
        noFollowup?: boolean;
        autoLimit?: boolean;
        flowOnlyLoopLimit?: boolean;
        clientInjectOnly?: boolean;
        clearStateOnFollowupFailure?: boolean;
        seedLoopPayload?: boolean;
        clientInjectSource?: string;
        transparentReplayRequestSuffix?: string;
        ignoreRequiresActionFollowup?: boolean;
        contextDecorationMode?: 'continue_execution_summary' | 'web_search_summary';
      }>;
    };
  };
}

export interface ServertoolStateConfig {
  scopePriority: string[];
  pendingInjection: { enabled: boolean; strictContract: boolean };
}

export interface ServertoolToolSpec {
  name: string;
  enabled: boolean;
  kind: 'internal';
  trigger: {
    type: ServertoolTriggerMode;
    canonicalName: string;
    phase?: ServertoolAutoHookPhase;
    priority?: number;
  };
  execution: { mode: ServertoolExecutionMode; stripAfterExecute: boolean };
}

export interface ServertoolSkeletonDocument {
  version: 1;
  servertool: {
    enabled: boolean;
    internalTools: Record<string, ServertoolToolSpec>;
    skeleton: ServertoolSkeletonConfig;
    state: ServertoolStateConfig;
  };
}

export interface ServerToolHandlerRegistrationSpec {
  name: string;
  enabled: boolean;
  trigger: ServertoolTriggerMode;
  executionMode: ServertoolExecutionMode;
  stripAfterExecute: boolean;
  autoHook?: {
    id: string;
    phase: ServertoolAutoHookPhase;
    priority: number;
  };
}

export interface ServerToolRegisteredHandlerRecord {
  registration: ServerToolHandlerRegistrationSpec;
  handler?: (...args: unknown[]) => unknown;
}
