import { applyQwenChatWebRequestTransform } from '../../../../sharedmodule/llmswitch-core/dist/conversion/compat/actions/qwenchat-web-request.js';

export type StandardToolTextRequestPayload = Record<string, unknown>;
export type StandardToolTextRequestContext = Record<string, unknown>;

const TOOL_REGISTRY_FAILURE_RE = /\bTool\s+[A-Za-z0-9_.:/-]+\s+does\s+not\s+exists\b/i;
const TOOL_REGISTRY_FAILURE_GLOBAL_RE = /\bTool\s+[A-Za-z0-9_.:/-]+\s+does\s+not\s+exists\b/gi;
const TOOL_INFRA_FAILURE_RE =
  /(工具(?:基础设施|执行链路|执行层).{0,24}(?:不可用|无响应|异常)|当前\s*(?:session|会话).{0,24}工具.{0,24}(?:不可用|无响应|异常)|tool\s+(?:execution\s+layer|infrastructure).{0,24}(?:unavailable|no\s+response|broken|failed))/i;

function normalizeScanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === 'string') {
      const text = item.trim();
      if (text) {
        parts.push(text);
      }
      continue;
    }
    if (!item || typeof item !== 'object') {
      continue;
    }
    const node = item as Record<string, unknown>;
    const candidates = [
      node.text,
      node.output_text,
      node.input_text,
      node.content,
      node.reasoning_text,
      node.summary_text
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        parts.push(candidate.trim());
        break;
      }
    }
  }
  return parts.join('\n');
}

function isAssistantToolRegistryFailureMessage(message: unknown): boolean {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return false;
  }
  const node = message as Record<string, unknown>;
  const role = typeof node.role === 'string' ? node.role.trim().toLowerCase() : '';
  if (role !== 'assistant') {
    return false;
  }
  const text = normalizeScanText(extractTextFromContent(node.content));
  if (!text) {
    return false;
  }
  return TOOL_REGISTRY_FAILURE_RE.test(text) || TOOL_INFRA_FAILURE_RE.test(text);
}

function countToolRegistryFailureMentions(text: string): number {
  return normalizeScanText(text).match(TOOL_REGISTRY_FAILURE_GLOBAL_RE)?.length || 0;
}

function isHistoricalToolFailureNoiseMessage(message: unknown, isLast: boolean): boolean {
  if (isLast || !message || typeof message !== 'object' || Array.isArray(message)) {
    return false;
  }
  const node = message as Record<string, unknown>;
  const text = normalizeScanText(extractTextFromContent(node.content));
  if (!text) {
    return false;
  }
  if (isAssistantToolRegistryFailureMessage(message)) {
    return true;
  }
  if (TOOL_INFRA_FAILURE_RE.test(text)) {
    return true;
  }
  return countToolRegistryFailureMentions(text) >= 2;
}

function sanitizeHistoricalToolFailureNoise<T>(items: T[]): T[] {
  let changed = false;
  const lastIndex = items.length - 1;
  const filtered = items.filter((item, index) => {
    const drop = isHistoricalToolFailureNoiseMessage(item, index === lastIndex);
    if (drop) {
      changed = true;
      return false;
    }
    return true;
  });
  return changed ? filtered : items;
}

function sanitizeToolTextTransformPayload(
  payload: StandardToolTextRequestPayload
): StandardToolTextRequestPayload {
  let next: StandardToolTextRequestPayload = payload;
  if (Array.isArray(payload.messages)) {
    const sanitizedMessages = sanitizeHistoricalToolFailureNoise(payload.messages);
    if (sanitizedMessages !== payload.messages) {
      next = {
        ...next,
        messages: sanitizedMessages
      };
    }
  }
  if (Array.isArray(payload.input)) {
    const sanitizedInput = sanitizeHistoricalToolFailureNoise(payload.input);
    if (sanitizedInput !== payload.input) {
      next = {
        ...next,
        input: sanitizedInput
      };
    }
  }
  return next;
}

export const standardToolTextRequestTransformRuntime = {
  transform(
    payload: StandardToolTextRequestPayload,
    adapterContext?: StandardToolTextRequestContext
  ): StandardToolTextRequestPayload {
    return applyQwenChatWebRequestTransform(
      payload as any,
      adapterContext as any
    ) as StandardToolTextRequestPayload;
  }
};

/**
 * Provider-agnostic text-tool request normalization entry.
 *
 * NOTE:
 * - Current implementation reuses the qwenchat-web compat profile in llmswitch-core.
 * - Keep this wrapper neutral so provider code no longer couples to DeepSeek naming.
 */
export function applyStandardToolTextRequestTransform(
  payload: StandardToolTextRequestPayload,
  adapterContext?: StandardToolTextRequestContext
): StandardToolTextRequestPayload {
  return standardToolTextRequestTransformRuntime.transform(
    sanitizeToolTextTransformPayload(payload),
    adapterContext
  );
}
