import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import { ProviderProtocolError } from '../conversion/provider-protocol-error.js';
import { ensureRuntimeMetadata, readRuntimeMetadata } from '../conversion/runtime-metadata.js';
import {
  planFollowupExecutionModeWithNative,
  planFollowupRuntimeMetadataWithNative,
  planFollowupRuntimeActionWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import {
  resolveFollowupFlowDecision,
  type FollowupFlowDecision
} from './backend-route-flow-policy.js';

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
  const clientInjectSource =
    typeof metadataRecord.clientInjectSource === 'string'
      ? metadataRecord.clientInjectSource.trim()
      : '';
  return planFollowupExecutionModeWithNative({
    ...(args.flowId ? { flowId: args.flowId } : {}),
    decision: {
      outcomeMode: decision.outcomeMode,
      noFollowup: decision.noFollowup,
      clientInjectOnly: decision.clientInjectOnly
    },
    metadataClientInjectOnly: args.readClientInjectOnly(args.metadata),
    ...(clientInjectSource ? { clientInjectSource } : {})
  }).executionMode;
}

export function resolveLoopPayload(args: {
  flowId: string | undefined;
  decision?: FollowupFlowDecision;
  followupPayloadRaw: JsonObject | null;
  buildSeedLoopPayload: () => JsonObject | null;
}): JsonObject | null {
  const decision = args.decision ?? resolveFollowupFlowDecision(args.flowId);
  const plan = planFollowupRuntimeActionWithNative({
    ...(args.flowId ? { flowId: args.flowId } : {}),
    decision: {
      outcomeMode: decision.outcomeMode,
      noFollowup: decision.noFollowup,
      autoLimit: decision.autoLimit,
      clientInjectOnly: decision.clientInjectOnly,
      seedLoopPayload: decision.seedLoopPayload,
      ...(decision.clientInjectSource ? { clientInjectSource: decision.clientInjectSource } : {})
    },
    metadataClientInjectOnly: false,
    hasFollowupPayloadRaw: Boolean(args.followupPayloadRaw)
  });
  if (plan.loopPayloadSource === 'payload') {
    return args.followupPayloadRaw;
  }
  if (plan.loopPayloadSource === 'seed_loop_payload') {
    return args.buildSeedLoopPayload();
  }
  return null;
}

export function assertAutoLimitNotExceeded(args: {
  flowId: string | undefined;
  decision?: FollowupFlowDecision;
  loopState: ServerToolLoopStateLike | null;
  requestId: string;
}): void {
  const decision = args.decision ?? resolveFollowupFlowDecision(args.flowId);
  const plan = planFollowupRuntimeActionWithNative({
    ...(args.flowId ? { flowId: args.flowId } : {}),
    decision: {
      outcomeMode: decision.outcomeMode,
      noFollowup: decision.noFollowup,
      autoLimit: decision.autoLimit,
      clientInjectOnly: decision.clientInjectOnly,
      seedLoopPayload: decision.seedLoopPayload,
      ...(decision.clientInjectSource ? { clientInjectSource: decision.clientInjectSource } : {})
    },
    metadataClientInjectOnly: false,
    hasFollowupPayloadRaw: false,
    ...(typeof args.loopState?.repeatCount === 'number' ? { loopStateRepeatCount: args.loopState.repeatCount } : {})
  });
  if (!plan.autoLimit.exceeded) {
    return;
  }
  if (
    !Number.isInteger(plan.autoLimit.status) ||
    typeof plan.autoLimit.code !== 'string' ||
    typeof plan.autoLimit.category !== 'string' ||
    typeof plan.autoLimit.reason !== 'string'
  ) {
    throw new Error('planFollowupRuntimeActionJson native returned incomplete autoLimit failure plan');
  }
  const wrapped = new ProviderProtocolError(
    '[servertool] followup auto limit reached before stopless contract was satisfied',
    {
      code: plan.autoLimit.code,
      category: plan.autoLimit.category,
      details: {
        flowId: args.flowId,
        requestId: args.requestId,
        repeatCount: plan.autoLimit.repeatCount,
        reason: plan.autoLimit.reason
      }
    }
  ) as ProviderProtocolError & { status?: number };
  wrapped.status = plan.autoLimit.status;
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
  const record = args.metadata as Record<string, unknown>;
  const existingClientInjectSource =
    typeof record.clientInjectSource === 'string'
      ? record.clientInjectSource.trim()
      : '';
  const plan = planFollowupRuntimeActionWithNative({
    ...(args.flowId ? { flowId: args.flowId } : {}),
    decision: {
      outcomeMode: decision.outcomeMode,
      noFollowup: decision.noFollowup,
      autoLimit: decision.autoLimit,
      clientInjectOnly: decision.clientInjectOnly,
      seedLoopPayload: decision.seedLoopPayload,
      ...(decision.clientInjectSource ? { clientInjectSource: decision.clientInjectSource } : {})
    },
    metadataClientInjectOnly: args.readClientInjectOnly(args.metadata),
    hasFollowupPayloadRaw: false,
    ...(existingClientInjectSource ? { clientInjectSource: existingClientInjectSource } : {})
  });
  if (!plan.clientInjectMetadata.force) {
    return { forced: false };
  }
  record.clientInjectOnly = true;
  record.clientInjectText = args.normalizeClientInjectText(record.clientInjectText ?? args.defaultText);
  if (typeof record.clientInjectSource !== 'string' && plan.clientInjectMetadata.source) {
    record.clientInjectSource = plan.clientInjectMetadata.source;
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
}): void {
  const adapterRecord =
    args.adapterContext && typeof args.adapterContext === 'object' && !Array.isArray(args.adapterContext)
      ? (args.adapterContext as Record<string, unknown>)
      : undefined;
  const adapterRuntime = adapterRecord ? readRuntimeMetadata(adapterRecord) : undefined;
  const metadataRecord = args.metadata as Record<string, unknown>;
  const existingRuntime = readRuntimeMetadata(metadataRecord);
  const plan = planFollowupRuntimeMetadataWithNative({
    metadata: metadataRecord,
    ...(existingRuntime ? { metadataRuntime: existingRuntime as Record<string, unknown> } : {}),
    ...(adapterRecord ? { adapterContext: adapterRecord } : {}),
    ...(adapterRuntime ? { adapterRuntime: adapterRuntime as Record<string, unknown> } : {}),
    ...(args.loopState ? { loopState: args.loopState as Record<string, unknown> } : {}),
    originalEntryEndpoint: args.originalEntryEndpoint,
    followupEntryEndpoint: args.followupEntryEndpoint
  });
  const rt = ensureRuntimeMetadata(args.metadata as unknown as Record<string, unknown>);
  for (const key of plan.rootDelete) {
    delete metadataRecord[key];
  }
  Object.assign(metadataRecord, plan.rootSet);
  Object.assign(rt as Record<string, unknown>, plan.runtimeSet);
}
