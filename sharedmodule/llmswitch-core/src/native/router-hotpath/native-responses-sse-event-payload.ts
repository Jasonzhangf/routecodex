import { callNativeJson } from './native-router-hotpath.js';
import {
  extractNativeErrorMessage,
  failNative,
  isNativeDisabledByEnv,
  readNativeFunction
} from './native-hub-pipeline-resp-semantics-shared.js';

function parseNativeEvent(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function parseNativeSummaryEntries(raw: string): Array<{ type: 'summary_text'; text: string }> | null {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return null;
    }
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null;
      }
      const row = entry as Record<string, unknown>;
      if (row.type !== 'summary_text' || typeof row.text !== 'string') {
        return null;
      }
    }
    return parsed as Array<{ type: 'summary_text'; text: string }>;
  } catch {
    return null;
  }
}

function parseNativeStringArray(raw: string): string[] | null {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export interface ResponsesSseEventEnvelopeNative {
  requestId: string;
  timestamp: number;
  sequenceNumber: number;
  nextSequenceCounter: number;
  protocol: 'responses';
  direction: 'json_to_sse';
}

function parseNativeEventEnvelope(raw: string): ResponsesSseEventEnvelopeNative | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    if (
      typeof row.requestId !== 'string'
      || typeof row.timestamp !== 'number'
      || typeof row.sequenceNumber !== 'number'
      || typeof row.nextSequenceCounter !== 'number'
      || row.protocol !== 'responses'
      || row.direction !== 'json_to_sse'
    ) {
      return null;
    }
    return row as unknown as ResponsesSseEventEnvelopeNative;
  } catch {
    return null;
  }
}

export function canonicalizeResponsesSseEventPayloadWithNative(event: unknown): Record<string, unknown> {
  return callNativeJson(
    'canonicalizeResponsesSseEventPayloadJson',
    'canonicalizeResponsesSseEventPayloadJson',
    [JSON.stringify(event)],
    parseNativeEvent,
    {
      emptyReason: 'empty Responses SSE event payload result',
      invalidReason: 'invalid Responses SSE event payload result'
    }
  );
}

export function serializeResponsesSseEventToWireWithNative(event: unknown): string {
  const capability = 'serializeResponsesSseEventToWireJson';
  const fail = (reason?: string) => failNative<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  let eventJson: string;
  try {
    eventJson = JSON.stringify(event);
  } catch {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(eventJson);
    const nativeErrorMessage = extractNativeErrorMessage(raw);
    if (nativeErrorMessage) {
      throw new Error(nativeErrorMessage);
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty Responses SSE wire serialization result');
    }
    return raw;
  } catch (error) {
    const nativeErrorMessage = extractNativeErrorMessage(error);
    throw new Error(nativeErrorMessage || (error instanceof Error ? error.message : String(error ?? 'unknown')));
  }
}

export function deserializeResponsesSseEventFromWireWithNative(wireData: string): Record<string, unknown> {
  return callNativeJson(
    'deserializeResponsesSseEventFromWireJson',
    'deserializeResponsesSseEventFromWireJson',
    [JSON.stringify(wireData)],
    parseNativeEvent,
    {
      emptyReason: 'empty Responses SSE wire deserialization result',
      invalidReason: 'invalid Responses SSE wire deserialization result'
    }
  );
}

export function validateResponsesSseWireFormatWithNative(wireData: string): boolean {
  const capability = 'validateResponsesSseWireFormatJson';
  const fail = (reason?: string) => failNative<boolean>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  let wireJson: string;
  try {
    wireJson = JSON.stringify(wireData);
  } catch {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(wireJson);
    const nativeErrorMessage = extractNativeErrorMessage(raw);
    if (nativeErrorMessage) {
      throw new Error(nativeErrorMessage);
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty Responses SSE wire validation result');
    }
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'boolean') {
      return fail('invalid Responses SSE wire validation result');
    }
    return parsed;
  } catch (error) {
    const nativeErrorMessage = extractNativeErrorMessage(error);
    throw new Error(nativeErrorMessage || (error instanceof Error ? error.message : String(error ?? 'unknown')));
  }
}

