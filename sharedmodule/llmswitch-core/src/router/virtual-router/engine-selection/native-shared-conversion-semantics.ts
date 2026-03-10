import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';

function readNativeFunction(name: string): ((...args: unknown[]) => unknown) | null {
  const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
  const fn = binding?.[name];
  return typeof fn === 'function' ? (fn as (...args: unknown[]) => unknown) : null;
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function parseJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function parseRecord(raw: string): Record<string, unknown> | null {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function parseExtractToolCallsOutput(
  raw: string
): { cleanedText: string; toolCalls: Array<Record<string, unknown>> } | null {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const row = parsed as Record<string, unknown>;
  if (typeof row.cleanedText !== 'string' || !Array.isArray(row.toolCalls)) {
    return null;
  }
  const toolCalls = row.toolCalls.filter((entry) => entry && typeof entry === 'object') as Array<Record<string, unknown>>;
  return {
    cleanedText: row.cleanedText,
    toolCalls
  };
}

function parseReasoningItems(raw: string): Array<{ type: 'reasoning'; content: string }> | null {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) {
    return null;
  }
  const out: Array<{ type: 'reasoning'; content: string }> = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return null;
    }
    const row = entry as Record<string, unknown>;
    if (row.type !== 'reasoning' || typeof row.content !== 'string') {
      return null;
    }
    out.push({ type: 'reasoning', content: row.content });
  }
  return out;
}

function parseExtractReasoningSegmentsOutput(
  raw: string
): { text: string; segments: string[] } | null {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const row = parsed as Record<string, unknown>;
  if (typeof row.text !== 'string' || !Array.isArray(row.segments)) {
    return null;
  }
  const segments = row.segments.filter((entry): entry is string => typeof entry === 'string');
  if (segments.length !== row.segments.length) {
    return null;
  }
  return { text: row.text, segments };
}

function parseNormalizeReasoningOutput(raw: string): { payload: unknown } | null {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const row = parsed as Record<string, unknown>;
  return { payload: row.payload };
}

function parseToolCallLiteArray(
  raw: string
): Array<{ id?: string; name: string; args: string }> | null {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) {
    return null;
  }
  const out: Array<{ id?: string; name: string; args: string }> = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return null;
    }
    const row = entry as Record<string, unknown>;
    if (typeof row.name !== 'string' || typeof row.args !== 'string') {
      return null;
    }
    const id = typeof row.id === 'string' && row.id.trim().length ? row.id : undefined;
    out.push({ id, name: row.name, args: row.args });
  }
  return out;
}

function parseArray(raw: string): Array<unknown> | null {
  const parsed = parseJson(raw);
  return Array.isArray(parsed) ? parsed : null;
}

function parseToolDefinitionOutput(raw: string): Record<string, unknown> | null {
  const parsed = parseRecord(raw);
  return parsed;
}

function parseResponsesConversationResumeResult(
  raw: string
): { payload: Record<string, unknown>; meta: Record<string, unknown> } | null {
  const parsed = parseRecord(raw);
  if (!parsed) {
    return null;
  }
  const payload = parsed.payload;
  const meta = parsed.meta;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return null;
  }
  return {
    payload: payload as Record<string, unknown>,
    meta: meta as Record<string, unknown>
  };
}

function parseToolDefinitionArray(raw: string): Array<Record<string, unknown>> | null {
  const parsed = parseArray(raw);
  if (!parsed) return null;
  const output: Array<Record<string, unknown>> = [];
  for (const entry of parsed) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      output.push(entry as Record<string, unknown>);
    }
  }
  return output;
}

function parseString(raw: string): string | null {
  const parsed = parseJson(raw);
  return typeof parsed === 'string' ? parsed : null;
}

function parseStringArray(raw: string): string[] | null {
  const parsed = parseArray(raw);
  if (!parsed) return null;
  const out: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string") {
      return null;
    }
    out.push(item);
  }
  return out;
}

