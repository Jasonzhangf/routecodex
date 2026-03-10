import { extractOutputSegments } from './output-content-normalizer.js';
import { createBridgeActionState, runBridgeActionPipeline } from '../bridge-actions.js';
import { resolveBridgePolicy, resolvePolicyActions } from '../bridge-policies.js';
import {
  registerResponsesPayloadSnapshot,
  registerResponsesPassthrough,
  type ResponsesReasoningPayload
} from './responses-reasoning-registry.js';
import {
  buildChatResponseFromResponsesWithNative,
  collectToolCallsFromResponsesWithNative,
  normalizeFunctionCallIdWithNative,
  resolveFinishReasonWithNative,
  sanitizeReasoningTaggedTextWithNative
} from '../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';
import { sanitizeResponsesFunctionNameWithNative } from '../../router/virtual-router/engine-selection/native-hub-pipeline-resp-semantics.js';

type UnknownRecord = Record<string, unknown>;

function selectCallId(entry: any): string | undefined {
  const candidates = [
    (entry as any)?.call_id,
    (entry as any)?.tool_call_id,
    (entry as any)?.tool_use_id,
    (entry as any)?.id
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

function normalizeToolCall(entry: any, fallbackPrefix: string): Record<string, unknown> | null {
  if (!entry || typeof entry !== 'object') return null;
  const fn = (entry as any).function || {};
  const rawName = sanitizeResponsesFunctionNameWithNative(fn.name ?? (entry as any).name);
  if (!rawName) return null;
  const argsRaw = fn.arguments ?? (entry as any).arguments ?? {};
  const argsStr =
    typeof argsRaw === 'string'
      ? argsRaw
      : (() => {
          try {
            return JSON.stringify(argsRaw ?? {});
          } catch {
            return '{}';
          }
        })();
  const callIdRaw = selectCallId(entry);
  const callId =
    typeof callIdRaw === 'string' && callIdRaw.length
      ? callIdRaw
      : normalizeFunctionCallIdWithNative({
          callId: callIdRaw,
          fallback: `${fallbackPrefix}_${Math.random().toString(36).slice(2, 10)}`
        });
  return {
    id: callId,
    type: 'function',
    function: {
      name: rawName,
      arguments: argsStr
    }
  };
}

export function collectToolCallsFromResponses(response: Record<string, unknown>): Array<Record<string, unknown>> {
  return collectToolCallsFromResponsesWithNative(response);
}

export function resolveFinishReason(response: Record<string, unknown>, toolCalls: Array<Record<string, unknown>>): string {
  return resolveFinishReasonWithNative(response, toolCalls);
}

function unwrapResponsesResponse(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  if (typeof (payload as any).object === 'string' && (payload as any).object === 'response') {
    return payload;
  }
  if (
    Array.isArray((payload as any).output) ||
    typeof (payload as any).status === 'string' ||
    (payload as any).required_action
  ) {
    return payload;
  }
  let current: any = payload;
  const visited = new Set<any>();
  while (current && typeof current === 'object' && !Array.isArray(current)) {
    if (visited.has(current)) break;
    visited.add(current);
    if (typeof current.object === 'string' && current.object === 'response') {
      return current as Record<string, unknown>;
    }
    if (current.response && typeof current.response === 'object') {
      current = current.response;
      continue;
    }
    if (current.data && typeof current.data === 'object') {
      current = current.data;
      continue;
    }
    break;
  }
  return undefined;
}

function collectRawReasoningSegments(response: Record<string, unknown>): string[] {
  const segments: string[] = [];
  const outputItems = Array.isArray((response as any).output) ? (response as any).output : [];
  for (const item of outputItems) {
    if (!item || typeof item !== 'object') continue;
    const type = typeof (item as any).type === 'string' ? String((item as any).type).toLowerCase() : '';
    if (type !== 'reasoning') continue;
    const content = Array.isArray((item as any).content) ? (item as any).content : [];
    for (const part of content) {
      if (part && typeof part === 'object' && typeof (part as any).text === 'string') {
        segments.push((part as any).text as string);
      }
    }
  }
  return segments;
}

function collectReasoningSummarySegments(response: Record<string, unknown>): string[] {
  const segments: string[] = [];
  const outputItems = Array.isArray((response as any).output) ? (response as any).output : [];
  for (const item of outputItems) {
    if (!item || typeof item !== 'object') continue;
    const type = typeof (item as any).type === 'string' ? String((item as any).type).toLowerCase() : '';
    if (type !== 'reasoning') continue;
    const summary = Array.isArray((item as any).summary) ? (item as any).summary : [];
    for (const entry of summary) {
      if (typeof entry === 'string') {
        segments.push(entry);
        continue;
      }
      if (entry && typeof entry === 'object' && typeof (entry as any).text === 'string') {
        segments.push((entry as any).text);
      }
    }
  }
  return segments;
}

function collectReasoningEncryptedContent(response: Record<string, unknown>): string | undefined {
  const outputItems = Array.isArray((response as any).output) ? (response as any).output : [];
  for (const item of outputItems) {
    if (!item || typeof item !== 'object') continue;
    const type = typeof (item as any).type === 'string' ? String((item as any).type).toLowerCase() : '';
    if (type !== 'reasoning') continue;
    const encrypted = (item as any).encrypted_content;
    if (typeof encrypted === 'string' && encrypted.trim().length) {
      return encrypted;
    }
  }
  return undefined;
}

function buildReasoningPayload(options: {
  summarySegments: string[];
  contentSegments: string[];
  encryptedContent?: string;
}): ResponsesReasoningPayload | undefined {
  const { summarySegments, contentSegments, encryptedContent } = options;
  const summary = summarySegments.length
    ? summarySegments.map((text) => ({ type: 'summary_text' as const, text }))
    : undefined;
  const content = contentSegments.length
    ? contentSegments.map((text) => ({ type: 'reasoning_text' as const, text }))
    : undefined;
  if (!summary && !content && encryptedContent === undefined) {
    return undefined;
  }
  return {
    summary,
    content,
    encrypted_content: encryptedContent
  };
}

function registerPassthroughSnapshot(payload: Record<string, unknown>): void {
  const ids = new Set<string>();
  const requestId = typeof (payload as any)?.request_id === 'string' ? ((payload as any).request_id as string).trim() : '';
  const id = typeof (payload as any)?.id === 'string' ? ((payload as any).id as string).trim() : '';
  if (requestId.length) ids.add(requestId);
  if (id.length) ids.add(id);
  for (const candidate of ids) {
    registerResponsesPassthrough(candidate, payload);
  }
}

function cloneSnapshot(value: Record<string, unknown>): Record<string, unknown> | undefined {
  try {
    const structuredCloneImpl = (globalThis as { structuredClone?: <T>(input: T) => T }).structuredClone;
    if (typeof structuredCloneImpl === 'function') {
      return structuredCloneImpl(value);
    }
  } catch {
    /* ignore structuredClone failures */
  }
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return { ...value };
  }
}

export function buildChatResponseFromResponses(payload: unknown): Record<string, unknown> | unknown {
  if (!payload || typeof payload !== 'object') return payload;
  if (typeof buildChatResponseFromResponsesWithNative !== 'function') {
    throw new Error('[responses-response-utils] native bindings unavailable');
  }

  const response = unwrapResponsesResponse(payload as Record<string, unknown>);
  if (!response) {
    if (Array.isArray((payload as any).choices)) {
      registerPassthroughSnapshot(payload as Record<string, unknown>);
      return payload;
    }
    return payload;
  }

  const chat = buildChatResponseFromResponsesWithNative(response) as Record<string, unknown> | null;
  if (!chat || typeof chat !== 'object' || Array.isArray(chat)) {
    return payload;
  }

  const choices = Array.isArray((chat as any).choices) ? (chat as any).choices : [];
  const primary = choices[0] && typeof choices[0] === 'object' ? choices[0] : undefined;
  const message = primary && typeof (primary as any).message === 'object'
    ? ((primary as any).message as Record<string, unknown>)
    : undefined;
  try {
    if (message) {
      const bridgePolicy = resolveBridgePolicy({ protocol: 'openai-responses', moduleType: 'openai-responses' });
      const policyActions = resolvePolicyActions(bridgePolicy, 'response_inbound');
      if (policyActions?.length) {
        const actionState = createBridgeActionState({
          messages: [message],
          rawResponse: response as Record<string, unknown>
        });
        runBridgeActionPipeline({
        stage: 'response_inbound',
        actions: policyActions,
        protocol: bridgePolicy?.protocol ?? 'openai-responses',
        moduleType: bridgePolicy?.moduleType ?? 'openai-responses',
        requestId: typeof response?.id === 'string' ? response.id : undefined,
          state: actionState
        });
      }
    }
  } catch {
    // Ignore policy errors
  }

  const id = typeof (chat as any).id === 'string' ? (chat as any).id : undefined;
  const requestId = typeof (chat as any).request_id === 'string'
    ? (chat as any).request_id
    : (typeof (response as any).request_id === 'string' ? (response as any).request_id : undefined);
  if (id) {
    registerResponsesPayloadSnapshot(id, response);
  }
  if (requestId) {
    registerResponsesPayloadSnapshot(requestId, response);
  }
  const snapshot = cloneSnapshot(response);
  if (snapshot) {
    (chat as any).__responses_payload_snapshot = snapshot;
  }
  return chat;
}
