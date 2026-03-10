import type { JsonObject } from '../../hub/types/json.js';
import { runReqOutboundStage3CompatWithNative } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';
import { buildIflowRequestCompatInput } from './iflow-native-compat.js';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isThinkingDisabled(value: unknown): boolean {
  if (value === false) return true;
  if (!isRecord(value)) return false;
  const enabled = (value as any).enabled;
  if (enabled === false) return true;
  const type = typeof (value as any).type === 'string' ? String((value as any).type).trim().toLowerCase() : '';
  if (type === 'disabled' || type === 'off') return true;
  return false;
}

/**
 * iFlow/Kimi compat:
 * When thinking is active, iFlow requires reasoning_content to exist (and be non-empty)
 * on assistant tool-call messages. Some tool-call surfaces omit it, causing 400 validation errors.
 *
 * We only apply this for kimi-k2.5 to avoid affecting other models.
 *
 * Note: responses→chat bridging may omit top-level thinking while upstream Kimi still
 * enforces this contract. So for kimi-k2.5 we inject unless thinking is explicitly disabled.
 */
export function fillIflowKimiThinkingReasoningContent(payload: JsonObject): JsonObject {
  try {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return payload;
    }
    const model = typeof payload.model === 'string' ? payload.model.trim().toLowerCase() : '';
    if (!(model === 'kimi-k2.5' || model.startsWith('kimi-k2.5-'))) {
      return payload;
    }
    if (isThinkingDisabled((payload as UnknownRecord).thinking)) {
      return payload;
    }
    return runReqOutboundStage3CompatWithNative(buildIflowRequestCompatInput(payload)).payload;
  } catch {
    return payload;
  }
}
