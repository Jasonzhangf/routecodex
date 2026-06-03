import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import { ProviderProtocolError } from '../conversion/provider-protocol-error.js';
import { ensureRuntimeMetadata, readRuntimeMetadata } from '../conversion/runtime-metadata.js';
import {
  resolveFollowupFlowDecision,
  type FollowupFlowDecision
} from './followup-flow-policy.js';

export type ServerToolLoopStateLike = {
  flowId?: string;
  maxRepeats?: number;
  repeatCount?: number;
  startedAtMs?: number;
  payloadHash?: string;
  stopPairHash?: string;
  stopPairRepeatCount?: number;
  stopPairWarned?: boolean;
};

export type FollowupPayloadSource = 'payload' | 'injection' | 'none';

export function resolveFollowupEntryEndpoint(
  followupPlan: unknown,
  entryEndpoint: string | undefined
): string {
  return (
    (followupPlan &&
    typeof followupPlan === 'object' &&
    !Array.isArray(followupPlan) &&
    typeof (followupPlan as { entryEndpoint?: unknown }).entryEndpoint === 'string'
      ? String((followupPlan as { entryEndpoint?: string }).entryEndpoint).trim()
      : '') ||
    entryEndpoint ||
    '/v1/chat/completions'
  );
}

export function resolveFollowupPayloadFromPlan(args: {
  followupPlan: unknown;
  buildInjectionPayload: (injection: JsonObject) => JsonObject | null;
}): JsonObject | null {
  const { followupPlan } = args;
  if (!followupPlan || typeof followupPlan !== 'object' || Array.isArray(followupPlan)) {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(followupPlan, 'payload')) {
    const candidate = (followupPlan as { payload?: unknown }).payload;
    return candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? (candidate as JsonObject) : null;
  }
  if (Object.prototype.hasOwnProperty.call(followupPlan, 'injection')) {
    const injection = (followupPlan as { injection?: unknown }).injection;
    if (!injection || typeof injection !== 'object' || Array.isArray(injection)) {
      return null;
    }
    return args.buildInjectionPayload(injection as JsonObject);
  }
  return null;
}

export function resolveFollowupPayloadSource(followupPlan: unknown): FollowupPayloadSource {
  if (!followupPlan || typeof followupPlan !== 'object' || Array.isArray(followupPlan)) {
    return 'none';
  }
  if (Object.prototype.hasOwnProperty.call(followupPlan, 'payload')) {
    return 'payload';
  }
  if (Object.prototype.hasOwnProperty.call(followupPlan, 'injection')) {
    return 'injection';
  }
  return 'none';
}

export function materializeFollowupPayload(args: {
  followupPlan: unknown;
  buildInjectionPayload: (injection: JsonObject) => JsonObject | null;
}): { source: FollowupPayloadSource; payload: JsonObject | null } {
  const source = resolveFollowupPayloadSource(args.followupPlan);
  if (source === 'none') {
    return { source, payload: null };
  }
  return {
    source,
    payload: resolveFollowupPayloadFromPlan(args)
  };
}

export function resolveFollowupExecutionMode(args: {
  flowId: string | undefined;
  decision?: FollowupFlowDecision;
  metadata: JsonObject;
  readClientInjectOnly: (metadata: JsonObject) => boolean;
}): 'skip' | 'client_inject_only' | 'reenter' {
  const decision = args.decision ?? resolveFollowupFlowDecision(args.flowId);
  const metadataRecord = args.metadata as Record<string, unknown>;
  const injectSource =
    typeof metadataRecord.clientInjectSource === 'string'
      ? metadataRecord.clientInjectSource.trim()
      : '';
  if (decision.outcomeMode === 'skip' || decision.noFollowup) {
    return 'skip';
  }
  if (args.flowId === 'stop_message_flow') {
    return 'reenter';
  }
  // goal-managed stopless continue keeps normal re-enter path.
  if (injectSource === 'servertool.stopless_goal_continue') {
    return 'reenter';
  }
  if (
    args.readClientInjectOnly(args.metadata) ||
    decision.outcomeMode === 'client_inject_only' ||
    decision.clientInjectOnly
  ) {
    return 'client_inject_only';
  }
  return 'reenter';
}

export function resolveLoopPayload(args: {
  flowId: string | undefined;
  decision?: FollowupFlowDecision;
  followupPayloadRaw: JsonObject | null;
  buildSeedLoopPayload: () => JsonObject | null;
}): JsonObject | null {
  const decision = args.decision ?? resolveFollowupFlowDecision(args.flowId);
  return args.followupPayloadRaw || (decision.seedLoopPayload ? args.buildSeedLoopPayload() : null);
}

export function assertAutoLimitNotExceeded(args: {
  flowId: string | undefined;
  decision?: FollowupFlowDecision;
  loopState: ServerToolLoopStateLike | null;
  requestId: string;
}): void {
  const decision = args.decision ?? resolveFollowupFlowDecision(args.flowId);
  if (!decision.autoLimit) {
    return;
  }
  if (!args.loopState || typeof args.loopState.repeatCount !== 'number' || args.loopState.repeatCount < 3) {
    return;
  }
  const wrapped = new ProviderProtocolError(
    '[servertool] followup auto limit reached before stopless contract was satisfied',
    {
      code: 'SERVERTOOL_FOLLOWUP_FAILED',
      category: 'INTERNAL_ERROR',
      details: {
        flowId: args.flowId,
        requestId: args.requestId,
        repeatCount: args.loopState.repeatCount,
        reason: 'followup_auto_limit_hit'
      }
    }
  ) as ProviderProtocolError & { status?: number };
  wrapped.status = 502;
  throw wrapped;
}

