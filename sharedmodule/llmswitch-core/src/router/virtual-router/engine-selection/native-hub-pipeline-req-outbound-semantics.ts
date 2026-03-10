import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import { loadNativeRouterHotpathBindingForInternalUse } from './native-router-hotpath.js';
import type { JsonObject } from '../../../conversion/hub/types/json.js';

export interface NativeReqOutboundContextMergePlanInput {
  snapshot?: Record<string, unknown>;
  existingToolOutputs?: unknown[];
  hasExistingTools: boolean;
}

export interface NativeReqOutboundFormatBuildInput {
  formatEnvelope: Record<string, unknown>;
  protocol: string;
}

export interface NativeReqOutboundContextMergePlan {
  mergedToolOutputs?: Array<{ tool_call_id: string; content: string; name?: string }>;
  normalizedTools?: unknown[];
}

export interface NativeReqOutboundContextSnapshotPatchInput {
  chatEnvelope: Record<string, unknown>;
  snapshot: Record<string, unknown>;
}

export interface NativeReqOutboundContextSnapshotPatch {
  toolOutputs?: Array<{ tool_call_id: string; content: string; name?: string }>;
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description?: string;
      parameters: unknown;
      strict?: boolean;
    };
  }>;
}

export interface NativeReqOutboundCompatAdapterContextInput {
  __rt?: Record<string, unknown>;
  compatibilityProfile?: string;
  providerProtocol?: string;
  providerId?: string;
  providerKey?: string;
  runtimeKey?: string;
  requestId?: string;
  clientRequestId?: string;
  groupRequestId?: string;
  sessionId?: string;
  conversationId?: string;
  entryEndpoint?: string;
  routeId?: string;
  capturedChatRequest?: JsonObject;
  deepseek?: Record<string, unknown>;
  claudeCode?: Record<string, unknown>;
  estimatedInputTokens?: number;
  modelId?: string;
  clientModelId?: string;
  originalModelId?: string;
}

export interface NativeReqOutboundStandardizedToChatInput {
  request: JsonObject;
  adapterContext: NativeReqOutboundCompatAdapterContextInput;
}

export interface NativeReqOutboundStage3CompatInput {
  payload: JsonObject;
  adapterContext: NativeReqOutboundCompatAdapterContextInput;
  explicitProfile?: string;
}

export interface NativeReqOutboundStage3CompatOutput {
  payload: JsonObject;
  appliedProfile?: string;
  nativeApplied: boolean;
  rateLimitDetected?: boolean;
}

export interface NativeRespInboundStage3CompatInput {
  payload: JsonObject;
  adapterContext: NativeReqOutboundCompatAdapterContextInput;
  explicitProfile?: string;
}

export type NativeRespInboundStage3CompatOutput = NativeReqOutboundStage3CompatOutput;

export interface NativeToolSessionCompatInput {
  messages: unknown[];
  toolOutputs?: unknown[];
}

export interface NativeToolSessionCompatOutput {
  messages: unknown[];
  toolOutputs?: unknown[];
}

export interface NativeToolSessionHistoryUpdateInput {
  messages: unknown[];
  existingHistory?: {
    lastMessages: Array<{
      role: string;
      toolUse?: { id: string; name?: string };
      toolResult?: { id: string; name?: string; status: string };
      ts: string;
    }>;
    pendingToolUses: Record<string, { name?: string; ts: string }>;
    updatedAt: string;
  };
  maxMessages?: number;
  nowIso?: string;
}

export interface NativeToolSessionHistoryUpdateOutput {
  history?: {
    lastMessages: Array<{
      role: string;
      toolUse?: { id: string; name?: string };
      toolResult?: { id: string; name?: string; status: string };
      ts: string;
    }>;
    pendingToolUses: Record<string, { name?: string; ts: string }>;
    updatedAt: string;
  };
  recordsCount: number;
}

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

function parseRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseNormalizedToolDefinitions(
  candidate: unknown
):
  | Array<{
      type: 'function';
      function: {
        name: string;
        description?: string;
        parameters: unknown;
        strict?: boolean;
      };
    }>
  | null {
  if (!Array.isArray(candidate)) {
    return null;
  }
  const tools: Array<{
    type: 'function';
    function: {
      name: string;
      description?: string;
      parameters: unknown;
      strict?: boolean;
    };
  }> = [];
  for (const entry of candidate) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const row = entry as Record<string, unknown>;
    if (row.type !== 'function') {
      continue;
    }
    const fn = row.function;
    if (!fn || typeof fn !== 'object' || Array.isArray(fn)) {
      continue;
    }
    const fnRow = fn as Record<string, unknown>;
    const name = typeof fnRow.name === 'string' && fnRow.name.trim() ? fnRow.name.trim() : '';
    if (!name) {
      continue;
    }
    const description = typeof fnRow.description === 'string' ? fnRow.description : undefined;
    const strict = typeof fnRow.strict === 'boolean' ? fnRow.strict : undefined;
    const parameters = fnRow.parameters ?? { type: 'object', properties: {} };
    tools.push({
      type: 'function',
      function: {
        name,
        ...(description ? { description } : {}),
        parameters,
        ...(strict !== undefined ? { strict } : {})
      }
    });
  }
  return tools;
}

function parseReqOutboundContextMergePlan(raw: string): NativeReqOutboundContextMergePlan | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    const out: NativeReqOutboundContextMergePlan = {};

    const mergedToolOutputs = row.mergedToolOutputs;
    if (mergedToolOutputs !== undefined) {
      if (!Array.isArray(mergedToolOutputs)) {
        return null;
      }
      const normalized: Array<{ tool_call_id: string; content: string; name?: string }> = [];
      for (const entry of mergedToolOutputs) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          return null;
        }
        const rowEntry = entry as Record<string, unknown>;
        const toolCallId =
          typeof rowEntry.tool_call_id === 'string'
            ? rowEntry.tool_call_id.trim()
            : typeof rowEntry.toolCallId === 'string'
              ? rowEntry.toolCallId.trim()
              : '';
        const content = typeof rowEntry.content === 'string' ? rowEntry.content : undefined;
        if (!toolCallId || content === undefined) {
          return null;
        }
        const name = typeof rowEntry.name === 'string' && rowEntry.name.trim() ? rowEntry.name.trim() : undefined;
        normalized.push({ tool_call_id: toolCallId, content, ...(name ? { name } : {}) });
      }
      out.mergedToolOutputs = normalized;
    }

    const normalizedTools = row.normalizedTools;
    if (normalizedTools !== undefined) {
      const parsedTools = parseNormalizedToolDefinitions(normalizedTools);
      if (parsedTools === null) {
        return null;
      }
      out.normalizedTools = parsedTools;
    }

    return out;
  } catch {
    return null;
  }
}

function parseReqOutboundContextSnapshotPatch(raw: string): NativeReqOutboundContextSnapshotPatch | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    const out: NativeReqOutboundContextSnapshotPatch = {};

    const toolOutputs = row.toolOutputs;
    if (toolOutputs !== undefined) {
      if (!Array.isArray(toolOutputs)) {
        return null;
      }
      const normalized: Array<{ tool_call_id: string; content: string; name?: string }> = [];
      for (const entry of toolOutputs) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          return null;
        }
        const rowEntry = entry as Record<string, unknown>;
        const toolCallId =
          typeof rowEntry.tool_call_id === 'string'
            ? rowEntry.tool_call_id.trim()
            : typeof rowEntry.toolCallId === 'string'
              ? rowEntry.toolCallId.trim()
              : '';
        const content = typeof rowEntry.content === 'string' ? rowEntry.content : undefined;
        if (!toolCallId || content === undefined) {
          return null;
        }
        const name = typeof rowEntry.name === 'string' && rowEntry.name.trim() ? rowEntry.name.trim() : undefined;
        normalized.push({ tool_call_id: toolCallId, content, ...(name ? { name } : {}) });
      }
      out.toolOutputs = normalized;
    }

    const toolsRaw = row.tools;
    if (toolsRaw !== undefined) {
      const parsedTools = parseNormalizedToolDefinitions(toolsRaw);
      if (parsedTools === null) {
        return null;
      }
      out.tools = parsedTools;
    }

    return out;
  } catch {
    return null;
  }
}