export function normalizeResponsesSseResponsePayloadWithNative(
  response: unknown,
  status: string
): Record<string, unknown> {
  const capability = 'normalizeResponsesSseResponsePayloadJson';
  const fail = (reason?: string) => failNative<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  let responseJson: string;
  try {
    responseJson = JSON.stringify(response);
  } catch {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(responseJson, status);
    const nativeErrorMessage = extractNativeErrorMessage(raw);
    if (nativeErrorMessage) {
      throw new Error(nativeErrorMessage);
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty Responses SSE response payload result');
    }
    const parsed = parseNativeEvent(raw);
    if (!parsed) {
      return fail('invalid Responses SSE response payload result');
    }
    return parsed;
  } catch (error) {
    const nativeErrorMessage = extractNativeErrorMessage(error);
    throw new Error(nativeErrorMessage || (error instanceof Error ? error.message : String(error ?? 'unknown')));
  }
}

export function buildResponsesSseTextChunksWithNative(
  text: string,
  chunkSize: unknown
): string[] {
  const capability = 'buildResponsesSseTextChunksJson';
  const fail = (reason?: string) => failNative<string[]>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  let payloadJson: string;
  try {
    payloadJson = JSON.stringify({
      text,
      ...(typeof chunkSize === 'number' ? { chunk_size: chunkSize } : {})
    });
  } catch {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    const nativeErrorMessage = extractNativeErrorMessage(raw);
    if (nativeErrorMessage) {
      throw new Error(nativeErrorMessage);
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty Responses SSE text chunks result');
    }
    const parsed = parseNativeStringArray(raw);
    if (!parsed) {
      return fail('invalid Responses SSE text chunks result');
    }
    return parsed;
  } catch (error) {
    const nativeErrorMessage = extractNativeErrorMessage(error);
    throw new Error(nativeErrorMessage || (error instanceof Error ? error.message : String(error ?? 'unknown')));
  }
}

export type ResponsesSseResponseEventPayloadLifecycle =
  | 'start'
  | 'completed'
  | 'done'
  | 'required_action';

export function buildResponsesSseResponseEventPayloadWithNative(
  lifecycle: ResponsesSseResponseEventPayloadLifecycle,
  response: unknown,
  status: string,
  requiredAction?: unknown
): Record<string, unknown> {
  const capability = 'buildResponsesSseResponseEventPayloadJson';
  const fail = (reason?: string) => failNative<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  let payloadJson: string;
  try {
    payloadJson = JSON.stringify({
      response,
      status,
      ...(requiredAction !== undefined ? { required_action: requiredAction } : {})
    });
  } catch {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson, lifecycle);
    const nativeErrorMessage = extractNativeErrorMessage(raw);
    if (nativeErrorMessage) {
      throw new Error(nativeErrorMessage);
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty Responses SSE response event payload result');
    }
    const parsed = parseNativeEvent(raw);
    if (!parsed) {
      return fail('invalid Responses SSE response event payload result');
    }
    return parsed;
  } catch (error) {
    const nativeErrorMessage = extractNativeErrorMessage(error);
    throw new Error(nativeErrorMessage || (error instanceof Error ? error.message : String(error ?? 'unknown')));
  }
}

export type ResponsesSseItemEventPayloadLifecycle = 'added' | 'done';

export function buildResponsesSseOutputItemEventPayloadWithNative(
  lifecycle: ResponsesSseItemEventPayloadLifecycle,
  outputIndex: number,
  outputItem: unknown
): Record<string, unknown> {
  const capability = 'buildResponsesSseOutputItemEventPayloadJson';
  const fail = (reason?: string) => failNative<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  let payloadJson: string;
  try {
    payloadJson = JSON.stringify({
      output_index: outputIndex,
      output_item: outputItem
    });
  } catch {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson, lifecycle);
    const nativeErrorMessage = extractNativeErrorMessage(raw);
    if (nativeErrorMessage) {
      throw new Error(nativeErrorMessage);
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty Responses SSE output item event payload result');
    }
    const parsed = parseNativeEvent(raw);
    if (!parsed) {
      return fail('invalid Responses SSE output item event payload result');
    }
    return parsed;
  } catch (error) {
    const nativeErrorMessage = extractNativeErrorMessage(error);
    throw new Error(nativeErrorMessage || (error instanceof Error ? error.message : String(error ?? 'unknown')));
  }
}

export type ResponsesSseContentPartEventPayloadLifecycle = 'added' | 'done';

