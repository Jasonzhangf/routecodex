import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import { ProviderProtocolError } from '../conversion/provider-protocol-error.js';
import { extractCapturedChatSeed } from './followup-seed.js';

export function extractAppendUserTextFromFollowupPlan(followupPlan: unknown): string | undefined {
  if (!followupPlan || typeof followupPlan !== 'object' || Array.isArray(followupPlan)) {
    return undefined;
  }
  const injection = (followupPlan as { injection?: unknown }).injection;
  if (!injection || typeof injection !== 'object' || Array.isArray(injection)) {
    return undefined;
  }
  const ops = Array.isArray((injection as { ops?: unknown }).ops) ? ((injection as { ops: unknown[] }).ops as unknown[]) : [];
  for (const op of ops) {
    if (!op || typeof op !== 'object' || Array.isArray(op)) {
      continue;
    }
    const record = op as Record<string, unknown>;
    if (record.op !== 'append_user_text') {
      continue;
    }
    if (typeof record.text === 'string' && record.text.trim().length > 0) {
      return record.text.trim();
    }
  }
  return undefined;
}

export function coerceFollowupPayloadStream(payload: JsonObject, stream: boolean): JsonObject {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }
  if (stream === false) {
    (payload as Record<string, unknown>).stream = false;
  }
  return payload;
}

function hasNonEmptyText(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => hasNonEmptyText(entry));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (hasNonEmptyText(record.text)) return true;
    if (hasNonEmptyText(record.output_text)) return true;
    if (hasNonEmptyText(record.content)) return true;
  }
  return false;
}

export function isEmptyClientResponsePayload(payload: JsonObject): boolean {
  if (!payload || typeof payload !== 'object') {
    return true;
  }
  if (
    Object.prototype.hasOwnProperty.call(payload as Record<string, unknown>, '__sse_responses')
    || Object.prototype.hasOwnProperty.call(payload as Record<string, unknown>, '__sse_stream')
  ) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(payload as Record<string, unknown>, 'error')) {
    return false;
  }

  const requiredAction = (payload as Record<string, unknown>).required_action;
  if (requiredAction && typeof requiredAction === 'object') {
    return false;
  }
  const outputForResponses = Array.isArray((payload as { output?: unknown }).output)
    ? (((payload as { output: unknown[] }).output) as unknown[])
    : [];
  if (outputForResponses.length > 0) {
    for (const item of outputForResponses) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const type = typeof (item as { type?: unknown }).type === 'string' ? String((item as { type: string }).type).trim().toLowerCase() : '';
      if (type === 'function_call' || type === 'tool_call' || type === 'tool_use' || type.includes('tool')) {
        return false;
      }
    }
  }

  const choices = Array.isArray((payload as { choices?: unknown }).choices)
    ? (((payload as { choices: unknown[] }).choices) as unknown[])
    : [];
  if (choices.length > 0) {
    const first = choices[0] && typeof choices[0] === 'object' && !Array.isArray(choices[0]) ? choices[0] : null;
    const message =
      first && typeof (first as { message?: unknown }).message === 'object' && (first as { message?: unknown }).message !== null && !Array.isArray((first as { message?: unknown }).message)
        ? ((first as { message: unknown }).message as Record<string, unknown>)
        : null;
    if (!message) {
      return true;
    }
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (toolCalls.length > 0) {
      return false;
    }
    if (hasNonEmptyText(message.content)) return false;
    if (hasNonEmptyText((message as { reasoning_content?: unknown }).reasoning_content)) return false;
    if (hasNonEmptyText((message as { reasoning?: unknown }).reasoning)) return false;
    return true;
  }

  const output = Array.isArray((payload as { output?: unknown }).output)
    ? (((payload as { output: unknown[] }).output) as unknown[])
    : [];
  if (output.length > 0) {
    for (const item of output) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const content = (item as { content?: unknown }).content;
      if (hasNonEmptyText(content)) {
        return false;
      }
      if (hasNonEmptyText((item as { text?: unknown }).text)) return false;
      if (hasNonEmptyText((item as { output_text?: unknown }).output_text)) return false;
    }
    return true;
  }

  return true;
}