function parseReqOutboundCompatOutput(raw: string): NativeReqOutboundStage3CompatOutput | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    const payloadRaw = row.payload;
    if (!payloadRaw || typeof payloadRaw !== 'object' || Array.isArray(payloadRaw)) {
      return null;
    }
    const payload = payloadRaw as JsonObject;
    const appliedProfileRaw = row.appliedProfile;
    const appliedProfile = typeof appliedProfileRaw === 'string' && appliedProfileRaw.trim()
      ? appliedProfileRaw.trim()
      : undefined;
    const nativeAppliedRaw = row.nativeApplied;
    if (typeof nativeAppliedRaw !== 'boolean') {
      return null;
    }
    const nativeApplied = nativeAppliedRaw;
    const rateLimitDetectedRaw = row.rateLimitDetected;
    const rateLimitDetected =
      typeof rateLimitDetectedRaw === 'boolean' ? rateLimitDetectedRaw : undefined;
    return {
      payload,
      ...(appliedProfile ? { appliedProfile } : {}),
      nativeApplied,
      ...(rateLimitDetected !== undefined ? { rateLimitDetected } : {})
    };
  } catch {
    return null;
  }
}

function parseToolSessionCompatOutput(raw: string): NativeToolSessionCompatOutput | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    const messagesRaw = row.messages;
    if (!Array.isArray(messagesRaw)) {
      return null;
    }
    const out: NativeToolSessionCompatOutput = {
      messages: messagesRaw
    };
    if (Object.prototype.hasOwnProperty.call(row, 'toolOutputs')) {
      if (row.toolOutputs == null) {
        out.toolOutputs = undefined;
      } else if (Array.isArray(row.toolOutputs)) {
        out.toolOutputs = row.toolOutputs;
      } else {
        return null;
      }
    }
    return out;
  } catch {
    return null;
  }
}

function parseToolSessionHistoryUpdateOutput(raw: string): NativeToolSessionHistoryUpdateOutput | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    const recordsCount = typeof row.recordsCount === 'number' && Number.isFinite(row.recordsCount)
      ? row.recordsCount
      : null;
    if (recordsCount === null) {
      return null;
    }
    const output: NativeToolSessionHistoryUpdateOutput = { recordsCount };
    if (row.history !== undefined) {
      if (!row.history || typeof row.history !== 'object' || Array.isArray(row.history)) {
        return null;
      }
      output.history = row.history as NativeToolSessionHistoryUpdateOutput['history'];
    }
    return output;
  } catch {
    return null;
  }
}

function parseJsonObject(raw: string): JsonObject | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as JsonObject;
  } catch {
    return null;
  }
}

function parseReqOutboundFormatBuildOutput(raw: string): JsonObject | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    const payload = row.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null;
    }
    return payload as JsonObject;
  } catch {
    return null;
  }
}

