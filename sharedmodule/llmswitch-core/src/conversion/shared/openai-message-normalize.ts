import { createHash } from 'node:crypto';

import { injectMcpToolsForChat } from '../mcp-injection.js';
import { ProviderProtocolError } from '../provider-protocol-error.js';
import {
  normalizeOpenaiChatMessagesWithNative,
  normalizeOpenaiMessageWithNative,
  normalizeOpenaiToolCallWithNative,
  normalizeOpenaiToolWithNative
} from '../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

const ROUTECODEX_LOCAL_ASSISTANT_PATTERNS: RegExp[] = [
  /^\[RouteCodex\]\s*request timed out before a response was received\b/i,
  /^\[RouteCodex\]\s*assistant response became empty after response sanitization\.?\s*$/i,
  /^\[RouteCodex\]\s*tool output was empty; execution status unknown\.?\s*$/i,
  /^\[RouteCodex\]\s*tool call result unknown\b/i
];
export type ToolHistoryContractViolationCode =
  | 'missing_tool_call_id'
  | 'synthetic_tool_call_id'
  | 'synthetic_local_control_text'
  | 'orphan_tool_result'
  | 'dangling_tool_call';

export type ToolHistoryContractViolation = {
  code: ToolHistoryContractViolationCode;
  index: number;
  callId?: string;
  role?: string;
  itemType?: string;
  reason: string;
};

const SYNTHETIC_SERVERTOOL_ID_PATTERNS: RegExp[] = [
  /^call_servertool_fallback_/i,
  /^call_clock_fallback_/i
];

const INTERNAL_SERVERTOOL_ID_OWNER_NAMES = new Set([
  'clock',
  'continue_execution',
  'reasoning.stop',
  'web_search'
]);

let servertoolToolCallIdSeq = 0;

function sanitizeToolCallToken(value: string, fallback: string): string {
  const normalized = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || fallback;
}

export function isSyntheticRouteCodexToolCallId(callId: string | undefined): boolean {
  if (!callId) {
    return false;
  }
  return SYNTHETIC_SERVERTOOL_ID_PATTERNS.some((pattern) => pattern.test(callId));
}

export function canServerToolOwnToolCallId(toolName: string | undefined): boolean {
  const normalized = sanitizeToolCallToken(
    String(toolName || '').toLowerCase().replace(/\./g, '_'),
    ''
  );
  return INTERNAL_SERVERTOOL_ID_OWNER_NAMES.has(
    normalized === 'reasoning_stop' ? 'reasoning.stop' : normalized
  );
}