export function applyClientInjectOnlyMetadata(args: {
  flowId: string | undefined;
  decision?: FollowupFlowDecision;
  metadata: JsonObject;
  defaultText: string;
  readClientInjectOnly: (metadata: JsonObject) => boolean;
  normalizeClientInjectText: (value: unknown) => string;
}): { forced: boolean } {
  const decision = args.decision ?? resolveFollowupFlowDecision(args.flowId);
  if (!decision.clientInjectOnly || args.readClientInjectOnly(args.metadata)) {
    return { forced: false };
  }
  const record = args.metadata as Record<string, unknown>;
  record.clientInjectOnly = true;
  record.clientInjectText = args.normalizeClientInjectText(record.clientInjectText ?? args.defaultText);
  if (typeof record.clientInjectSource !== 'string') {
    record.clientInjectSource = decision.clientInjectSource ?? 'servertool.followup';
  }
  return { forced: true };
}

export function applyFollowupRuntimeMetadata(args: {
  metadata: JsonObject;
  loopState: ServerToolLoopStateLike | null;
  originalEntryEndpoint: string;
  followupEntryEndpoint: string;
  flowId: string | undefined;
  decision?: FollowupFlowDecision;
  adapterContext: AdapterContext;
  resolveProviderKey: (adapterContext: AdapterContext) => string;
}): void {
  const decision = args.decision ?? resolveFollowupFlowDecision(args.flowId);
  const adapterRecord =
    args.adapterContext && typeof args.adapterContext === 'object' && !Array.isArray(args.adapterContext)
      ? (args.adapterContext as Record<string, unknown>)
      : undefined;
  const adapterTarget =
    adapterRecord?.target && typeof adapterRecord.target === 'object' && !Array.isArray(adapterRecord.target)
      ? (adapterRecord.target as Record<string, unknown>)
      : undefined;
  const adapterRuntime = adapterRecord ? readRuntimeMetadata(adapterRecord) : undefined;
  const runtimeRouteHint =
    typeof adapterRuntime?.routeHint === 'string' ? String(adapterRuntime.routeHint).trim() : '';
  const runtimeRouteName =
    typeof adapterRuntime?.routeName === 'string' ? String(adapterRuntime.routeName).trim() : '';
  const followupMode =
    (typeof (args.metadata as Record<string, unknown>).routecodexPortMode === 'string'
      ? String((args.metadata as Record<string, unknown>).routecodexPortMode).trim().toLowerCase()
      : '')
    || (typeof adapterRecord?.routecodexPortMode === 'string'
      ? String(adapterRecord.routecodexPortMode).trim().toLowerCase()
      : '')
    || (typeof adapterRuntime?.serverToolFollowupMode === 'string'
      ? String(adapterRuntime.serverToolFollowupMode).trim().toLowerCase()
      : '');
  const routeHint =
    (typeof (args.metadata as Record<string, unknown>).routeHint === 'string'
      ? String((args.metadata as Record<string, unknown>).routeHint).trim()
      : '') ||
    runtimeRouteHint ||
    runtimeRouteName ||
    (typeof adapterRecord?.routeHint === 'string' ? String(adapterRecord.routeHint).trim() : '') ||
    (typeof adapterRecord?.routeId === 'string' ? String(adapterRecord.routeId).trim() : '') ||
    (typeof adapterRecord?.routeName === 'string' ? String(adapterRecord.routeName).trim() : '') ||
    (typeof adapterTarget?.routeName === 'string' ? String(adapterTarget.routeName).trim() : '');
  const rt = ensureRuntimeMetadata(args.metadata as unknown as Record<string, unknown>);
  (rt as Record<string, unknown>).serverToolFollowup = true;
  if (args.loopState) {
    const rootLoopState = (args.metadata as Record<string, unknown>).serverToolLoopState;
    const currentLoopState = (rt as Record<string, unknown>).serverToolLoopState;
    const mergedLoopState = {
      ...(rootLoopState && typeof rootLoopState === 'object' && !Array.isArray(rootLoopState)
        ? (rootLoopState as Record<string, unknown>)
        : {}),
      ...(currentLoopState && typeof currentLoopState === 'object' && !Array.isArray(currentLoopState)
        ? (currentLoopState as Record<string, unknown>)
        : {}),
      ...args.loopState
    };
    (rt as Record<string, unknown>).serverToolLoopState = mergedLoopState;
  }
  (rt as Record<string, unknown>).stopMessageFollowupPolicy = decision.stopMessageFollowupPolicy;
  (args.metadata as any).__hubEntry = 'chat_process';
  if (followupMode === 'router' && routeHint) {
    (args.metadata as Record<string, unknown>).routeHint = routeHint;
  } else if ((args.metadata as Record<string, unknown>).routeHint !== undefined) {
    delete (args.metadata as Record<string, unknown>).routeHint;
  }
  (rt as Record<string, unknown>).preserveRouteHint = false;
  (rt as Record<string, unknown>).serverToolOriginalEntryEndpoint =
    (typeof args.originalEntryEndpoint === 'string' && args.originalEntryEndpoint.trim().length
      ? args.originalEntryEndpoint
      : args.followupEntryEndpoint) as any;
}

export function resolveFollowupAttemptCount(flowId: string | undefined, decision?: FollowupFlowDecision): number {
  const resolved = decision ?? resolveFollowupFlowDecision(flowId);
  return resolved.retryEmptyFollowupOnce ? 2 : 1;
}
