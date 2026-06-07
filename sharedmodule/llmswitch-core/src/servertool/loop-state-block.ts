import { createHash } from 'node:crypto';

import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import { readRuntimeMetadata } from '../conversion/runtime-metadata.js';
import { resolveFollowupFlowDecision, type FollowupFlowDecision } from './backend-route-flow-policy.js';

export type ServerToolLoopState = {
  flowId?: string;
  payloadHash?: string;
  repeatCount?: number;
  startedAtMs?: number;
  stopPairHash?: string;
  stopPairRepeatCount?: number;
  stopPairWarned?: boolean;
};

export function readServerToolLoopState(adapterContext: AdapterContext): ServerToolLoopState | null {
  if (!adapterContext || typeof adapterContext !== 'object') {
    return null;
  }
  const rt = readRuntimeMetadata(adapterContext as unknown as Record<string, unknown>);
  const raw = (rt as any)?.serverToolLoopState;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const flowId = typeof record.flowId === 'string' ? record.flowId.trim() : undefined;
  const payloadHash = typeof record.payloadHash === 'string' ? record.payloadHash.trim() : undefined;
  const repeatCount =
    typeof record.repeatCount === 'number' && Number.isFinite(record.repeatCount)
      ? Math.max(0, Math.floor(record.repeatCount))
      : undefined;
  const startedAtMs =
    typeof record.startedAtMs === 'number' && Number.isFinite(record.startedAtMs)
      ? Math.max(0, Math.floor(record.startedAtMs))
      : undefined;
  const stopPairHash =
    typeof record.stopPairHash === 'string' && record.stopPairHash.trim().length
      ? record.stopPairHash.trim()
      : undefined;
  const stopPairRepeatCount =
    typeof record.stopPairRepeatCount === 'number' && Number.isFinite(record.stopPairRepeatCount)
      ? Math.max(0, Math.floor(record.stopPairRepeatCount))
      : undefined;
  const stopPairWarned = typeof record.stopPairWarned === 'boolean' ? record.stopPairWarned : undefined;
  if (!payloadHash) {
    return null;
  }
  return {
    ...(flowId ? { flowId } : {}),
    payloadHash,
    ...(repeatCount !== undefined ? { repeatCount } : {}),
    ...(startedAtMs !== undefined ? { startedAtMs } : {}),
    ...(stopPairHash ? { stopPairHash } : {}),
    ...(stopPairRepeatCount !== undefined ? { stopPairRepeatCount } : {}),
    ...(stopPairWarned !== undefined ? { stopPairWarned } : {})
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(',')}}`;
}

function hashPayload(payload: JsonObject, logNonBlocking: (stage: string, error: unknown) => void): string | null {
  try {
    const stable = stableStringify(payload);
    return createHash('sha1').update(stable).digest('hex');
  } catch (error) {
    logNonBlocking('hash_payload', error);
    return null;
  }
}

function sanitizeLoopHashValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeLoopHashValue(entry));
  }
  if (typeof value !== 'object') {
    return value;
  }
  const record = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  const volatileKeys = new Set([
    'id',
    'created',
    'created_at',
    'timestamp',
    'request_id',
    'requestId',
    'trace_id',
    'response_id',
    'system_fingerprint'
  ]);
  for (const key of Object.keys(record)) {
    if (volatileKeys.has(key)) {
      continue;
    }
    normalized[key] = sanitizeLoopHashValue(record[key]);
  }
  return normalized;
}

function hashStopMessageRequestResponsePair(
  payload: JsonObject,
  response: JsonObject | undefined,
  logNonBlocking: (stage: string, error: unknown) => void
): string | null {
  try {
    const normalizedPayload = sanitizeLoopHashValue(payload);
    const normalizedResponse = sanitizeLoopHashValue(response ?? {});
    const stable = stableStringify({ request: normalizedPayload, response: normalizedResponse });
    return createHash('sha1').update(stable).digest('hex');
  } catch (error) {
    logNonBlocking('hash_stop_message_request_response_pair', error);
    return null;
  }
}

export function buildServerToolLoopState(args: {
  adapterContext: AdapterContext;
  flowId: string | undefined;
  decision?: FollowupFlowDecision;
  payload: JsonObject;
  response?: JsonObject;
  logNonBlocking: (stage: string, error: unknown) => void;
}): ServerToolLoopState | null {
  if (!args.payload || typeof args.payload !== 'object' || Array.isArray(args.payload)) {
    return null;
  }
  const decision = args.decision ?? resolveFollowupFlowDecision(args.flowId);
  const useFlowOnlyAutoLimit = decision.flowOnlyLoopLimit;
  const trackPayload =
    typeof args.flowId === 'string' && args.flowId.trim() && args.flowId !== 'stop_message_flow' && !useFlowOnlyAutoLimit;
  const payloadHash = trackPayload ? hashPayload(args.payload, args.logNonBlocking) : '__servertool_auto__';
  if (!payloadHash) {
    return null;
  }
  const previous = readServerToolLoopState(args.adapterContext);
  const sameFlow = previous && previous.flowId === args.flowId;
  const samePayload = !trackPayload || (previous && previous.payloadHash === payloadHash);
  const prevCount =
    previous && typeof previous.repeatCount === 'number' && Number.isFinite(previous.repeatCount)
      ? Math.max(0, Math.floor(previous.repeatCount))
      : 0;
  const repeatCount = sameFlow && samePayload ? prevCount + 1 : 1;
  const previousStartedAtMs =
    sameFlow && previous && typeof previous.startedAtMs === 'number' && Number.isFinite(previous.startedAtMs)
      ? Math.max(0, Math.floor(previous.startedAtMs))
      : undefined;
  const startedAtMs = previousStartedAtMs ?? Date.now();

  const base: ServerToolLoopState = {
    ...(args.flowId ? { flowId: args.flowId } : {}),
    payloadHash,
    repeatCount,
    startedAtMs
  };

  if (args.flowId === 'stop_message_flow') {
    const pairHash = hashStopMessageRequestResponsePair(args.payload, args.response, args.logNonBlocking);
    if (pairHash) {
      const previousPairHash =
        sameFlow && previous && typeof previous.stopPairHash === 'string' ? previous.stopPairHash : undefined;
      const previousPairCount =
        sameFlow && previous && typeof previous.stopPairRepeatCount === 'number' && Number.isFinite(previous.stopPairRepeatCount)
          ? Math.max(0, Math.floor(previous.stopPairRepeatCount))
          : 0;
      const stopPairRepeatCount = previousPairHash === pairHash ? previousPairCount + 1 : 1;
      const stopPairWarned =
        previousPairHash === pairHash && previous && typeof previous.stopPairWarned === 'boolean'
          ? previous.stopPairWarned
          : false;
      base.stopPairHash = pairHash;
      base.stopPairRepeatCount = stopPairRepeatCount;
      base.stopPairWarned = stopPairWarned;
    }
  }

  return base;
}