export function resolveReqOutboundContextMergePlanWithNative(
  input: NativeReqOutboundContextMergePlanInput
): NativeReqOutboundContextMergePlan {
  const capability = 'resolveReqOutboundContextMergePlanJson';
  const fail = (reason?: string) => failNativeRequired<NativeReqOutboundContextMergePlan>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('resolveReqOutboundContextMergePlanJson');
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input);
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseReqOutboundContextMergePlan(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function buildReqOutboundFormatPayloadWithNative(
  input: NativeReqOutboundFormatBuildInput
): JsonObject {
  const capability = 'buildFormatRequestJson';
  const fail = (reason?: string) => failNativeRequired<JsonObject>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify({
    formatEnvelope: input.formatEnvelope,
    protocol: input.protocol
  });
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseReqOutboundFormatBuildOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function applyReqOutboundContextSnapshotWithNative(
  input: NativeReqOutboundContextSnapshotPatchInput
): NativeReqOutboundContextSnapshotPatch {
  const capability = 'applyReqOutboundContextSnapshotJson';
  const fail = (reason?: string) => failNativeRequired<NativeReqOutboundContextSnapshotPatch>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('applyReqOutboundContextSnapshotJson');
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input);
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseReqOutboundContextSnapshotPatch(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function runReqOutboundStage3CompatWithNative(
  input: NativeReqOutboundStage3CompatInput
): NativeReqOutboundStage3CompatOutput {
  const capability = 'runReqOutboundStage3CompatJson';
  const fail = (reason?: string) => failNativeRequired<NativeReqOutboundStage3CompatOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('runReqOutboundStage3CompatJson');
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input);
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseReqOutboundCompatOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function runRespInboundStage3CompatWithNative(
  input: NativeRespInboundStage3CompatInput
): NativeRespInboundStage3CompatOutput {
  const capability = 'runRespInboundStage3CompatJson';
  const fail = (reason?: string) => failNativeRequired<NativeRespInboundStage3CompatOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('runRespInboundStage3CompatJson');
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input);
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseReqOutboundCompatOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeToolSessionMessagesWithNative(
  input: NativeToolSessionCompatInput
): NativeToolSessionCompatOutput {
  const capability = 'normalizeToolSessionMessagesJson';
  const fail = (reason?: string) => failNativeRequired<NativeToolSessionCompatOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input);
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseToolSessionCompatOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function updateToolSessionHistoryWithNative(
  input: NativeToolSessionHistoryUpdateInput
): NativeToolSessionHistoryUpdateOutput {
  const capability = 'updateToolSessionHistoryJson';
  const fail = (reason?: string) => failNativeRequired<NativeToolSessionHistoryUpdateOutput>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const inputJson = safeStringify(input);
  if (!inputJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseToolSessionHistoryUpdateOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function applyClaudeThinkingToolSchemaCompatWithNative(
  payload: JsonObject
): JsonObject {
  const capability = 'applyClaudeThinkingToolSchemaCompatJson';
  const fail = (reason?: string) => failNativeRequired<JsonObject>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(payload);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJsonObject(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function standardizedToChatEnvelopeWithNative(
  input: NativeReqOutboundStandardizedToChatInput
): JsonObject {
  const capability = 'standardizedToChatEnvelopeJson';
  const fail = (reason?: string) => failNativeRequired<JsonObject>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const requestJson = safeStringify(input.request);
  const adapterContextJson = safeStringify(input.adapterContext);
  if (!requestJson || !adapterContextJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(requestJson, adapterContextJson);
    if (raw instanceof Error) {
      return fail(raw.message || 'native error');
    }
    if (raw && typeof raw === 'object' && 'message' in (raw as Record<string, unknown>)) {
      const message = (raw as Record<string, unknown>).message;
      if (typeof message === 'string' && message.trim().length) {
        return fail(message.trim());
      }
    }
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    return (parsed as JsonObject | null) ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

function parseBoolean(raw: string): boolean | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'boolean' ? parsed : null;
  } catch {
    return null;
  }
}

export function shouldAttachReqOutboundContextSnapshotWithNative(
  hasSnapshot: boolean,
  contextMetadataKey: string | undefined
): boolean {
  const capability = 'shouldAttachReqOutboundContextSnapshotJson';
  const fail = (reason?: string) => failNativeRequired<boolean>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction('shouldAttachReqOutboundContextSnapshotJson');
  if (!fn) {
    return fail();
  }
  try {
    const contextMetadataKeyJson = JSON.stringify(contextMetadataKey ?? null);
    if (typeof contextMetadataKeyJson !== 'string') {
      return fail('json stringify failed');
    }
    const raw = fn(hasSnapshot, contextMetadataKeyJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseBoolean(raw);
    return parsed === null ? fail('invalid payload') : parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
