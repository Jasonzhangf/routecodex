import type { JsonObject, JsonValue } from '../hub/types/json.js';
import {
  normalizeReasoningInAnthropicPayloadWithNative,
  normalizeReasoningInChatPayloadWithNative,
  normalizeReasoningInGeminiPayloadWithNative,
  normalizeReasoningInOpenAIPayloadWithNative,
  normalizeReasoningInResponsesPayloadWithNative
} from '../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

export const RESPONSES_INSTRUCTIONS_REASONING_FIELD = '__rcc_reasoning_instructions';

interface ResponsesReasoningNormalizeOptions {
  includeInput?: boolean;
  includeOutput?: boolean;
  includeRequiredAction?: boolean;
  includeInstructions?: boolean;
}

const REASONING_TEXT_MARKERS = [
  '<think',
  '</think',
  '<reflection',
  '</reflection',
  '```think',
  '```reflection'
];

const REASONING_TRANSPORT_NOISE_LINE_RE = /^\[(?:Time\/Date)\]:.*$/gim;
const REASONING_WRAPPER_OPEN_RE = /^\s*\[(?:思考|thinking)\]\s*/i;
const REASONING_WRAPPER_CLOSE_RE = /\s*\[\/(?:思考|thinking)\]\s*$/i;

function stringHasReasoningMarker(value: string): boolean {
  const lower = value.toLowerCase();
  return REASONING_TEXT_MARKERS.some((marker) => lower.includes(marker));
}

export function valueMayContainReasoningMarkup(value: unknown): boolean {
  if (typeof value === 'string') {
    return stringHasReasoningMarker(value);
  }
  if (!value || typeof value !== 'object') {
    return false;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (valueMayContainReasoningMarkup(entry)) {
        return true;
      }
    }
    return false;
  }
  const record = value as Record<string, unknown>;
  for (const entry of Object.values(record)) {
    if (valueMayContainReasoningMarkup(entry)) {
      return true;
    }
  }
  return false;
}

function assertReasoningNormalizerNativeAvailable(): void {
  if (
    typeof normalizeReasoningInChatPayloadWithNative !== 'function' ||
    typeof normalizeReasoningInResponsesPayloadWithNative !== 'function' ||
    typeof normalizeReasoningInGeminiPayloadWithNative !== 'function' ||
    typeof normalizeReasoningInAnthropicPayloadWithNative !== 'function' ||
    typeof normalizeReasoningInOpenAIPayloadWithNative !== 'function'
  ) {
    throw new Error('[reasoning-normalizer] native bindings unavailable');
  }
}

export function normalizeReasoningInChatPayload(payload: { messages?: JsonValue[]; choices?: JsonValue[] } | null | undefined): void {
  assertReasoningNormalizerNativeAvailable();
  if (!payload) return;
  const shouldNormalize =
    valueMayContainReasoningMarkup(payload.messages) ||
    valueMayContainReasoningMarkup(payload.choices);
  if (!shouldNormalize) {
    return;
  }
  const normalized = normalizeReasoningInChatPayloadWithNative(payload) as typeof payload;
  if (normalized && typeof normalized === 'object') {
    Object.assign(payload, normalized as Record<string, unknown>);
  }
}

export function normalizeReasoningInResponsesPayload(
  payload: { output?: JsonValue[]; id?: string; input?: JsonValue[]; instructions?: unknown; required_action?: JsonObject } | null | undefined,
  options: ResponsesReasoningNormalizeOptions = { includeOutput: true }
): void {
  assertReasoningNormalizerNativeAvailable();
  if (!payload) return;
  const shouldNormalize =
    (options.includeInput === true && valueMayContainReasoningMarkup(payload.input)) ||
    (options.includeOutput === true && valueMayContainReasoningMarkup(payload.output)) ||
    (options.includeInstructions === true && valueMayContainReasoningMarkup(payload.instructions)) ||
    (options.includeRequiredAction === true && valueMayContainReasoningMarkup(payload.required_action));
  if (!shouldNormalize) {
    return;
  }
  const normalized = normalizeReasoningInResponsesPayloadWithNative(payload, options as Record<string, unknown>) as typeof payload;
  if (normalized && typeof normalized === 'object') {
    Object.assign(payload, normalized as Record<string, unknown>);
  }
}

export function normalizeReasoningInGeminiPayload(payload: JsonObject | null | undefined): void {
  assertReasoningNormalizerNativeAvailable();
  if (!payload) return;
  const normalized = normalizeReasoningInGeminiPayloadWithNative(payload) as typeof payload;
  if (normalized && typeof normalized === 'object') {
    Object.assign(payload, normalized as Record<string, unknown>);
  }
}

export function normalizeReasoningInAnthropicPayload(payload: JsonObject | null | undefined): void {
  assertReasoningNormalizerNativeAvailable();
  if (!payload) return;
  const normalized = normalizeReasoningInAnthropicPayloadWithNative(payload) as typeof payload;
  if (normalized && typeof normalized === 'object') {
    Object.assign(payload, normalized as Record<string, unknown>);
  }
}

export function normalizeReasoningInOpenAIPayload(payload: JsonObject | null | undefined): void {
  assertReasoningNormalizerNativeAvailable();
  if (!payload) return;
  const normalized = normalizeReasoningInOpenAIPayloadWithNative(payload) as typeof payload;
  if (normalized && typeof normalized === 'object') {
    Object.assign(payload, normalized as Record<string, unknown>);
  }
}

export function stripReasoningTransportNoise(text: string): string {
  return String(text ?? '')
    .replace(REASONING_TRANSPORT_NOISE_LINE_RE, '')
    .replace(REASONING_WRAPPER_OPEN_RE, '')
    .replace(REASONING_WRAPPER_CLOSE_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
