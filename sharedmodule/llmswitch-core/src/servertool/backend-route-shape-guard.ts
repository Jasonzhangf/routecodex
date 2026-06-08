import type { JsonObject } from '../conversion/hub/types/json.js';
import { normalizeServertoolFollowupPayloadShapeWithNative } from '../native/router-hotpath/native-hub-pipeline-semantic-mappers.js';

export type FollowupShapeViolation = {
  code: 'RESPONSES_FOLLOWUP_MESSAGES_ONLY';
  reason: string;
};

export function validateServertoolFollowupPayloadShape(args: {
  entryEndpoint: string;
  payload: JsonObject | null | undefined;
}): { ok: true } | { ok: false; violation: FollowupShapeViolation } {
  return { ok: true };
}

function asRecord(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

export function normalizeServertoolFollowupPayloadShape(args: {
  entryEndpoint: string;
  payload: JsonObject | null | undefined;
}): JsonObject | null {
  const payload = asRecord(args.payload);
  return payload
    ? (normalizeServertoolFollowupPayloadShapeWithNative(args.entryEndpoint, payload) as JsonObject)
    : null;
}