export function buildResponsesSseContentPartEventPayloadWithNative(
  lifecycle: ResponsesSseContentPartEventPayloadLifecycle,
  outputIndex: number,
  outputItemId: string,
  contentIndex: number,
  contentPart: unknown
): Record<string, unknown> {
  const capability = 'buildResponsesSseContentPartEventPayloadJson';
  const fail = (reason?: string) => failNative<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  let payloadJson: string;
  try {
    payloadJson = JSON.stringify({
      output_index: outputIndex,
      item_id: outputItemId,
      content_index: contentIndex,
      content_part: contentPart
    });
  } catch {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson, lifecycle);
    const nativeErrorMessage = extractNativeErrorMessage(raw);
    if (nativeErrorMessage) {
      throw new Error(nativeErrorMessage);
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty Responses SSE content part event payload result');
    }
    const parsed = parseNativeEvent(raw);
    if (!parsed) {
      return fail('invalid Responses SSE content part event payload result');
    }
    return parsed;
  } catch (error) {
    const nativeErrorMessage = extractNativeErrorMessage(error);
    throw new Error(nativeErrorMessage || (error instanceof Error ? error.message : String(error ?? 'unknown')));
  }
}

export function normalizeResponsesSseReasoningSummaryWithNative(
  summary: unknown
): Array<{ type: 'summary_text'; text: string }> {
  const capability = 'normalizeResponsesSseReasoningSummaryJson';
  const fail = (reason?: string) => failNative<Array<{ type: 'summary_text'; text: string }>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  let summaryJson: string;
  try {
    summaryJson = JSON.stringify(summary ?? null);
  } catch {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(summaryJson);
    const nativeErrorMessage = extractNativeErrorMessage(raw);
    if (nativeErrorMessage) {
      throw new Error(nativeErrorMessage);
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty Responses reasoning summary result');
    }
    const parsed = parseNativeSummaryEntries(raw);
    if (!parsed) {
      return fail('invalid Responses reasoning summary result');
    }
    return parsed;
  } catch (error) {
    const nativeErrorMessage = extractNativeErrorMessage(error);
    throw new Error(nativeErrorMessage || (error instanceof Error ? error.message : String(error ?? 'unknown')));
  }
}

export function buildResponsesSseOutputItemDescriptorWithNative(
  outputItem: unknown,
  lifecycle: 'added' | 'done'
): Record<string, unknown> {
  const capability = 'buildResponsesSseOutputItemDescriptorJson';
  const fail = (reason?: string) => failNative<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  let outputItemJson: string;
  try {
    outputItemJson = JSON.stringify(outputItem);
  } catch {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(outputItemJson, lifecycle);
    const nativeErrorMessage = extractNativeErrorMessage(raw);
    if (nativeErrorMessage) {
      throw new Error(nativeErrorMessage);
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty Responses output item descriptor result');
    }
    const parsed = parseNativeEvent(raw);
    if (!parsed) {
      return fail('invalid Responses output item descriptor result');
    }
    return parsed;
  } catch (error) {
    const nativeErrorMessage = extractNativeErrorMessage(error);
    throw new Error(nativeErrorMessage || (error instanceof Error ? error.message : String(error ?? 'unknown')));
  }
}

export function buildResponsesSseContentPartDescriptorWithNative(
  contentPart: unknown,
  lifecycle: 'added' | 'done'
): Record<string, unknown> {
  const capability = 'buildResponsesSseContentPartDescriptorJson';
  const fail = (reason?: string) => failNative<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  let contentPartJson: string;
  try {
    contentPartJson = JSON.stringify(contentPart);
  } catch {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(contentPartJson, lifecycle);
    const nativeErrorMessage = extractNativeErrorMessage(raw);
    if (nativeErrorMessage) {
      throw new Error(nativeErrorMessage);
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty Responses content part descriptor result');
    }
    const parsed = parseNativeEvent(raw);
    if (!parsed) {
      return fail('invalid Responses content part descriptor result');
    }
    return parsed;
  } catch (error) {
    const nativeErrorMessage = extractNativeErrorMessage(error);
    throw new Error(nativeErrorMessage || (error instanceof Error ? error.message : String(error ?? 'unknown')));
  }
}

export function buildResponsesSseOutputTextDonePayloadWithNative(
  outputIndex: number,
  itemId: string,
  contentIndex: number,
  text: string
): Record<string, unknown> {
  return buildResponsesSseOutputTextPayloadWithNative(
    'buildResponsesSseOutputTextDonePayloadJson',
    outputIndex,
    itemId,
    contentIndex,
    { text }
  );
}

