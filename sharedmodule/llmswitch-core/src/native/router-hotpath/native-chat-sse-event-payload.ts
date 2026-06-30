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

export function buildChatSseRoleDeltaPayloadWithNative(input: {
  responseId: string;
  created: number;
  model: string;
  choiceIndex: number;
  role: string;
}): Record<string, unknown> {
  const capability = 'buildChatSseRoleDeltaPayloadJson';
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
    inputJson = JSON.stringify({
      response_id: input.responseId,
      created: input.created,
      model: input.model,
      choice_index: input.choiceIndex,
      role: input.role
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
      return fail('empty Chat SSE role delta payload result');
    }
    const parsed = parseNativeEventPayload(raw);
    if (!parsed) {
      return fail('invalid Chat SSE role delta payload result');
    }
    return parsed;
  } catch (error) {
    const nativeErrorMessage = extractNativeErrorMessage(error);
    throw new Error(nativeErrorMessage || (error instanceof Error ? error.message : String(error ?? 'unknown')));
  }
}

export function buildChatSseContentDeltaPayloadWithNative(input: {
  responseId: string;
  created: number;
  model: string;
  choiceIndex: number;
  content: string;
}): Record<string, unknown> {
  const capability = 'buildChatSseContentDeltaPayloadJson';
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
    inputJson = JSON.stringify({
      response_id: input.responseId,
      created: input.created,
      model: input.model,
      choice_index: input.choiceIndex,
      content: input.content
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
      return fail('empty Chat SSE content delta payload result');
    }
    const parsed = parseNativeEventPayload(raw);
    if (!parsed) {
      return fail('invalid Chat SSE content delta payload result');
    }
    return parsed;
  } catch (error) {
    const nativeErrorMessage = extractNativeErrorMessage(error);
    throw new Error(nativeErrorMessage || (error instanceof Error ? error.message : String(error ?? 'unknown')));
  }
}

export function buildChatSseReasoningDeltaPayloadWithNative(input: {
  responseId: string;
  created: number;
  model: string;
  choiceIndex: number;
  reasoning: string;
}): Record<string, unknown> {
  const capability = 'buildChatSseReasoningDeltaPayloadJson';
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
    inputJson = JSON.stringify({
      response_id: input.responseId,
      created: input.created,
      model: input.model,
      choice_index: input.choiceIndex,
      reasoning: input.reasoning
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
      return fail('empty Chat SSE reasoning delta payload result');
    }
    const parsed = parseNativeEventPayload(raw);
    if (!parsed) {
      return fail('invalid Chat SSE reasoning delta payload result');
    }
    return parsed;
  } catch (error) {
    const nativeErrorMessage = extractNativeErrorMessage(error);
    throw new Error(nativeErrorMessage || (error instanceof Error ? error.message : String(error ?? 'unknown')));
  }
}

export function buildChatSseToolCallArgsDeltaPayloadWithNative(input: {
  responseId: string;
  created: number;
  model: string;
  choiceIndex: number;
  toolCallIndex: number;
  arguments: string;
}): Record<string, unknown> {
  const capability = 'buildChatSseToolCallArgsDeltaPayloadJson';
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
    inputJson = JSON.stringify({
      response_id: input.responseId,
      created: input.created,
      model: input.model,
      choice_index: input.choiceIndex,
      tool_call_index: input.toolCallIndex,
      arguments: input.arguments
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
      return fail('empty Chat SSE tool call args delta payload result');
    }
    const parsed = parseNativeEventPayload(raw);
    if (!parsed) {
      return fail('invalid Chat SSE tool call args delta payload result');
    }
    return parsed;
  } catch (error) {
    const nativeErrorMessage = extractNativeErrorMessage(error);
    throw new Error(nativeErrorMessage || (error instanceof Error ? error.message : String(error ?? 'unknown')));
  }
}

export function buildChatSseToolCallStartPayloadWithNative(input: {
  responseId: string;
  created: number;
  model: string;
  choiceIndex: number;
  toolCallIndex: number;
  toolCallId: string;
  toolCallType: string;
  functionName: string;
}): Record<string, unknown> {
  const capability = 'buildChatSseToolCallStartPayloadJson';
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
    inputJson = JSON.stringify({
      response_id: input.responseId,
      created: input.created,
      model: input.model,
      choice_index: input.choiceIndex,
      tool_call_index: input.toolCallIndex,
      tool_call_id: input.toolCallId,
      tool_call_type: input.toolCallType,
      function_name: input.functionName
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
      return fail('empty Chat SSE tool call start payload result');
    }
    const parsed = parseNativeEventPayload(raw);
    if (!parsed) {
      return fail('invalid Chat SSE tool call start payload result');
    }
    return parsed;
  } catch (error) {
    const nativeErrorMessage = extractNativeErrorMessage(error);
    throw new Error(nativeErrorMessage || (error instanceof Error ? error.message : String(error ?? 'unknown')));
  }
}

export function buildChatSseFinishPayloadWithNative(input: {
  responseId: string;
  created: number;
  model: string;
  choiceIndex: number;
  finishReason: string;
  usage?: unknown;
}): Record<string, unknown> {
  const capability = 'buildChatSseFinishPayloadJson';
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
    inputJson = JSON.stringify({
      response_id: input.responseId,
      created: input.created,
      model: input.model,
      choice_index: input.choiceIndex,
      finish_reason: input.finishReason,
      usage: input.usage
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
      return fail('empty Chat SSE finish payload result');
    }
    const parsed = parseNativeEventPayload(raw);
    if (!parsed) {
      return fail('invalid Chat SSE finish payload result');
    }
    return parsed;
  } catch (error) {
    const nativeErrorMessage = extractNativeErrorMessage(error);
    throw new Error(nativeErrorMessage || (error instanceof Error ? error.message : String(error ?? 'unknown')));
  }
}
