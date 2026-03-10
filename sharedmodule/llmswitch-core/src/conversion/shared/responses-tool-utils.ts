import {
  createToolCallIdTransformerWithNative,
  normalizeResponsesToolCallIdsWithNative,
  normalizeFunctionCallIdWithNative,
  normalizeFunctionCallOutputIdWithNative,
  normalizeResponsesCallIdWithNative,
  resolveToolCallIdStyleWithNative,
  stripInternalToolingMetadataWithNative
} from '../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';
import { sanitizeResponsesFunctionNameWithNative } from '../../router/virtual-router/engine-selection/native-hub-pipeline-resp-semantics.js';

export type ToolCallIdStyle = 'preserve' | 'fc';

type BridgeInputItem = Record<string, unknown>;

export interface CallIdTransformer {
  normalizeCallId(raw: unknown): string;
  normalizeItemId(raw: unknown, callId: string): string;
  normalizeOutputId(callId: string, raw: unknown): string;
}

function assertResponsesToolUtilsNativeAvailable(): void {
  if (
    typeof createToolCallIdTransformerWithNative !== 'function' ||
    typeof normalizeResponsesToolCallIdsWithNative !== 'function' ||
    typeof normalizeFunctionCallIdWithNative !== 'function' ||
    typeof normalizeFunctionCallOutputIdWithNative !== 'function' ||
    typeof normalizeResponsesCallIdWithNative !== 'function' ||
    typeof resolveToolCallIdStyleWithNative !== 'function' ||
    typeof stripInternalToolingMetadataWithNative !== 'function' ||
    typeof sanitizeResponsesFunctionNameWithNative !== 'function'
  ) {
    throw new Error('[responses-tool-utils] native bindings unavailable');
  }
}

function replaceMutableRecord(target: Record<string, unknown>, next: Record<string, unknown>): void {
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, next);
}

export function createToolCallIdTransformer(style: ToolCallIdStyle): CallIdTransformer | null {
  assertResponsesToolUtilsNativeAvailable();
  if (style !== 'fc') {
    return null;
  }
  const state = createToolCallIdTransformerWithNative(style);
  return {
    normalizeCallId(raw: unknown): string {
      return normalizeResponsesCallIdWithNative({
        callId: typeof raw === 'string' && raw.trim().length ? raw.trim() : undefined,
        fallback: transformCounter(state, 'call')
      });
    },
    normalizeItemId(raw: unknown, callId: string): string {
      return normalizeFunctionCallIdWithNative({
        callId: typeof raw === 'string' && raw.trim().length ? raw.trim() : callId,
        fallback: transformCounter(state, 'item')
      });
    },
    normalizeOutputId(callId: string, raw: unknown): string {
      return normalizeFunctionCallOutputIdWithNative({
        callId,
        fallback: typeof raw === 'string' && raw.trim().length ? raw.trim() : transformCounter(state, 'tool')
      });
    }
  };
}

function transformCounter(state: Record<string, unknown>, prefix: string): string {
  const current = typeof state.__counter === 'number' ? state.__counter : 0;
  const next = current + 1;
  state.__counter = next;
  return `${prefix}_${next}`;
}

export function normalizeResponsesToolCallIds(payload: Record<string, unknown> | null | undefined): void {
  assertResponsesToolUtilsNativeAvailable();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return;
  }
  const normalized = normalizeResponsesToolCallIdsWithNative(payload);
  if (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) {
    replaceMutableRecord(payload, normalized);
  }
}

export function resolveToolCallIdStyle(metadata: Record<string, unknown> | undefined): ToolCallIdStyle {
  assertResponsesToolUtilsNativeAvailable();
  const style = resolveToolCallIdStyleWithNative(metadata ?? null);
  return style === 'preserve' ? 'preserve' : 'fc';
}

export function stripInternalToolingMetadata(metadata: unknown): void {
  assertResponsesToolUtilsNativeAvailable();
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return;
  const normalized = stripInternalToolingMetadataWithNative(metadata);
  if (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) {
    replaceMutableRecord(metadata as Record<string, unknown>, normalized);
  }
}

export function sanitizeResponsesFunctionName(rawName: unknown): string | undefined {
  assertResponsesToolUtilsNativeAvailable();
  return sanitizeResponsesFunctionNameWithNative(rawName);
}

export function enforceToolCallIdStyle(input: BridgeInputItem[], transformer: CallIdTransformer): void {
  assertResponsesToolUtilsNativeAvailable();
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue;
    const type = typeof (entry as any).type === 'string' ? (entry as any).type.toLowerCase() : '';
    if (type === 'function_call') {
      const normalizedCallId = transformer.normalizeCallId((entry as any).call_id ?? (entry as any).id);
      (entry as any).call_id = normalizedCallId;
      (entry as any).id = transformer.normalizeItemId((entry as any).id ?? normalizedCallId, normalizedCallId);
      continue;
    }
    if (type === 'function_call_output' || type === 'tool_result' || type === 'tool_message') {
      const normalizedCallId = transformer.normalizeCallId(
        (entry as any).call_id ?? (entry as any).tool_call_id ?? (entry as any).id
      );
      (entry as any).call_id = normalizedCallId;
      // Keep tool_call_id for providers that expect it (e.g., Qwen)
      (entry as any).tool_call_id = normalizedCallId;

      (entry as any).id = transformer.normalizeOutputId(normalizedCallId, (entry as any).id);
    }
  }
}