export function createServerToolCallId(options: {
  toolName: string;
  requestId?: string;
}): string {
  servertoolToolCallIdSeq += 1;
  const toolToken = sanitizeToolCallToken(
    options.toolName.toLowerCase().replace(/\./g, '_'),
    'servertool'
  );
  const requestToken = sanitizeToolCallToken(String(options.requestId || ''), 'req');
  const digest = createHash('sha256')
    .update(`${requestToken}:${toolToken}:${servertoolToolCallIdSeq}`)
    .digest('hex')
    .slice(0, 24);
  return `call_${digest}`;
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function logNormalizeNonBlocking(
  stage: string,
  error: unknown,
  details: Record<string, unknown> = {}
): void {
  try {
    const detailSuffix = Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(`[openai-message-normalize] ${stage} failed (non-blocking): ${formatUnknownError(error)}${detailSuffix}`);
  } catch {
    // Never throw from non-blocking logging.
  }
}

function isTextLikeContentPart(part: unknown): part is Record<string, unknown> {
  return Boolean(part && typeof part === 'object' && !Array.isArray(part));
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function extractPlainTextFromContent(content: unknown): string | null {
  if (typeof content === 'string') {
    const normalized = normalizeWhitespace(content);
    return normalized.length > 0 ? normalized : null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const fragments: string[] = [];
  for (const part of content) {
    if (!isTextLikeContentPart(part)) {
      return null;
    }
    const text =
      typeof part.text === 'string'
        ? part.text
        : typeof (part as Record<string, unknown>).input_text === 'string'
          ? String((part as Record<string, unknown>).input_text)
          : typeof (part as Record<string, unknown>).output_text === 'string'
            ? String((part as Record<string, unknown>).output_text)
        : typeof part.content === 'string'
          ? part.content
          : null;
    if (text === null) {
      return null;
    }
    const normalized = normalizeWhitespace(text);
    if (normalized.length > 0) {
      fragments.push(normalized);
    }
  }
  if (!fragments.length) {
    return null;
  }
  return fragments.join('\n');
}

function extractPlainTextFromValue(value: unknown): string | null {
  if (typeof value === 'string' || Array.isArray(value)) {
    return extractPlainTextFromContent(value);
  }
  if (!value || typeof value !== 'object') {
    return null;
  }
  const row = value as Record<string, unknown>;
  if (typeof row.text === 'string' || typeof row.content === 'string' || Array.isArray(row.content)) {
    return extractPlainTextFromContent(row.content ?? row.text);
  }
  if (typeof row.output_text === 'string') {
    return extractPlainTextFromContent(row.output_text);
  }
  if (typeof row.output === 'string' || Array.isArray(row.output)) {
    return extractPlainTextFromContent(row.output);
  }
  return null;
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isSyntheticRouteCodexControlText(text: unknown): boolean {
  if (typeof text !== 'string') {
    return false;
  }
  const normalized = normalizeWhitespace(text);
  if (!normalized.startsWith('[RouteCodex]')) {
    return false;
  }
  return ROUTECODEX_LOCAL_ASSISTANT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isSyntheticRouteCodexAssistantMessage(message: unknown): boolean {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return false;
  }
  const role = typeof (message as { role?: unknown }).role === 'string'
    ? String((message as { role?: unknown }).role).trim().toLowerCase()
    : '';
  if (role !== 'assistant') {
    return false;
  }
  const toolCalls = (message as { tool_calls?: unknown }).tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    return false;
  }
  const plainText = extractPlainTextFromContent((message as { content?: unknown }).content);
  return isSyntheticRouteCodexControlText(plainText);
}

export function filterSyntheticRouteCodexAssistantMessages<T extends Record<string, unknown>>(messages: T[]): T[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }
  return messages.filter((message) => !isSyntheticRouteCodexAssistantMessage(message));
}

export function inspectSyntheticRouteCodexAssistantMessages(messages: unknown): ToolHistoryContractViolation | null {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }
  for (const [index, message] of messages.entries()) {
    if (!isSyntheticRouteCodexAssistantMessage(message)) {
      continue;
    }
    const row = message as Record<string, unknown>;
    return {
      code: 'synthetic_local_control_text',
      index,
      role: readTrimmedString(row.role)?.toLowerCase(),
      itemType: 'message',
      reason: 'chat history contains synthetic RouteCodex local control text'
    };
  }
  return null;
}

function isSyntheticRouteCodexBridgeInputItem(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return false;
  }
  const item = entry as {
    type?: unknown;
    role?: unknown;
    content?: unknown;
    message?: { role?: unknown; content?: unknown } | null;
  };
  const role = typeof item.role === 'string' ? item.role.trim().toLowerCase() : '';
  if (item.type === 'message' && role === 'assistant') {
    return isSyntheticRouteCodexControlText(extractPlainTextFromContent(item.content));
  }
  if (item.type === 'message' && role === 'tool') {
    return isSyntheticRouteCodexControlText(extractPlainTextFromValue(item.content));
  }
  if (
    item.type === 'function_call_output'
    || item.type === 'tool_result'
    || item.type === 'tool_message'
  ) {
    return isSyntheticRouteCodexControlText(
      extractPlainTextFromValue((item as { output?: unknown }).output ?? item.content)
    );
  }
  const nestedRole =
    item.message && typeof item.message.role === 'string'
      ? item.message.role.trim().toLowerCase()
      : '';
  if (nestedRole === 'assistant') {
    return isSyntheticRouteCodexControlText(extractPlainTextFromContent(item.message?.content));
  }
  if (nestedRole === 'tool') {
    return isSyntheticRouteCodexControlText(extractPlainTextFromValue(item.message?.content));
  }
  return false;
}

export function inspectSyntheticRouteCodexBridgeInput(input: unknown): ToolHistoryContractViolation | null {
  if (!Array.isArray(input) || input.length === 0) {
    return null;
  }
  for (const [index, entry] of input.entries()) {
    if (!isSyntheticRouteCodexBridgeInputItem(entry)) {
      continue;
    }
    const row = entry as Record<string, unknown>;
    return {
      code: 'synthetic_local_control_text',
      index,
      role: readTrimmedString(row.role)?.toLowerCase(),
      itemType: readTrimmedString(row.type)?.toLowerCase(),
      reason: 'bridge input contains synthetic RouteCodex local control text'
    };
  }
  return null;
}