export function hasRequiresActionShape(payload: JsonObject): boolean {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  const record = payload as Record<string, unknown>;
  if (record.required_action && typeof record.required_action === 'object') {
    return true;
  }
  const choices = Array.isArray(record.choices) ? (record.choices as Array<Record<string, unknown>>) : [];
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') {
      continue;
    }
    const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason.trim().toLowerCase() : '';
    if (finishReason === 'tool_calls' || finishReason === 'requires_action') {
      return true;
    }
    const message =
      choice.message && typeof choice.message === 'object' && !Array.isArray(choice.message)
        ? (choice.message as Record<string, unknown>)
        : undefined;
    if (message && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      return true;
    }
  }
  const output = Array.isArray(record.output) ? (record.output as Array<Record<string, unknown>>) : [];
  for (const item of output) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const type = typeof item.type === 'string' ? item.type.trim().toLowerCase() : '';
    if (type === 'function_call' || type === 'tool_call' || type === 'tool_use') {
      return true;
    }
  }
  return false;
}

export function choosePreferredFinalChatResponse(args: {
  followupBody?: JsonObject;
  finalChatResponse: JsonObject;
}): JsonObject {
  const followupBody = args.followupBody;
  if (!followupBody || typeof followupBody !== 'object') {
    return args.finalChatResponse;
  }

  if (hasRequiresActionShape(followupBody)) {
    return followupBody;
  }

  if (!isEmptyClientResponsePayload(followupBody)) {
    return followupBody;
  }

  return args.finalChatResponse;
}

export function createEmptyFollowupError(args: {
  flowId?: string;
  requestId: string;
  lastError?: unknown;
  originalResponseWasEmpty?: boolean;
}): ProviderProtocolError & { status?: number; cause?: unknown } {
  const wrapped = new ProviderProtocolError(
    `[servertool] Followup returned empty response for flow ${args.flowId ?? 'unknown'}`,
    {
      code: 'SERVERTOOL_EMPTY_FOLLOWUP',
      category: 'EXTERNAL_ERROR',
      details: {
        flowId: args.flowId,
        requestId: args.requestId,
        error: args.lastError instanceof Error ? args.lastError.message : undefined,
        ...(args.originalResponseWasEmpty ? { originalResponseWasEmpty: true } : {})
      }
    }
  ) as ProviderProtocolError & { status?: number; cause?: unknown };
  wrapped.status = 502;
  wrapped.cause = args.lastError;
  return wrapped;
}

export function createMissingFollowupPayloadError(args: {
  flowId?: string;
  requestId: string;
  followupPlan: unknown;
  adapterContext: AdapterContext;
}): ProviderProtocolError & { status?: number } {
  const followupPlanRecord =
    args.followupPlan && typeof args.followupPlan === 'object' && !Array.isArray(args.followupPlan)
      ? (args.followupPlan as Record<string, unknown>)
      : undefined;
  const capturedChatRequest = (args.adapterContext as Record<string, unknown> | null)?.capturedChatRequest;
  const seedAvailable = Boolean(extractCapturedChatSeed(capturedChatRequest));
  const wrapped = new ProviderProtocolError('[servertool] followup payload missing for non-clientInject flow', {
    code: 'SERVERTOOL_FOLLOWUP_FAILED',
    category: 'INTERNAL_ERROR',
    details: {
      flowId: args.flowId,
      requestId: args.requestId,
      reason: 'followup_payload_missing',
      hasPayloadPlan: Boolean(followupPlanRecord && Object.prototype.hasOwnProperty.call(followupPlanRecord, 'payload')),
      hasInjectionPlan: Boolean(
        followupPlanRecord && Object.prototype.hasOwnProperty.call(followupPlanRecord, 'injection')
      ),
      hasMetadataPlan: Boolean(
        followupPlanRecord && Object.prototype.hasOwnProperty.call(followupPlanRecord, 'metadata')
      ),
      hasCapturedChatRequest: Boolean(
        capturedChatRequest &&
          typeof capturedChatRequest === 'object' &&
          !Array.isArray(capturedChatRequest)
      ),
      capturedSeedAvailable: seedAvailable
    }
  }) as ProviderProtocolError & { status?: number };
  wrapped.status = 502;
  return wrapped;
}