export function parseLenientJsonishWithNative(value: unknown): unknown {
  const capability = 'parseLenientJsonishJson';
  const fail = (reason?: string) => failNativeRequired<unknown>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const valueJson = safeStringify(value ?? null);
  if (!valueJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(valueJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function repairArgumentsToStringWithNative(value: unknown): string {
  const capability = 'repairArgumentsToStringJsonishJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const valueJson = safeStringify(value ?? null);
  if (!valueJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(valueJson);
    if (typeof raw !== 'string') {
      return fail('invalid payload');
    }
    return raw;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function extractToolCallsFromReasoningTextWithNative(
  text: string,
  idPrefix?: string
): { cleanedText: string; toolCalls: Array<Record<string, unknown>> } {
  const capability = 'extractToolCallsFromReasoningTextJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ cleanedText: string; toolCalls: Array<Record<string, unknown>> }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  try {
    const raw = fn(String(text ?? ''), idPrefix);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseExtractToolCallsOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function extractReasoningSegmentsWithNative(
  source: string
): { text: string; segments: string[] } {
  const capability = 'extractReasoningSegmentsJson';
  const fail = (reason?: string) => failNativeRequired<{ text: string; segments: string[] }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ source: String(source ?? '') });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseExtractReasoningSegmentsOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeAssistantTextToToolCallsWithNative(
  message: Record<string, unknown>,
  options?: Record<string, unknown>
): Record<string, unknown> {
  const capability = 'normalizeAssistantTextToToolCallsJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const msgJson = safeStringify(message ?? null);
  if (!msgJson) {
    return fail('json stringify failed');
  }
  const optionsJson = options ? safeStringify(options) : undefined;
  try {
    const raw = fn(msgJson, optionsJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeReasoningInChatPayloadWithNative(payload: unknown): unknown {
  const capability = 'normalizeReasoningInChatPayloadJson';
  const fail = (reason?: string) => failNativeRequired<unknown>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ payload: payload ?? null });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseNormalizeReasoningOutput(raw);
    return parsed ? parsed.payload : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeReasoningInResponsesPayloadWithNative(payload: unknown, options?: Record<string, unknown>): unknown {
  const capability = 'normalizeReasoningInResponsesPayloadJson';
  const fail = (reason?: string) => failNativeRequired<unknown>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ payload: payload ?? null, options: options ?? null });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseNormalizeReasoningOutput(raw);
    return parsed ? parsed.payload : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeReasoningInGeminiPayloadWithNative(payload: unknown): unknown {
  const capability = 'normalizeReasoningInGeminiPayloadJson';
  const fail = (reason?: string) => failNativeRequired<unknown>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ payload: payload ?? null });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseNormalizeReasoningOutput(raw);
    return parsed ? parsed.payload : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeReasoningInAnthropicPayloadWithNative(payload: unknown): unknown {
  const capability = 'normalizeReasoningInAnthropicPayloadJson';
  const fail = (reason?: string) => failNativeRequired<unknown>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ payload: payload ?? null });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseNormalizeReasoningOutput(raw);
    return parsed ? parsed.payload : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeReasoningInOpenAIPayloadWithNative(payload: unknown): unknown {
  const capability = 'normalizeReasoningInOpenAIPayloadJson';
  const fail = (reason?: string) => failNativeRequired<unknown>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ payload: payload ?? null });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseNormalizeReasoningOutput(raw);
    return parsed ? parsed.payload : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}


export function bridgeToolToChatDefinitionWithNative(
  tool: Record<string, unknown>,
  options?: { sanitizeMode?: string }
): Record<string, unknown> | null {
  const capability = 'bridgeToolToChatDefinitionJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown> | null>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ tool, options: options ?? null });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseToolDefinitionOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function chatToolToBridgeDefinitionWithNative(
  tool: Record<string, unknown>,
  options?: { sanitizeMode?: string }
): Record<string, unknown> | null {
  const capability = 'chatToolToBridgeDefinitionJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown> | null>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ tool, options: options ?? null });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseToolDefinitionOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function mapBridgeToolsToChatWithNative(
  rawTools: unknown,
  options?: { sanitizeMode?: string }
): Array<Record<string, unknown>> {
  const capability = 'mapBridgeToolsToChatWithOptionsJson';
  const fail = (reason?: string) => failNativeRequired<Array<Record<string, unknown>>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ tools: Array.isArray(rawTools) ? rawTools : [], options: options ?? null });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseToolDefinitionArray(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function mapChatToolsToBridgeWithNative(
  rawTools: unknown,
  options?: { sanitizeMode?: string }
): Array<Record<string, unknown>> {
  const capability = 'mapChatToolsToBridgeWithOptionsJson';
  const fail = (reason?: string) => failNativeRequired<Array<Record<string, unknown>>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ tools: Array.isArray(rawTools) ? rawTools : [], options: options ?? null });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseToolDefinitionArray(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function collectToolCallsFromResponsesWithNative(
  response: Record<string, unknown>
): Array<Record<string, unknown>> {
  const capability = 'collectToolCallsFromResponsesJson';
  const fail = (reason?: string) => failNativeRequired<Array<Record<string, unknown>>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(response ?? {});
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseToolDefinitionArray(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveFinishReasonWithNative(
  response: Record<string, unknown>,
  toolCalls: Array<Record<string, unknown>>
): string {
  const capability = 'resolveFinishReasonJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const responseJson = safeStringify(response ?? {});
  const toolCallsJson = safeStringify(Array.isArray(toolCalls) ? toolCalls : []);
  if (!responseJson || !toolCallsJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(responseJson, toolCallsJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    return parseString(raw) ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function buildChatResponseFromResponsesWithNative(payload: unknown): Record<string, unknown> | null {
  const capability = 'buildChatResponseFromResponsesJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown> | null>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(payload ?? null);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    return parseRecord(raw) ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function hasValidThoughtSignatureWithNative(
  block: unknown,
  options?: Record<string, unknown>
): boolean {
  const capability = 'hasValidThoughtSignatureJson';
  const fail = (reason?: string) => failNativeRequired<boolean>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ block: block ?? null, options: options ?? null });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    return typeof parsed === 'boolean' ? parsed : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function sanitizeThinkingBlockWithNative(block: unknown): Record<string, unknown> {
  const capability = 'sanitizeThinkingBlockJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ block: block ?? null });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function filterInvalidThinkingBlocksWithNative(
  messages: unknown,
  options?: Record<string, unknown>
): unknown[] {
  const capability = 'filterInvalidThinkingBlocksJson';
  const fail = (reason?: string) => failNativeRequired<unknown[]>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ messages: Array.isArray(messages) ? messages : [], options: options ?? null });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseArray(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function removeTrailingUnsignedThinkingBlocksWithNative(
  blocks: unknown,
  options?: Record<string, unknown>
): unknown[] {
  const capability = 'removeTrailingUnsignedThinkingBlocksJson';
  const fail = (reason?: string) => failNativeRequired<unknown[]>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ blocks: Array.isArray(blocks) ? blocks : [], options: options ?? null });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseArray(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function sanitizeReasoningTaggedTextWithNative(text: string): string {
  const capability = 'sanitizeReasoningTaggedTextJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  try {
    const raw = fn(String(text ?? ''));
    if (typeof raw !== 'string') {
      return fail('invalid payload');
    }
    return raw;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function ensureBridgeInstructionsWithNative(payload: Record<string, unknown>): Record<string, unknown> {
  const capability = 'ensureBridgeInstructionsJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(payload ?? {});
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function repairFindMetaWithNative(script: string): string {
  const capability = 'repairFindMetaJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(script ?? '');
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    return typeof parsed === 'string' ? parsed : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function splitCommandStringWithNative(input: string): string[] {
  const capability = 'splitCommandStringJson';
  const fail = (reason?: string) => failNativeRequired<string[]>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(input ?? '');
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseStringArray(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function packShellArgsWithNative(input: Record<string, unknown>): Record<string, unknown> {
  const capability = 'packShellArgsJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(input ?? {});
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function flattenByCommaWithNative(items: string[]): string[] {
  const capability = 'flattenByCommaJson';
  const fail = (reason?: string) => failNativeRequired<string[]>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(Array.isArray(items) ? items : []);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseStringArray(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function chunkStringWithNative(
  s: string,
  minParts = 3,
  maxParts = 12,
  targetChunk = 12
): string[] {
  const capability = 'chunkStringJson';
  const fail = (reason?: string) => failNativeRequired<string[]>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ s, minParts, maxParts, targetChunk });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseStringArray(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function deriveToolCallKeyWithNative(
  call: Record<string, unknown> | null | undefined
): string | null {
  const capability = 'deriveToolCallKeyJson';
  const fail = (reason?: string) => failNativeRequired<string | null>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const callJson = safeStringify(call ?? null);
  if (!callJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(callJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    if (parsed === null) {
      return null;
    }
    return typeof parsed === 'string' ? parsed : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeIdValueWithNative(value: unknown, forceGenerate = false): string {
  const capability = 'normalizeIdValueJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ value, forceGenerate });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    return typeof parsed === 'string' ? parsed : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function extractToolCallIdWithNative(obj: unknown): string | undefined {
  const capability = 'extractToolCallIdJson';
  const fail = (reason?: string) => failNativeRequired<string | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ obj: obj ?? null });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    return typeof parsed === 'string' ? parsed : undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function createToolCallIdTransformerWithNative(style: string): Record<string, unknown> {
  const capability = 'createToolCallIdTransformerJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ style });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function transformToolCallIdWithNative(state: Record<string, unknown>, id: string): { id: string; state: Record<string, unknown> } {
  const capability = 'transformToolCallIdJson';
  const fail = (reason?: string) => failNativeRequired<{ id: string; state: Record<string, unknown> }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ state, id });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed || typeof parsed.id !== 'string' || !parsed.state || typeof parsed.state !== 'object') {
      return fail('invalid payload');
    }
    return parsed as { id: string; state: Record<string, unknown> };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function enforceToolCallIdStyleWithNative(messages: unknown[], state: Record<string, unknown>): { messages: unknown[]; state: Record<string, unknown> } {
  const capability = 'enforceToolCallIdStyleJson';
  const fail = (reason?: string) => failNativeRequired<{ messages: unknown[]; state: Record<string, unknown> }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ messages: Array.isArray(messages) ? messages : [], state });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed || !Array.isArray(parsed.messages) || !parsed.state || typeof parsed.state !== 'object') {
      return fail('invalid payload');
    }
    return parsed as { messages: unknown[]; state: Record<string, unknown> };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeResponsesToolCallIdsWithNative(payload: unknown): Record<string, unknown> | null {
  const capability = 'normalizeResponsesToolCallIdsJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown> | null>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(payload ?? null);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    return parseRecord(raw) ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveToolCallIdStyleWithNative(metadata: unknown): string {
  const capability = 'resolveToolCallIdStyleJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const metadataJson = safeStringify(metadata ?? null);
  if (!metadataJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(metadataJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    return typeof parsed === 'string' ? parsed : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function stripInternalToolingMetadataWithNative(metadata: unknown): Record<string, unknown> | null {
  const capability = 'stripInternalToolingMetadataJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown> | null>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const metadataJson = safeStringify(metadata ?? null);
  if (!metadataJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(metadataJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    return parseRecord(raw) ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function buildProviderProtocolErrorWithNative(input: {
  message: string;
  code: string;
  protocol?: string;
  providerType?: string;
  category?: string;
  details?: Record<string, unknown>;
}): Record<string, unknown> {
  const capability = 'buildProviderProtocolErrorJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    message: input.message,
    code: input.code,
    protocol: input.protocol,
    providerType: input.providerType,
    category: input.category,
    details: input.details
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

function parseToolCallResult(raw: string): Array<{ id?: string; name: string; args: string }> | null {
  if (!raw || raw === 'null') {
    return null;
  }
  return parseToolCallLiteArray(raw);
}

function callTextMarkupExtractor(
  capability: string,
  payload: unknown
): Array<{ id?: string; name: string; args: string }> | null {
  const fail = (reason?: string) =>
    failNativeRequired<Array<{ id?: string; name: string; args: string }> | null>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(payload ?? null);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string') {
      return fail('invalid payload');
    }
    const parsed = parseToolCallResult(raw);
    return parsed ?? null;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function extractJsonToolCallsFromTextWithNative(
  text: string,
  options?: Record<string, unknown>
): Array<{ id?: string; name: string; args: string }> | null {
  return callTextMarkupExtractor('extractJsonToolCallsFromTextJson', {
    text: String(text ?? ''),
    options: options ?? null
  });
}

export function extractXMLToolCallsFromTextWithNative(
  text: string
): Array<{ id?: string; name: string; args: string }> | null {
  return callTextMarkupExtractor('extractXmlToolCallsFromTextJson', {
    text: String(text ?? '')
  });
}

export function extractSimpleXmlToolsFromTextWithNative(
  text: string
): Array<{ id?: string; name: string; args: string }> | null {
  return callTextMarkupExtractor('extractSimpleXmlToolsFromTextJson', {
    text: String(text ?? '')
  });
}

export function extractParameterXmlToolsFromTextWithNative(
  text: string
): Array<{ id?: string; name: string; args: string }> | null {
  return callTextMarkupExtractor('extractParameterXmlToolsFromTextJson', {
    text: String(text ?? '')
  });
}

export function extractInvokeToolsFromTextWithNative(
  text: string
): Array<{ id?: string; name: string; args: string }> | null {
  return callTextMarkupExtractor('extractInvokeToolsFromTextJson', {
    text: String(text ?? '')
  });
}

export function extractToolNamespaceXmlBlocksFromTextWithNative(
  text: string
): Array<{ id?: string; name: string; args: string }> | null {
  return callTextMarkupExtractor('extractToolNamespaceXmlBlocksFromTextJson', {
    text: String(text ?? '')
  });
}

export function extractApplyPatchCallsFromTextWithNative(
  text: string
): Array<{ id?: string; name: string; args: string }> | null {
  return callTextMarkupExtractor('extractApplyPatchCallsFromTextJson', {
    text: String(text ?? '')
  });
}

export function extractBareExecCommandFromTextWithNative(
  text: string
): Array<{ id?: string; name: string; args: string }> | null {
  return callTextMarkupExtractor('extractBareExecCommandFromTextJson', {
    text: String(text ?? '')
  });
}

export function extractExecuteBlocksFromTextWithNative(
  text: string
): Array<{ id?: string; name: string; args: string }> | null {
  return callTextMarkupExtractor('extractExecuteBlocksFromTextJson', {
    text: String(text ?? '')
  });
}

export function extractExploredListDirectoryCallsFromTextWithNative(
  text: string
): Array<{ id?: string; name: string; args: string }> | null {
  return callTextMarkupExtractor('extractExploredListDirectoryCallsFromTextJson', {
    text: String(text ?? '')
  });
}

export function extractQwenToolCallTokensFromTextWithNative(
  text: string
): Array<{ id?: string; name: string; args: string }> | null {
  return callTextMarkupExtractor('extractQwenToolCallTokensFromTextJson', {
    text: String(text ?? '')
  });
}

export function mergeToolCallsWithNative(
  existing: Array<Record<string, unknown>> | undefined,
  additions: Array<Record<string, unknown>> | undefined
): Array<Record<string, unknown>> {
  const capability = 'mergeToolCallsJson';
  const fail = (reason?: string) => failNativeRequired<Array<Record<string, unknown>>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const existingJson = safeStringify(existing ?? []);
  const additionsJson = safeStringify(additions ?? []);
  if (!existingJson || !additionsJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(existingJson, additionsJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    if (!Array.isArray(parsed)) {
      return fail('invalid payload');
    }
    return parsed.filter((entry) => entry && typeof entry === 'object') as Array<Record<string, unknown>>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function mapReasoningContentToResponsesOutputWithNative(
  reasoningContent: unknown
): Array<{ type: 'reasoning'; content: string }> {
  const capability = 'mapReasoningContentToResponsesOutputJson';
  const fail = (reason?: string) =>
    failNativeRequired<Array<{ type: 'reasoning'; content: string }>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const contentJson = safeStringify(reasoningContent ?? null);
  if (!contentJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(contentJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseReasoningItems(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function validateToolArgumentsWithNative(
  toolName: string | undefined,
  args: unknown
): { repaired: string; success: boolean; error?: string } {
  const capability = 'validateToolArgumentsJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ repaired: string; success: boolean; error?: string }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ toolName, args: args ?? null });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed || typeof parsed.repaired !== 'string' || typeof parsed.success !== 'boolean') {
      return fail('invalid payload');
    }
    const error = typeof parsed.error === 'string' ? parsed.error : undefined;
    return { repaired: parsed.repaired, success: parsed.success, ...(error ? { error } : {}) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function repairToolCallsWithNative(
  toolCalls: Array<{ name?: string; arguments?: unknown }>
): Array<{ name?: string; arguments: string }> {
  const capability = 'repairToolCallsJson';
  const fail = (reason?: string) =>
    failNativeRequired<Array<{ name?: string; arguments: string }>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(Array.isArray(toolCalls) ? toolCalls : []);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseArray(raw);
    if (!parsed) {
      return fail('invalid payload');
    }
    return parsed.filter((entry): entry is { name?: string; arguments: string } =>
      entry && typeof entry === 'object' && !Array.isArray(entry) && typeof (entry as any).arguments === 'string'
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function isImagePathWithNative(pathValue: unknown): boolean {
  const capability = 'isImagePathJson';
  const fail = (reason?: string) => failNativeRequired<boolean>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const pathJson = safeStringify(pathValue ?? null);
  if (!pathJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(pathJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    return typeof parsed === 'boolean' ? parsed : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function extractStreamingToolCallsWithNative(input: {
  buffer: string;
  text: string;
  idPrefix: string;
  idCounter: number;
  nowMs: number;
}): { buffer: string; idCounter: number; toolCalls: Array<Record<string, unknown>> } {
  const capability = 'extractStreamingToolCallsJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ buffer: string; idCounter: number; toolCalls: Array<Record<string, unknown>> }>(
      capability,
      reason
    );
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(input ?? {});
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed) {
      return fail('invalid payload');
    }
    const buffer = typeof parsed.buffer === 'string' ? parsed.buffer : '';
    const idCounter = typeof parsed.idCounter === 'number' ? parsed.idCounter : input.idCounter;
    const toolCalls = Array.isArray(parsed.toolCalls)
      ? (parsed.toolCalls as Array<unknown>).filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
          .map((entry) => entry as Record<string, unknown>)
      : [];
    return { buffer, idCounter, toolCalls };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function createStreamingToolExtractorStateWithNative(idPrefix?: string): Record<string, unknown> {
  const capability = 'createStreamingToolExtractorStateJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(idPrefix ? { idPrefix } : {});
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    return parseRecord(raw) ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resetStreamingToolExtractorStateWithNative(state: Record<string, unknown>): Record<string, unknown> {
  const capability = 'resetStreamingToolExtractorStateJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(state ?? {});
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    return parseRecord(raw) ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function feedStreamingToolExtractorWithNative(input: {
  state: Record<string, unknown>;
  text: string;
  nowMs?: number;
}): { state: Record<string, unknown>; toolCalls: Array<Record<string, unknown>> } {
  const capability = 'feedStreamingToolExtractorJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ state: Record<string, unknown>; toolCalls: Array<Record<string, unknown>> }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(input ?? {});
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed || !parsed.state || typeof parsed.state !== 'object' || Array.isArray(parsed.state)) {
      return fail('invalid payload');
    }
    const toolCalls = Array.isArray(parsed.toolCalls)
      ? (parsed.toolCalls as Array<unknown>).filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
          .map((entry) => entry as Record<string, unknown>)
      : [];
    return { state: parsed.state as Record<string, unknown>, toolCalls };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function isCompactionRequestWithNative(payload: unknown): boolean {
  const capability = 'isCompactionRequestJson';
  const fail = (reason?: string) => failNativeRequired<boolean>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(payload ?? null);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    return typeof parsed === 'boolean' ? parsed : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function encodeMetadataPassthroughWithNative(
  parameters: unknown,
  prefix: string,
  keys: readonly string[]
): Record<string, string> | undefined {
  const capability = 'encodeMetadataPassthroughJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, string> | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const parametersJson = safeStringify(parameters ?? null);
  const keysJson = safeStringify(Array.isArray(keys) ? keys : []);
  if (!parametersJson || !keysJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(parametersJson, String(prefix || ''), keysJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    if (parsed === null) {
      return undefined;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail('invalid payload');
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof key !== 'string' || typeof value !== 'string') {
        return fail('invalid payload');
      }
      out[key] = value;
    }
    return Object.keys(out).length ? out : undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function extractMetadataPassthroughWithNative(
  metadataField: unknown,
  prefix: string,
  keys: readonly string[]
): {
  metadata?: Record<string, unknown>;
  passthrough?: Record<string, unknown>;
} {
  const capability = 'extractMetadataPassthroughJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ metadata?: Record<string, unknown>; passthrough?: Record<string, unknown> }>(
      capability,
      reason
    );
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const metadataJson = safeStringify(metadataField ?? null);
  const keysJson = safeStringify(Array.isArray(keys) ? keys : []);
  if (!metadataJson || !keysJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(metadataJson, String(prefix || ''), keysJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed) {
      return fail('invalid payload');
    }
    const metadata =
      parsed.metadata && typeof parsed.metadata === 'object' && !Array.isArray(parsed.metadata)
        ? (parsed.metadata as Record<string, unknown>)
        : undefined;
    const passthrough =
      parsed.passthrough && typeof parsed.passthrough === 'object' && !Array.isArray(parsed.passthrough)
        ? (parsed.passthrough as Record<string, unknown>)
        : undefined;
    return {
      ...(metadata ? { metadata } : {}),
      ...(passthrough ? { passthrough } : {})
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function ensureProtocolStateWithNative(
  metadata: Record<string, unknown>,
  protocol: string
): { metadata: Record<string, unknown>; node: Record<string, unknown> } {
  const capability = 'ensureProtocolStateJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ metadata: Record<string, unknown>; node: Record<string, unknown> }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const metadataJson = safeStringify(metadata ?? {});
  if (!metadataJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(metadataJson, String(protocol ?? ''));
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed) {
      return fail('invalid payload');
    }
    const metadataOut =
      parsed.metadata && typeof parsed.metadata === 'object' && !Array.isArray(parsed.metadata)
        ? (parsed.metadata as Record<string, unknown>)
        : undefined;
    const nodeOut =
      parsed.node && typeof parsed.node === 'object' && !Array.isArray(parsed.node)
        ? (parsed.node as Record<string, unknown>)
        : undefined;
    if (!metadataOut || !nodeOut) {
      return fail('invalid payload');
    }
    return { metadata: metadataOut, node: nodeOut };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function getProtocolStateWithNative(
  metadata: Record<string, unknown> | undefined,
  protocol: string
): Record<string, unknown> | undefined {
  const capability = 'getProtocolStateJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown> | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const metadataJson = safeStringify(metadata ?? null);
  if (!metadataJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(metadataJson, String(protocol ?? ''));
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    if (parsed === null) {
      return undefined;
    }
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function readRuntimeMetadataWithNative(
  carrier: Record<string, unknown> | null | undefined
): Record<string, unknown> | undefined {
  const capability = 'readRuntimeMetadataJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown> | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const carrierJson = safeStringify(carrier ?? null);
  if (!carrierJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(carrierJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    if (parsed === null) {
      return undefined;
    }
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function ensureRuntimeMetadataCarrierWithNative(
  carrier: Record<string, unknown>
): Record<string, unknown> {
  const capability = 'ensureRuntimeMetadataJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const carrierJson = safeStringify(carrier);
  if (!carrierJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(carrierJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function cloneRuntimeMetadataWithNative(
  carrier: Record<string, unknown> | null | undefined
): Record<string, unknown> | undefined {
  const capability = 'cloneRuntimeMetadataJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown> | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const carrierJson = safeStringify(carrier ?? null);
  if (!carrierJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(carrierJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    if (parsed === null) {
      return undefined;
    }
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function injectMcpToolsForChatWithNative(
  tools: unknown[] | undefined,
  discoveredServers: string[]
): unknown[] {
  const capability = 'injectMcpToolsForChatJson';
  const fail = (reason?: string) => failNativeRequired<unknown[]>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const toolsJson = safeStringify(Array.isArray(tools) ? tools : []);
  const serversJson = safeStringify(Array.isArray(discoveredServers) ? discoveredServers : []);
  if (!toolsJson || !serversJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(toolsJson, serversJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    return Array.isArray(parsed) ? parsed : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeArgsBySchemaWithNative(
  input: unknown,
  schema: unknown
): { ok: boolean; value?: Record<string, unknown>; errors?: string[] } {
  const capability = 'normalizeArgsBySchemaJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ ok: boolean; value?: Record<string, unknown>; errors?: string[] }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? null);
  const schemaJson = safeStringify(schema ?? null);
  if (!inputJson || !schemaJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson, schemaJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed || typeof parsed.ok !== 'boolean') {
      return fail('invalid payload');
    }
    const value =
      parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value)
        ? (parsed.value as Record<string, unknown>)
        : undefined;
    const errors = Array.isArray(parsed.errors)
      ? parsed.errors.filter((entry): entry is string => typeof entry === 'string')
      : undefined;
    return {
      ok: parsed.ok,
      ...(value ? { value } : {}),
      ...(errors && errors.length ? { errors } : {})
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeToolsWithNative(tools: unknown): Array<Record<string, unknown>> {
  const capability = 'normalizeToolsJson';
  const fail = (reason?: string) => failNativeRequired<Array<Record<string, unknown>>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const toolsJson = safeStringify(tools ?? null);
  if (!toolsJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(toolsJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function extractOutputSegmentsWithNative(
  source: Record<string, unknown> | undefined,
  itemsKey: string = 'output'
): { textParts: string[]; reasoningParts: string[] } {
  const capability = 'extractOutputSegmentsJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ textParts: string[]; reasoningParts: string[] }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const sourceJson = safeStringify(source ?? null);
  if (!sourceJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(sourceJson, String(itemsKey || 'output'));
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed) {
      return fail('invalid payload');
    }
    const textParts = Array.isArray(parsed.textParts)
      ? parsed.textParts.filter((entry): entry is string => typeof entry === 'string')
      : [];
    const reasoningParts = Array.isArray(parsed.reasoningParts)
      ? parsed.reasoningParts.filter((entry): entry is string => typeof entry === 'string')
      : [];
    return { textParts, reasoningParts };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeContentPartWithNative(
  part: unknown,
  reasoningCollector: string[]
): { normalized: Record<string, unknown> | null; reasoningCollector: string[] } {
  const capability = 'normalizeOutputContentPartJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ normalized: Record<string, unknown> | null; reasoningCollector: string[] }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const partJson = safeStringify(part ?? null);
  const collectorJson = safeStringify(Array.isArray(reasoningCollector) ? reasoningCollector : []);
  if (!partJson || !collectorJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(partJson, collectorJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed) {
      return fail('invalid payload');
    }
    const normalized =
      parsed.normalized === null
        ? null
        : parsed.normalized && typeof parsed.normalized === 'object' && !Array.isArray(parsed.normalized)
          ? (parsed.normalized as Record<string, unknown>)
          : fail('invalid payload');
    const nextCollector = Array.isArray(parsed.reasoningCollector)
      ? parsed.reasoningCollector.filter((entry): entry is string => typeof entry === 'string')
      : [];
    return { normalized, reasoningCollector: nextCollector };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeMessageContentPartsWithNative(
  parts: unknown,
  reasoningCollector: string[]
): { normalizedParts: Array<Record<string, unknown>>; reasoningChunks: string[] } {
  const capability = 'normalizeMessageContentPartsJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ normalizedParts: Array<Record<string, unknown>>; reasoningChunks: string[] }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const partsJson = safeStringify(parts ?? null);
  const collectorJson = safeStringify(Array.isArray(reasoningCollector) ? reasoningCollector : []);
  if (!partsJson || !collectorJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(partsJson, collectorJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed) {
      return fail('invalid payload');
    }
    const normalizedParts = Array.isArray(parsed.normalizedParts)
      ? parsed.normalizedParts.filter(
          (entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry)
        )
      : [];
    const reasoningChunks = Array.isArray(parsed.reasoningChunks)
      ? parsed.reasoningChunks.filter((entry): entry is string => typeof entry === 'string')
      : [];
    return { normalizedParts, reasoningChunks };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeChatMessageContentWithNative(
  content: unknown
): { contentText?: string; reasoningText?: string } {
  const capability = 'normalizeChatMessageContentJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ contentText?: string; reasoningText?: string }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const contentJson = safeStringify(content ?? null);
  if (!contentJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(contentJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed) {
      return fail('invalid payload');
    }
    const contentText = typeof parsed.contentText === 'string' ? parsed.contentText : undefined;
    const reasoningText = typeof parsed.reasoningText === 'string' ? parsed.reasoningText : undefined;
    return {
      ...(contentText ? { contentText } : {}),
      ...(reasoningText ? { reasoningText } : {})
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeOpenaiMessageWithNative(
  message: unknown,
  disableShellCoerce: boolean
): unknown {
  const capability = 'normalizeOpenaiMessageJson';
  const fail = (reason?: string) => failNativeRequired<unknown>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(message ?? null);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson, Boolean(disableShellCoerce));
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return fail('invalid payload');
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeOpenaiToolWithNative(tool: unknown): unknown {
  const capability = 'normalizeOpenaiToolJson';
  const fail = (reason?: string) => failNativeRequired<unknown>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(tool ?? null);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return fail('invalid payload');
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeOpenaiChatMessagesWithNative(messages: unknown): unknown[] {
  const capability = 'normalizeOpenaiChatMessagesJson';
  const fail = (reason?: string) => failNativeRequired<unknown[]>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(messages ?? null);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    return Array.isArray(parsed) ? parsed : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeOpenaiToolCallWithNative(
  toolCall: unknown,
  disableShellCoerce: boolean
): unknown {
  const capability = 'normalizeOpenaiToolCallJson';
  const fail = (reason?: string) => failNativeRequired<unknown>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(toolCall ?? null);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson, Boolean(disableShellCoerce));
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return fail('invalid payload');
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function prepareGeminiToolsForBridgeWithNative(
  rawTools: unknown,
  missing: unknown[]
): { defs?: Array<Record<string, unknown>>; missing: Array<Record<string, unknown>> } {
  const capability = 'prepareGeminiToolsForBridgeJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ defs?: Array<Record<string, unknown>>; missing: Array<Record<string, unknown>> }>(
      capability,
      reason
    );
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const rawToolsJson = safeStringify(rawTools ?? null);
  const missingJson = safeStringify(Array.isArray(missing) ? missing : []);
  if (!rawToolsJson || !missingJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(rawToolsJson, missingJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed) {
      return fail('invalid payload');
    }
    const defs = Array.isArray(parsed.defs)
      ? parsed.defs.filter(
          (entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry)
        )
      : undefined;
    const nextMissing = Array.isArray(parsed.missing)
      ? parsed.missing.filter(
          (entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry)
        )
      : [];
    return {
      ...(defs && defs.length ? { defs } : {}),
      missing: nextMissing
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function buildGeminiToolsFromBridgeWithNative(
  defs: unknown,
  mode: 'antigravity' | 'default' = 'default'
): Array<Record<string, unknown>> | undefined {
  const capability = 'buildGeminiToolsFromBridgeJson';
  const fail = (reason?: string) => failNativeRequired<Array<Record<string, unknown>> | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const defsJson = safeStringify(defs ?? null);
  if (!defsJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(defsJson, mode);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    if (parsed == null) {
      return undefined;
    }
    if (!Array.isArray(parsed)) {
      return fail('invalid payload');
    }
    return parsed.filter(
      (entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry)
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function pickResponsesPersistedFieldsWithNative(payload: unknown): Record<string, unknown> {
  const capability = 'pickResponsesPersistedFieldsJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(payload ?? null);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function convertResponsesOutputToInputItemsWithNative(response: unknown): Array<Record<string, unknown>> {
  const capability = 'convertResponsesOutputToInputItemsJson';
  const fail = (reason?: string) => failNativeRequired<Array<Record<string, unknown>>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const responseJson = safeStringify(response ?? null);
  if (!responseJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(responseJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    if (!Array.isArray(parsed)) {
      return fail('invalid payload');
    }
    return parsed.filter(
      (entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry)
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function prepareResponsesConversationEntryWithNative(
  payload: unknown,
  context: unknown
): {
  basePayload: Record<string, unknown>;
  input: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
} {
  const capability = 'prepareResponsesConversationEntryJson';
  const fail = (reason?: string) =>
    failNativeRequired<{
      basePayload: Record<string, unknown>;
      input: Array<Record<string, unknown>>;
      tools?: Array<Record<string, unknown>>;
    }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(payload ?? null);
  const contextJson = safeStringify(context ?? null);
  if (!payloadJson || !contextJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson, contextJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed) {
      return fail('invalid payload');
    }
    const basePayload = parsed.basePayload;
    const input = parsed.input;
    const tools = parsed.tools;
    if (!basePayload || typeof basePayload !== 'object' || Array.isArray(basePayload) || !Array.isArray(input)) {
      return fail('invalid payload');
    }
    return {
      basePayload: basePayload as Record<string, unknown>,
      input: input.filter(
        (entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry)
      ),
      tools: Array.isArray(tools)
        ? tools.filter(
            (entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry)
          )
        : undefined
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resumeResponsesConversationPayloadWithNative(
  entry: unknown,
  responseId: string,
  submitPayload: unknown,
  requestId?: string
): { payload: Record<string, unknown>; meta: Record<string, unknown> } {
  const capability = 'resumeResponsesConversationPayloadJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ payload: Record<string, unknown>; meta: Record<string, unknown> }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const entryJson = safeStringify(entry ?? null);
  const submitPayloadJson = safeStringify(submitPayload ?? null);
  if (!entryJson || !submitPayloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(entryJson, String(responseId ?? ''), submitPayloadJson, requestId);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseResponsesConversationResumeResult(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function enforceChatBudgetWithNative(
  chat: unknown,
  allowedBytes: number,
  systemTextLimit: number
): unknown {
  const capability = 'enforceChatBudgetJson';
  const fail = (reason?: string) => failNativeRequired<unknown>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const chatJson = safeStringify(chat ?? null);
  if (!chatJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(chatJson, Number(allowedBytes), Number(systemTextLimit));
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveBudgetForModelWithNative(
  modelId: string,
  fallback: { maxBytes: number; safetyRatio: number; allowedBytes: number; source: string } | null | undefined
): { maxBytes: number; safetyRatio: number; allowedBytes: number; source: string } {
  const capability = 'resolveBudgetForModelJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ maxBytes: number; safetyRatio: number; allowedBytes: number; source: string }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const fallbackJson = safeStringify(fallback ?? null);
  if (!fallbackJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(String(modelId ?? ''), fallbackJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed) {
      return fail('invalid payload');
    }
    const maxBytes = Number(parsed.maxBytes);
    const safetyRatio = Number(parsed.safetyRatio);
    const allowedBytes = Number(parsed.allowedBytes);
    const source = typeof parsed.source === 'string' ? parsed.source : 'unknown';
    if (!Number.isFinite(maxBytes) || !Number.isFinite(safetyRatio) || !Number.isFinite(allowedBytes)) {
      return fail('invalid payload');
    }
    return { maxBytes, safetyRatio, allowedBytes, source };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function injectMcpToolsForResponsesWithNative(
  tools: unknown[] | undefined,
  discoveredServers: string[]
): unknown[] {
  const capability = 'injectMcpToolsForResponsesJson';
  const fail = (reason?: string) => failNativeRequired<unknown[]>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const toolsJson = safeStringify(Array.isArray(tools) ? tools : []);
  const serversJson = safeStringify(Array.isArray(discoveredServers) ? discoveredServers : []);
  if (!toolsJson || !serversJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(toolsJson, serversJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    return Array.isArray(parsed) ? parsed : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeFunctionCallIdWithNative(input: {
  callId?: string;
  fallback?: string;
}): string {
  const capability = 'normalizeFunctionCallIdJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? {});
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    return typeof raw === 'string' && raw ? raw : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeFunctionCallOutputIdWithNative(input: {
  callId?: string;
  fallback?: string;
}): string {
  const capability = 'normalizeFunctionCallOutputIdJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? {});
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    return typeof raw === 'string' && raw ? raw : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeResponsesCallIdWithNative(input: {
  callId?: string;
  fallback?: string;
}): string {
  const capability = 'normalizeResponsesCallIdJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input ?? {});
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    return typeof raw === 'string' && raw ? raw : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function clampResponsesInputItemIdWithNative(rawValue: unknown): string | undefined {
  const capability = 'clampResponsesInputItemIdJson';
  const fail = (reason?: string) => failNativeRequired<string | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const rawJson = safeStringify(rawValue ?? null);
  if (!rawJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(rawJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    if (parsed === null) {
      return undefined;
    }
    return typeof parsed === 'string' ? parsed : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