function finalizePendingToolCalls(
  pendingToolCalls: Map<string, { index: number; role: string; itemType: string }>
): ToolHistoryContractViolation | null {
  const firstPending = pendingToolCalls.entries().next();
  if (firstPending.done) {
    return null;
  }
  const [callId, meta] = firstPending.value;
  return {
    code: 'dangling_tool_call',
    index: meta.index,
    callId,
    role: meta.role,
    itemType: meta.itemType,
    reason: `tool call ${callId} does not have a matching tool result in history`
  };
}

export function inspectOpenAiChatToolHistory(messages: unknown): ToolHistoryContractViolation | null {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }
  const seenToolCalls = new Set<string>();
  const pendingToolCalls = new Map<string, { index: number; role: string; itemType: string }>();
  for (const [index, rawMessage] of messages.entries()) {
    if (!rawMessage || typeof rawMessage !== 'object' || Array.isArray(rawMessage)) {
      continue;
    }
    const message = rawMessage as Record<string, unknown>;
    const role = readTrimmedString(message.role)?.toLowerCase();
    if (role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const rawToolCall of message.tool_calls) {
        if (!rawToolCall || typeof rawToolCall !== 'object' || Array.isArray(rawToolCall)) {
          continue;
        }
        const toolCall = rawToolCall as Record<string, unknown>;
        const callId =
          readTrimmedString(toolCall.id)
          ?? readTrimmedString(toolCall.call_id)
          ?? readTrimmedString(toolCall.tool_call_id);
        if (!callId) {
          return {
            code: 'missing_tool_call_id',
            index,
            role,
            itemType: 'tool_call',
            reason: 'assistant tool_call is missing id/call_id'
          };
        }
        if (isSyntheticRouteCodexToolCallId(callId)) {
          return {
            code: 'synthetic_tool_call_id',
            index,
            callId,
            role,
            itemType: 'tool_call',
            reason: `assistant tool_call uses synthetic RouteCodex fallback id: ${callId}`
          };
        }
        seenToolCalls.add(callId);
        pendingToolCalls.set(callId, {
          index,
          role,
          itemType: 'tool_call'
        });
      }
      continue;
    }
    if (role !== 'tool') {
      continue;
    }
    const callId =
      readTrimmedString(message.tool_call_id)
      ?? readTrimmedString(message.call_id)
      ?? readTrimmedString(message.id);
    if (!callId) {
      return {
        code: 'missing_tool_call_id',
        index,
        role,
        itemType: 'tool_result',
        reason: 'tool message is missing tool_call_id/call_id'
      };
    }
    if (isSyntheticRouteCodexToolCallId(callId)) {
      return {
        code: 'synthetic_tool_call_id',
        index,
        callId,
        role,
        itemType: 'tool_result',
        reason: `tool message uses synthetic RouteCodex fallback id: ${callId}`
      };
    }
    if (!seenToolCalls.has(callId) || !pendingToolCalls.has(callId)) {
      return {
        code: 'orphan_tool_result',
        index,
        callId,
        role,
        itemType: 'tool_result',
        reason: `tool message references unknown or already-consumed tool_call_id: ${callId}`
      };
    }
    pendingToolCalls.delete(callId);
  }
  return finalizePendingToolCalls(pendingToolCalls);
}