export function buildResponsesSseOutputTextDeltaPayloadWithNative(
  outputIndex: number,
  itemId: string,
  contentIndex: number,
  delta: string
): Record<string, unknown> {
  return buildResponsesSseOutputTextPayloadWithNative(
    'buildResponsesSseOutputTextDeltaPayloadJson',
    outputIndex,
    itemId,
    contentIndex,
    { delta }
  );
}

function buildResponsesSseOutputTextPayloadWithNative(
  capability: 'buildResponsesSseOutputTextDonePayloadJson' | 'buildResponsesSseOutputTextDeltaPayloadJson',
  outputIndex: number,
  itemId: string,
  contentIndex: number,
  textPayload: { text: string } | { delta: string }
): Record<string, unknown> {
  const fail = (reason?: string) => failNative<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  let payloadJson: string;
  try {
    payloadJson = JSON.stringify({
      output_index: outputIndex,
      item_id: itemId,
      content_index: contentIndex,
      ...textPayload
    });
  } catch {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    const nativeErrorMessage = extractNativeErrorMessage(raw);
    if (nativeErrorMessage) {
      throw new Error(nativeErrorMessage);
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty Responses output text payload result');
    }
    const parsed = parseNativeEvent(raw);
    if (!parsed) {
      return fail('invalid Responses output text payload result');
    }
    return parsed;
  } catch (error) {
    const nativeErrorMessage = extractNativeErrorMessage(error);
    throw new Error(nativeErrorMessage || (error instanceof Error ? error.message : String(error ?? 'unknown')));
  }
}

export function buildResponsesSseFunctionCallArgumentsDeltaPayloadWithNative(
  outputIndex: number,
  itemId: string,
  callId: string,
  delta: string
): Record<string, unknown> {
  return buildResponsesSseFunctionCallArgumentsPayloadWithNative(
    'buildResponsesSseFunctionCallArgumentsDeltaPayloadJson',
    {
      output_index: outputIndex,
      item_id: itemId,
      call_id: callId,
      delta
    }
  );
}

export function buildResponsesSseFunctionCallArgumentsDonePayloadWithNative(
  outputIndex: number,
  itemId: string,
  callId: string,
  name: string,
  args: string
): Record<string, unknown> {
  return buildResponsesSseFunctionCallArgumentsPayloadWithNative(
    'buildResponsesSseFunctionCallArgumentsDonePayloadJson',
    {
      output_index: outputIndex,
      item_id: itemId,
      call_id: callId,
      name,
      arguments: args
    }
  );
}

function buildResponsesSseFunctionCallArgumentsPayloadWithNative(
  capability:
    | 'buildResponsesSseFunctionCallArgumentsDeltaPayloadJson'
    | 'buildResponsesSseFunctionCallArgumentsDonePayloadJson',
  payload: Record<string, unknown>
): Record<string, unknown> {
  const fail = (reason?: string) => failNative<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  let payloadJson: string;
  try {
    payloadJson = JSON.stringify(payload);
  } catch {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    const nativeErrorMessage = extractNativeErrorMessage(raw);
    if (nativeErrorMessage) {
      throw new Error(nativeErrorMessage);
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty Responses function call arguments payload result');
    }
    const parsed = parseNativeEvent(raw);
    if (!parsed) {
      return fail('invalid Responses function call arguments payload result');
    }
    return parsed;
  } catch (error) {
    const nativeErrorMessage = extractNativeErrorMessage(error);
    throw new Error(nativeErrorMessage || (error instanceof Error ? error.message : String(error ?? 'unknown')));
  }
}

export type ResponsesSseReasoningSummaryPayloadLifecycle =
  | 'part_added'
  | 'part_done'
  | 'text_delta'
  | 'text_done';

export type ResponsesSseReasoningLifecyclePayloadLifecycle =
  | 'start'
  | 'done';

export type ResponsesSseReasoningDeltaPayloadLifecycle =
  | 'text'
  | 'signature'
  | 'image';

