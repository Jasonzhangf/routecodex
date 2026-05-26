import type { JsonObject } from '../../conversion/hub/types/json.js';
import type { ServerToolHandler, ServerToolHandlerContext, ServerToolHandlerPlan } from '../types.js';
import { registerServerToolHandler } from '../registry.js';
import { extractCapturedChatSeed } from '../followup-seed.js';
import { isStopEligibleForServerTool } from '../stop-gateway-context.js';

const FLOW_ID = 'empty_reply_continue';
const CONTINUE_TEXT = '继续执行';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasText(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => hasText(entry));
  }
  const record = asRecord(value);
  if (!record) {
    return false;
  }
  return hasText(record.text) || hasText(record.output_text) || hasText(record.content);
}

function extractChatAssistantMessage(base: JsonObject): Record<string, unknown> | null {
  const choices = Array.isArray((base as Record<string, unknown>).choices)
    ? ((base as Record<string, unknown>).choices as unknown[])
    : [];
  const firstChoice = asRecord(choices[0]);
  return asRecord(firstChoice?.message);
}

function extractResponsesAssistantText(base: JsonObject): string {
  const output = Array.isArray((base as Record<string, unknown>).output)
    ? ((base as Record<string, unknown>).output as unknown[])
    : [];
  const textParts: string[] = [];
  for (const item of output) {
    const row = asRecord(item);
    if (!row) continue;
    if (typeof row.role === 'string' && row.role.trim().toLowerCase() !== 'assistant') continue;
    const content = Array.isArray(row.content) ? row.content : [];
    for (const part of content) {
      const partRow = asRecord(part);
      if (!partRow) continue;
      const text = typeof partRow.text === 'string'
        ? partRow.text
        : typeof partRow.output_text === 'string'
          ? partRow.output_text
          : '';
      if (text.trim()) {
        textParts.push(text);
      }
    }
  }
  return textParts.join('');
}

function extractTruncatedAssistantText(base: JsonObject): string {
  const message = extractChatAssistantMessage(base);
  if (message) {
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      return '';
    }
    const content = typeof message.content === 'string' ? message.content : '';
    return content.trim();
  }
  return extractResponsesAssistantText(base).trim();
}

function isReasoningOnlyChatMessage(message: Record<string, unknown> | null): boolean {
  if (!message) {
    return false;
  }
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return false;
  }
  if (hasText(message.content)) {
    return false;
  }
  return hasText([
    message.reasoning_content,
    message.reasoning,
    message.reasoning_text,
    message.thinking,
  ]);
}

function isEmptyResponsesPayload(base: JsonObject): boolean {
  const output = Array.isArray((base as Record<string, unknown>).output)
    ? ((base as Record<string, unknown>).output as unknown[])
    : [];
  if (output.length === 0) {
    return true;
  }
  for (const item of output) {
    const row = asRecord(item);
    if (!row) continue;
    const type = typeof row.type === 'string' ? row.type.trim().toLowerCase() : '';
    if (type === 'function_call' || type === 'tool_call' || type === 'tool_use' || type.includes('tool')) {
      return false;
    }
    if (hasText(row.text) || hasText(row.output_text) || hasText(row.content)) {
      return false;
    }
  }
  return true;
}

function shouldTrigger(base: JsonObject): boolean {
  const choices = Array.isArray((base as Record<string, unknown>).choices)
    ? ((base as Record<string, unknown>).choices as unknown[])
    : [];
  if (choices.length > 0) {
    const firstChoice = asRecord(choices[0]);
    const finishReason = typeof firstChoice?.finish_reason === 'string'
      ? String(firstChoice.finish_reason).trim().toLowerCase()
      : '';
    if (finishReason !== 'length' && finishReason !== 'stop') {
      return false;
    }
    const message = asRecord(firstChoice?.message);
    if (isReasoningOnlyChatMessage(message)) {
      return false;
    }
    if (finishReason === 'length') {
      return true;
    }
    return !hasText(message?.content);
  }
  if (!isStopEligibleForServerTool(base)) {
    return false;
  }
  return isEmptyResponsesPayload(base);
}

const handler: ServerToolHandler = async (ctx: ServerToolHandlerContext): Promise<ServerToolHandlerPlan | null> => {
  if (!ctx.capabilities.reenterPipeline) {
    return null;
  }
  const seed = extractCapturedChatSeed((ctx.adapterContext as Record<string, unknown> | undefined)?.capturedChatRequest);
  if (!seed || !Array.isArray(seed.messages) || seed.messages.length === 0) {
    return null;
  }
  if (!shouldTrigger(ctx.base)) {
    return null;
  }
  const truncatedAssistantText = extractTruncatedAssistantText(ctx.base);
  return {
    flowId: FLOW_ID,
    finalize: async () => ({
      chatResponse: ctx.base,
      execution: {
        flowId: FLOW_ID,
        followup: {
          requestIdSuffix: ':empty_reply_continue_followup',
          entryEndpoint: ctx.entryEndpoint,
          injection: {
            ops: [
              { op: 'append_assistant_message', required: false },
              { op: 'append_user_text', text: truncatedAssistantText ? `${truncatedAssistantText}\n\n${CONTINUE_TEXT}` : CONTINUE_TEXT }
            ]
          },
          metadata: {
            stream: false,
            preserveRouteHint: false,
            disableStickyRoutes: true
          }
        }
      }
    })
  };
};

registerServerToolHandler('empty_reply_continue', handler, { trigger: 'auto', hook: { phase: 'default', priority: 20 } });
