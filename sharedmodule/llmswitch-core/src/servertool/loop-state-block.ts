import { createHash } from 'node:crypto';

import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import {
  planServertoolLoopStateWithNative,
  readServertoolLoopStateWithNative,
} from '../native/router-hotpath/native-servertool-core-semantics.js';
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
  return readServertoolLoopStateWithNative(rt);
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
  const payloadHash = hashPayload(args.payload, args.logNonBlocking);
  const stopPairHash = hashStopMessageRequestResponsePair(args.payload, args.response, args.logNonBlocking);
  const previous = readServerToolLoopState(args.adapterContext);
  return planServertoolLoopStateWithNative({
    ...(typeof args.flowId === 'string' ? { flowId: args.flowId } : {}),
    decision: {
      flowOnlyLoopLimit: decision.flowOnlyLoopLimit
    },
    previousLoopState: previous,
    payloadHash,
    stopPairHash,
    nowMs: Date.now()
  });
}