export function buildResponsesSseReasoningSummaryPayloadWithNative(
  lifecycle: ResponsesSseReasoningSummaryPayloadLifecycle,
  outputIndex: number,
  itemId: string,
  summaryIndex: number,
  text: string
): Record<string, unknown> {
  const capability = 'buildResponsesSseReasoningSummaryPayloadJson';
  const fail = (reason?: string) => failNative<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  let payloadJson: string;
  try {
    payloadJson = JSON.stringify({
      output_index: outputIndex,
      item_id: itemId,
      summary_index: summaryIndex,
      text
    });
  } catch {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson, lifecycle);
    const nativeErrorMessage = extractNativeErrorMessage(raw);
    if (nativeErrorMessage) {
      throw new Error(nativeErrorMessage);
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty Responses reasoning summary payload result');
    }
    const parsed = parseNativeEvent(raw);
    if (!parsed) {
      return fail('invalid Responses reasoning summary payload result');
    }
    return parsed;
  } catch (error) {
    const nativeErrorMessage = extractNativeErrorMessage(error);
    throw new Error(nativeErrorMessage || (error instanceof Error ? error.message : String(error ?? 'unknown')));
  }
}

export function buildResponsesSseReasoningLifecyclePayloadWithNative(
  lifecycle: ResponsesSseReasoningLifecyclePayloadLifecycle,
  itemId: string,
  summary?: unknown
): Record<string, unknown> {
  const capability = 'buildResponsesSseReasoningLifecyclePayloadJson';
  const fail = (reason?: string) => failNative<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  let payloadJson: string;
  try {
    payloadJson = JSON.stringify({
      item_id: itemId,
      ...(summary !== undefined ? { summary } : {})
    });
  } catch {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson, lifecycle);
    const nativeErrorMessage = extractNativeErrorMessage(raw);
    if (nativeErrorMessage) {
      throw new Error(nativeErrorMessage);
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty Responses reasoning lifecycle payload result');
    }
    const parsed = parseNativeEvent(raw);
    if (!parsed) {
      return fail('invalid Responses reasoning lifecycle payload result');
    }
    return parsed;
  } catch (error) {
    const nativeErrorMessage = extractNativeErrorMessage(error);
    throw new Error(nativeErrorMessage || (error instanceof Error ? error.message : String(error ?? 'unknown')));
  }
}

export function buildResponsesSseReasoningDeltaPayloadWithNative(
  lifecycle: ResponsesSseReasoningDeltaPayloadLifecycle,
  outputIndex: number,
  itemId: string,
  contentIndex: number,
  value: unknown
): Record<string, unknown> {
  const capability = 'buildResponsesSseReasoningDeltaPayloadJson';
  const fail = (reason?: string) => failNative<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  let payloadJson: string;
  try {
    payloadJson = JSON.stringify({
      output_index: outputIndex,
      item_id: itemId,
      content_index: contentIndex,
      value
    });
  } catch {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson, lifecycle);
    const nativeErrorMessage = extractNativeErrorMessage(raw);
    if (nativeErrorMessage) {
      throw new Error(nativeErrorMessage);
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty Responses reasoning delta payload result');
    }
    const parsed = parseNativeEvent(raw);
    if (!parsed) {
      return fail('invalid Responses reasoning delta payload result');
    }
    return parsed;
  } catch (error) {
    const nativeErrorMessage = extractNativeErrorMessage(error);
    throw new Error(nativeErrorMessage || (error instanceof Error ? error.message : String(error ?? 'unknown')));
  }
}

export function buildResponsesSseEventEnvelopeWithNative(input: {
  requestId: string;
  currentSequence: number;
  enableTimestampGeneration: boolean;
  enableSequenceNumbers: boolean;
}): ResponsesSseEventEnvelopeNative {
  const capability = 'buildResponsesSseEventEnvelopeJson';
  const fail = (reason?: string) => failNative<ResponsesSseEventEnvelopeNative>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  let inputJson: string;
  try {
    inputJson = JSON.stringify({
      request_id: input.requestId,
      current_sequence: input.currentSequence,
      enable_timestamp_generation: input.enableTimestampGeneration,
      enable_sequence_numbers: input.enableSequenceNumbers
    });
  } catch {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    const nativeErrorMessage = extractNativeErrorMessage(raw);
    if (nativeErrorMessage) {
      throw new Error(nativeErrorMessage);
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty Responses SSE event envelope result');
    }
    const parsed = parseNativeEventEnvelope(raw);
    if (!parsed) {
      return fail('invalid Responses SSE event envelope result');
    }
    return parsed;
  } catch (error) {
    const nativeErrorMessage = extractNativeErrorMessage(error);
    throw new Error(nativeErrorMessage || (error instanceof Error ? error.message : String(error ?? 'unknown')));
  }
}
