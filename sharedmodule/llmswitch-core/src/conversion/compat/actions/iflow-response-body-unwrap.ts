import type { JsonObject } from '../../hub/types/json.js';
import { runRespInboundStage3CompatWithNative } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';
import { buildIflowResponseCompatInput } from './iflow-native-compat.js';

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * iFlow compatibility: some iFlow backends wrap OpenAI-compatible payloads inside:
 *   { status, msg, body, request_id }
 * where `body` is the actual OpenAI-chat/Responses JSON (or a JSON string).
 *
 * This action unwraps `body` so hub semantic mapping and tool harvesting can proceed.
 */
export function unwrapIflowResponseBodyEnvelope(payload: JsonObject): JsonObject {
  try {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return payload;
    }
    const root = structuredClone(payload) as UnknownRecord;
    if (!('body' in root) || !('status' in root) || !('msg' in root)) {
      return payload;
    }
    return runRespInboundStage3CompatWithNative(buildIflowResponseCompatInput(payload)).payload;
  } catch {
    return payload;
  }
}