export function inspectBridgeInputToolHistory(
  input: unknown,
  options?: {
    allowDanglingToolCalls?: boolean;
  }
): ToolHistoryContractViolation | null {
  if (!Array.isArray(input) || input.length === 0) {
    return null;
  }
  const seenToolCalls = new Set<string>();
  const pendingToolCalls = new Map<string, { index: number; role: string; itemType: string }>();
  for (const [index, rawEntry] of input.entries()) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      continue;
    }
    const entry = rawEntry as Record<string, unknown>;
    const itemType = readTrimmedString(entry.type)?.toLowerCase();
    const role = readTrimmedString(entry.role)?.toLowerCase();
    if (itemType === 'function_call') {
      const callId =
        readTrimmedString(entry.call_id)
        ?? readTrimmedString(entry.tool_call_id)
        ?? readTrimmedString(entry.id);
      if (!callId) {
        return {
          code: 'missing_tool_call_id',
          index,
          role: role ?? 'assistant',
          itemType,
          reason: 'bridge function_call item is missing call_id/id'
        };
      }
      if (isSyntheticRouteCodexToolCallId(callId)) {
        return {
          code: 'synthetic_tool_call_id',
          index,
          callId,
          role: role ?? 'assistant',
          itemType,
          reason: `bridge function_call item uses synthetic RouteCodex fallback id: ${callId}`
        };
      }
      seenToolCalls.add(callId);
      pendingToolCalls.set(callId, {
        index,
        role: role ?? 'assistant',
        itemType
      });
      continue;
    }
    if (
      itemType === 'function_call_output'
      || itemType === 'tool_result'
      || itemType === 'tool_message'
      || (itemType === 'message' && role === 'tool')
    ) {
      const callId =
        readTrimmedString(entry.call_id)
        ?? readTrimmedString(entry.tool_call_id)
        ?? readTrimmedString(entry.tool_use_id)
        ?? readTrimmedString(entry.id);
      if (!callId) {
        return {
          code: 'missing_tool_call_id',
          index,
          role: role ?? 'tool',
          itemType: itemType ?? 'tool_result',
          reason: 'bridge tool result item is missing call_id/tool_call_id'
        };
      }
      if (isSyntheticRouteCodexToolCallId(callId)) {
        return {
          code: 'synthetic_tool_call_id',
          index,
          callId,
          role: role ?? 'tool',
          itemType: itemType ?? 'tool_result',
          reason: `bridge tool result item uses synthetic RouteCodex fallback id: ${callId}`
        };
      }
      if (!seenToolCalls.has(callId) || !pendingToolCalls.has(callId)) {
        return {
          code: 'orphan_tool_result',
          index,
          callId,
          role: role ?? 'tool',
          itemType: itemType ?? 'tool_result',
          reason: `bridge tool result item references unknown or already-consumed call_id: ${callId}`
        };
      }
      pendingToolCalls.delete(callId);
      continue;
    }
  }
  if (options?.allowDanglingToolCalls === true) {
    return null;
  }
  return finalizePendingToolCalls(pendingToolCalls);
}

// Message normalization utilities for OpenAI chat payloads (renamed to avoid confusion
// with the deprecated "openai-normalizer" module entry). This file contains the
// previously-implemented logic from openai-normalize.ts.

// Legacy tooling stage removed for Chat; tool canonicalization lives in codecs

