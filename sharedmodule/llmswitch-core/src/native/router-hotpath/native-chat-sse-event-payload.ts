import {
  extractNativeErrorMessage,
  failNative,
  isNativeDisabledByEnv,
  readNativeFunction
} from './native-hub-pipeline-resp-semantics-shared.js';

export interface ChatSseEventEnvelopeNative {
  requestId: string;
  timestamp: number;
  sequenceNumber: number;
  nextSequenceCounter: number;
  protocol: 'chat';
  direction: 'json_to_sse';
}

function parseNativeEventPayload(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function parseNativeChatEventEnvelope(raw: string): ChatSseEventEnvelopeNative | null {
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
      || row.protocol !== 'chat'
      || row.direction !== 'json_to_sse'
    ) {
      return null;
    }
    return row as unknown as ChatSseEventEnvelopeNative;
  } catch {
    return null;
  }
}

export function buildChatSseEventEnvelopeWithNative(input: {
  requestId: string;
  currentSequence: number;
  enableTimestampGeneration: boolean;
  enableSequenceNumbers: boolean;
}): ChatSseEventEnvelopeNative {
  const capability = 'buildChatSseEventEnvelopeJson';
  const fail = (reason?: string) => failNative<ChatSseEventEnvelopeNative>(capability, reason);
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
      return fail('empty Chat SSE event envelope result');
    }
    const parsed = parseNativeChatEventEnvelope(raw);
    if (!parsed) {
      return fail('invalid Chat SSE event envelope result');
    }
    return parsed;
  } catch (error) {
    const nativeErrorMessage = extractNativeErrorMessage(error);
    throw new Error(nativeErrorMessage || (error instanceof Error ? error.message : String(error ?? 'unknown')));
  }
}

export function buildChatSseErrorPayloadWithNative(message: string): Record<string, unknown> {
  const capability = 'buildChatSseErrorPayloadJson';
  const fail = (reason?: string) => failNative<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  let inputJson: string;
  try {
    inputJson = JSON.stringify({ message });
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
      return fail('empty Chat SSE error payload result');
    }
    const parsed = parseNativeEventPayload(raw);
    if (!parsed) {
      return fail('invalid Chat SSE error payload result');
    }
    return parsed;
  } catch (error) {
    const nativeErrorMessage = extractNativeErrorMessage(error);
    throw new Error(nativeErrorMessage || (error instanceof Error ? error.message : String(error ?? 'unknown')));
  }
}
