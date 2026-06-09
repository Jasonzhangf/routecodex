import type { JsonObject } from '../../conversion/hub/types/json.js';
import type {
  NativeReqOutboundStage3CompatOutput
} from './native-hub-pipeline-req-outbound-semantics-types.js';
import { formatUnknownError } from '../../shared/common-utils.js';

const NON_BLOCKING_PARSE_LOG_THROTTLE_MS = 60_000;
const nonBlockingParseLogState = new Map<string, number>();
const JSON_PARSE_FAILED = Symbol('native-hub-pipeline-req-outbound-semantics.parse-failed');


function logNativeReqOutboundParserNonBlocking(stage: string, error: unknown): void {
  const now = Date.now();
  const last = nonBlockingParseLogState.get(stage) ?? 0;
  if (now - last < NON_BLOCKING_PARSE_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingParseLogState.set(stage, now);
  console.warn(
    `[native-hub-pipeline-req-outbound-semantics-parsers] ${stage} parse failed (non-blocking): ${formatUnknownError(error)}`
  );
}

function parseJson(stage: string, raw: string): unknown | typeof JSON_PARSE_FAILED {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    logNativeReqOutboundParserNonBlocking(stage, error);
    return JSON_PARSE_FAILED;
  }
}

function parseRecord(raw: string, stage = 'parseRecord'): Record<string, unknown> | null {
  const parsed = parseJson(stage, raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function parseReqOutboundCompatOutput(raw: string): NativeReqOutboundStage3CompatOutput | null {
  const row = parseRecord(raw, 'parseReqOutboundCompatOutput');
  if (!row) {
    return null;
  }
  const payloadRaw = row.payload;
  if (!payloadRaw || typeof payloadRaw !== 'object' || Array.isArray(payloadRaw)) {
    return null;
  }
  const payload = payloadRaw as JsonObject;
  const appliedProfileRaw = row.appliedProfile;
  const appliedProfile = typeof appliedProfileRaw === 'string' && appliedProfileRaw.trim()
    ? appliedProfileRaw.trim()
    : undefined;
  const nativeAppliedRaw = row.nativeApplied;
  if (typeof nativeAppliedRaw !== 'boolean') {
    return null;
  }
  const nativeApplied = nativeAppliedRaw;
  const rateLimitDetectedRaw = row.rateLimitDetected;
  const rateLimitDetected =
    typeof rateLimitDetectedRaw === 'boolean' ? rateLimitDetectedRaw : undefined;
  return {
    payload,
    ...(appliedProfile ? { appliedProfile } : {}),
    nativeApplied,
    ...(rateLimitDetected !== undefined ? { rateLimitDetected } : {})
  };
}

function parseJsonObject(raw: string): JsonObject | null {
  const parsed = parseJson('parseJsonObject', raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as JsonObject;
}

function parseBoolean(raw: string): boolean | null {
  const parsed = parseJson('parseBoolean', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  return typeof parsed === 'boolean' ? parsed : null;
}

export {
  parseRecord,
  parseReqOutboundCompatOutput,
  parseJsonObject,
  parseBoolean
};