export function normalizeChatRequest(request: any): any {
  if (!request || typeof request !== 'object') return request;
  let normalized = { ...request };

  if (Array.isArray(normalized.messages)) {
    normalized.messages = normalized.messages.map((msg: any) => normalizeMessage(msg));
  }

  if (Array.isArray(normalized.tools)) {
    normalized.tools = normalized.tools.map((tool: any) => normalizeTool(tool));
  }

  // Assistant text limit handling has been moved into native budget enforcement.

  // MCP 注入（两步法）统一走共享实现，避免路径分叉
  const disableMcpTools = Boolean((normalized as any).__rcc_disable_mcp_tools);
  if (!disableMcpTools) {
    try {
      const enableMcp = String((process as any)?.env?.ROUTECODEX_MCP_ENABLE ?? '1') !== '0';
      if (enableMcp) {
        const known = new Set<string>();
        const fromEnv = String((process as any)?.env?.RCC_MCP_SERVERS || '').trim();
        if (fromEnv) {
          for (const s of fromEnv.split(',').map((x: string) => x.trim()).filter(Boolean)) known.add(s);
        }

        const addServer = (v: unknown) => {
          if (typeof v === 'string') {
            const s = v.trim();
            if (s) known.add(s);
          }
        };
        const extractFromOutput = (output: unknown) => {
          try {
            if (Array.isArray(output)) {
              for (const item of output) {
                if (typeof item === 'string') addServer(item);
                else if (item && typeof item === 'object' && !Array.isArray(item)) addServer((item as any).server);
              }
              return;
            }
            if (!output || typeof output !== 'object' || Array.isArray(output)) return;
            const o: any = output;
            if (Array.isArray(o.servers)) for (const s of o.servers) addServer(s);
            if (Array.isArray(o.resources)) for (const r of o.resources) addServer(r?.server ?? r?.source?.server);
            if (Array.isArray(o.resourceTemplates)) for (const t of o.resourceTemplates) addServer(t?.server ?? t?.source?.server);
          } catch {
            // best-effort
          }
        };

        // IMPORTANT: do NOT treat assistant tool_calls as authoritative for MCP server labels
        // (the model may guess "shell"/"exec_command"/etc). Only trust tool results.
        try {
          const msgs = Array.isArray((normalized as any).messages) ? ((normalized as any).messages as any[]) : [];
          for (const m of msgs) {
            if (!m || typeof m !== 'object') continue;
            if (String((m as any).role || '').toLowerCase() !== 'tool') continue;
            const content = (m as any).content;
            if (typeof content !== 'string' || content.trim().length === 0) continue;
            try {
              const parsed: any = JSON.parse(content);
              if (parsed && typeof parsed === 'object' && parsed.version === 'rcc.tool.v1' && parsed.tool?.name) {
                const toolName = String(parsed.tool.name).toLowerCase();
                if (toolName === 'list_mcp_resources') {
                  extractFromOutput(parsed.result?.output);
                }
              } else {
                extractFromOutput(parsed?.output ?? parsed);
              }
            } catch (error) {
              logNormalizeNonBlocking('mcp_injection.parse_tool_message_content', error, {
                toolRole: String((m as any)?.role ?? ''),
                toolName: String((m as any)?.name ?? '')
              });
            }
          }
        } catch (error) {
          logNormalizeNonBlocking('mcp_injection.scan_tool_messages', error, {
            messageCount: Array.isArray((normalized as any).messages) ? (normalized as any).messages.length : 0
          });
        }

        const discovered = Array.from(known);
        const currentTools: any[] = Array.isArray((normalized as any).tools) ? ((normalized as any).tools as any[]) : [];
        (normalized as any).tools = injectMcpToolsForChat(currentTools, discovered);
      }
    } catch (error) {
      logNormalizeNonBlocking('mcp_injection.apply', error, {
        model: String((normalized as any)?.model ?? '')
      });
    }
  }

  // 工具消息文本化 + 最后一轮 call 结果一致化 + 空 assistant 回合清理（native）
  try {
    const msgs: any[] = Array.isArray((normalized as any).messages) ? ((normalized as any).messages as any[]) : [];
    if (msgs.length) {
      (normalized as any).messages = normalizeOpenaiChatMessagesWithNative(msgs) as Array<Record<string, unknown>>;
      const syntheticViolation = inspectSyntheticRouteCodexAssistantMessages((normalized as any).messages);
      if (syntheticViolation) {
        const detailMessage = `Tool history contract violated: ${syntheticViolation.code} at index ${syntheticViolation.index}${
          syntheticViolation.callId ? ` (call_id=${syntheticViolation.callId})` : ''
        } — ${syntheticViolation.reason}`;
        throw new ProviderProtocolError(detailMessage, {
          code: 'MALFORMED_REQUEST',
          details: {
            context: 'openai-message-normalize.normalizeChatRequest',
            sourceShape: 'chat_messages',
            toolHistoryContractViolation: syntheticViolation
          }
        });
      }
    }
  } catch (error) {
    if (error instanceof ProviderProtocolError) {
      throw error;
    }
    logNormalizeNonBlocking('chat_messages.normalize_native', error, {
      model: String((normalized as any)?.model ?? '')
    });
  }

  // 注意：不合并/删除多条 system（与 统一标准，避免高风险修改）。

  // Do not invoke legacy tooling stage here; codecs perform canonicalization
  return normalized;
}

function normalizeChatResponse(res: any): any {
  // Deprecated: pass-through. Tool canonicalization and reasoning handling are done in codecs/compat layers.
  return res;
  if (false) {
    // legacy kept for reference
  }
}

function normalizeMessage(message: any): any {
  const disableShellCoerce = String(process?.env?.RCC_DISABLE_SHELL_COERCE ?? process?.env?.ROUTECODEX_DISABLE_SHELL_COERCE ?? '').toLowerCase();
  const isDisabled = disableShellCoerce === '1' || disableShellCoerce === 'true';
  return normalizeOpenaiMessageWithNative(message, isDisabled);
}

function normalizeTool(tool: any): any {
  return normalizeOpenaiToolWithNative(tool);
}

function normalizeToolCall(tc: any): any {
  const disableShellCoerce = String(process?.env?.RCC_DISABLE_SHELL_COERCE ?? process?.env?.ROUTECODEX_DISABLE_SHELL_COERCE ?? '').toLowerCase();
  const isDisabled = disableShellCoerce === '1' || disableShellCoerce === 'true';
  return normalizeOpenaiToolCallWithNative(tc, isDisabled);
}
