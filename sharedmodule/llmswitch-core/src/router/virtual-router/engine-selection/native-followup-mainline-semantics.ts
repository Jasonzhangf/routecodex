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
  retryEmptyFollowupOnce: boolean;
  stopMessageFollowupPolicy: 'preserve_eligibility' | 'disable';
  clientInjectSource?: string;
  transparentReplayRequestSuffix?: string;
  ignoreRequiresActionFollowup: boolean;
  contextDecorationMode?: 'continue_execution_summary' | 'web_search_summary';
}

// ── Followup request ID builder ─────────────────────────────────────────────

export function buildFollowupRequestIdWithNative(base: string, suffix?: string | null): string {
  const capability = 'buildFollowupRequestId';
  const fn = readNativeFunction(capability);
  if (!fn) {
    // Fallback: pure TS implementation
    const b = (base || '').trim() || 'servertool';
    const s = (suffix || '').trim() || ':followup';
    return `${b}${s}`;
  }
  return String(fn(base, suffix ?? null));
}

// ── Loop warning injector ───────────────────────────────────────────────────

export function injectLoopWarningWithNative(input: LoopWarningInput): Array<{ role: string; content: string }> {
  const capability = 'injectLoopWarningJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    // Fallback: pure TS
    const repeatCount = Math.max(input.warn_threshold, input.repeat_count);
    const warningText = [
      `检测到 stopMessage 请求/响应参数已连续 ${repeatCount} 轮一致。`,
      '请立即尝试跳出循环（换路径、换验证方法、或直接给结论）。',
      `若继续达到 ${input.fail_threshold} 轮一致，将返回 fetch failed 网络错误并停止自动续跑。`
    ].join('\n');
    return [...input.messages, { role: 'system', content: warningText }];
  }
  const inputJson = JSON.stringify(input);
  const resultJson = fn(inputJson);
  if (typeof resultJson !== 'string') {
    return input.messages;
  }
  try {
    return JSON.parse(resultJson);
  } catch {
    return input.messages;
  }
}

// ── Budget reset decision ───────────────────────────────────────────────────

export function decideBudgetResetWithNative(
  stopObserved: boolean,
  stopEligible: boolean,
  currentUsed: number
): BudgetResetDecision {
  const capability = 'decideBudgetResetJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    // Fallback: pure TS
    if (!stopObserved || stopEligible) {
      return { should_reset: false, next_used: currentUsed };
    }
    return { should_reset: true, next_used: currentUsed + 1 };
  }
  const resultJson = fn(stopObserved, stopEligible, currentUsed);
  if (typeof resultJson !== 'string') {
    return { should_reset: false, next_used: currentUsed };
  }
  try {
    return JSON.parse(resultJson);
  } catch {
    return { should_reset: false, next_used: currentUsed };
  }
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
        retryEmptyFollowupOnce?: boolean;
        clientInjectSource?: string;
        transparentReplayRequestSuffix?: string;
        ignoreRequiresActionFollowup?: boolean;
        contextDecorationMode?: 'continue_execution_summary' | 'web_search_summary';
        stopMessageFollowupPolicy?: 'preserve_eligibility' | 'disable';
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
  handler: (...args: unknown[]) => unknown;
}
