import path from 'node:path';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const nativeBinding = nodeRequire(
  path.resolve(process.cwd(), 'sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node')
) as Record<string, unknown>;

// feature_id: sse.responses_encode_projection
// Direct test evidence for Rust owner `build_responses_sse_stream_frames_json`
// and adjacent Responses SSE NAPI payload builders without the retired TS shell.
function nativeFn(name: string): (...args: unknown[]) => unknown {
  const fn = nativeBinding[name];
  if (typeof fn !== 'function') {
    throw new Error(`${name} native export is required`);
  }
  return fn as (...args: unknown[]) => unknown;
}

function throwNativeError(raw: unknown): never {
  if (typeof raw === 'object' && raw !== null && 'message' in raw) {
    throw new Error(String((raw as { message: unknown }).message));
  }
  throw new Error(String(raw ?? 'unknown native error'));
}

function parseNativeJson<T>(raw: unknown): T {
  if (typeof raw === 'object' && raw !== null && 'message' in raw) {
    throwNativeError(raw);
  }
  if (typeof raw === 'string' && raw.startsWith('Error: ')) {
    throwNativeError(raw);
  }
  return JSON.parse(String(raw)) as T;
}

export function buildResponsesSseEventSequenceDirectNative(input: {
  response: unknown;
  requestId: string;
  model?: string;
  config?: Record<string, unknown>;
}): any[] {
  return parseNativeJson<any[]>(nativeFn('buildResponsesSseEventSequenceJson')(JSON.stringify({
    response: input.response,
    request_id: input.requestId,
    ...(input.model ? { model: input.model } : {}),
    config: input.config ?? {}
  })));
}

export function buildResponsesSseOutputItemDescriptorDirectNative(
  outputItem: unknown,
  lifecycle: 'added' | 'done'
): Record<string, unknown> {
  return parseNativeJson<Record<string, unknown>>(
    nativeFn('buildResponsesSseOutputItemDescriptorJson')(JSON.stringify(outputItem), lifecycle)
  );
}

export function buildResponsesSseOutputTextDonePayloadDirectNative(
  outputIndex: number,
  itemId: string,
  contentIndex: number,
  text: string
): Record<string, unknown> {
  return parseNativeJson<Record<string, unknown>>(nativeFn('buildResponsesSseOutputTextDonePayloadJson')(JSON.stringify({
    output_index: outputIndex,
    item_id: itemId,
    content_index: contentIndex,
    text
  })));
}

export function buildResponsesSseOutputTextDeltaPayloadDirectNative(
  outputIndex: number,
  itemId: string,
  contentIndex: number,
  delta: string
): Record<string, unknown> {
  return parseNativeJson<Record<string, unknown>>(nativeFn('buildResponsesSseOutputTextDeltaPayloadJson')(JSON.stringify({
    output_index: outputIndex,
    item_id: itemId,
    content_index: contentIndex,
    delta
  })));
}

export function buildResponsesSseFunctionCallArgumentsDeltaPayloadDirectNative(
  outputIndex: number,
  itemId: string,
  callId: string,
  delta: string
): Record<string, unknown> {
  return parseNativeJson<Record<string, unknown>>(nativeFn('buildResponsesSseFunctionCallArgumentsDeltaPayloadJson')(JSON.stringify({
    output_index: outputIndex,
    item_id: itemId,
    call_id: callId,
    delta
  })));
}

export function buildResponsesSseFunctionCallArgumentsDonePayloadDirectNative(
  outputIndex: number,
  itemId: string,
  callId: string,
  name: string,
  args: string
): Record<string, unknown> {
  return parseNativeJson<Record<string, unknown>>(nativeFn('buildResponsesSseFunctionCallArgumentsDonePayloadJson')(JSON.stringify({
    output_index: outputIndex,
    item_id: itemId,
    call_id: callId,
    name,
    arguments: args
  })));
}

export function normalizeResponsesSseReasoningSummaryDirectNative(
  summary: unknown
): Array<{ type: 'summary_text'; text: string }> {
  return parseNativeJson<Array<{ type: 'summary_text'; text: string }>>(
    nativeFn('normalizeResponsesSseReasoningSummaryJson')(JSON.stringify(summary ?? null))
  );
}

export function buildResponsesSseReasoningSummaryPayloadDirectNative(
  lifecycle: 'part_added' | 'part_done' | 'text_delta' | 'text_done',
  outputIndex: number,
  itemId: string,
  summaryIndex: number,
  text: string
): Record<string, unknown> {
  return parseNativeJson<Record<string, unknown>>(nativeFn('buildResponsesSseReasoningSummaryPayloadJson')(JSON.stringify({
    output_index: outputIndex,
    item_id: itemId,
    summary_index: summaryIndex,
    text
  }), lifecycle));
}

export function buildResponsesSseReasoningDeltaPayloadDirectNative(
  lifecycle: 'text' | 'signature' | 'image',
  outputIndex: number,
  itemId: string,
  contentIndex: number,
  value: unknown
): Record<string, unknown> {
  return parseNativeJson<Record<string, unknown>>(nativeFn('buildResponsesSseReasoningDeltaPayloadJson')(JSON.stringify({
    output_index: outputIndex,
    item_id: itemId,
    content_index: contentIndex,
    value
  }), lifecycle));
}

export function buildResponsesSseReasoningLifecyclePayloadDirectNative(
  lifecycle: 'start' | 'done',
  itemId: string,
  summary?: unknown
): Record<string, unknown> {
  return parseNativeJson<Record<string, unknown>>(nativeFn('buildResponsesSseReasoningLifecyclePayloadJson')(JSON.stringify({
    item_id: itemId,
    ...(summary !== undefined ? { summary } : {})
  }), lifecycle));
}

export function buildResponsesSseResponseEventPayloadDirectNative(
  lifecycle: 'start' | 'completed' | 'done' | 'required_action',
  response: unknown,
  status: string,
  requiredAction?: unknown
): Record<string, unknown> {
  return parseNativeJson<Record<string, unknown>>(nativeFn('buildResponsesSseResponseEventPayloadJson')(JSON.stringify({
    response,
    status,
    ...(requiredAction !== undefined ? { required_action: requiredAction } : {})
  }), lifecycle));
}

export function buildResponsesSseTextChunksDirectNative(text: string, chunkSize: unknown): string[] {
  return parseNativeJson<string[]>(nativeFn('buildResponsesSseTextChunksJson')(JSON.stringify({
    text,
    ...(typeof chunkSize === 'number' ? { chunk_size: chunkSize } : {})
  })));
}

export function buildResponsesSseEventEnvelopeDirectNative(input: {
  requestId: string;
  currentSequence: number;
  enableTimestampGeneration: boolean;
  enableSequenceNumbers: boolean;
}): Record<string, unknown> {
  return parseNativeJson<Record<string, unknown>>(nativeFn('buildResponsesSseEventEnvelopeJson')(JSON.stringify({
    request_id: input.requestId,
    current_sequence: input.currentSequence,
    enable_timestamp_generation: input.enableTimestampGeneration,
    enable_sequence_numbers: input.enableSequenceNumbers
  })));
}
