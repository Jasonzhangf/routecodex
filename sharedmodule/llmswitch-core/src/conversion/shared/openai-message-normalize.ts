import {
  normalizeOpenaiChatMessagesWithNative,
  normalizeOpenaiMessageWithNative,
  normalizeOpenaiToolWithNative
} from '../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';
export type {
  ToolHistoryContractViolation,
  ToolHistoryContractViolationCode
} from './openai-message-normalize-contract.js';
export { isSyntheticRouteCodexToolCallId } from './openai-message-normalize-contract.js';
export {
  inspectSyntheticRouteCodexAssistantMessages,
  inspectSyntheticRouteCodexBridgeInput,
  isSyntheticRouteCodexControlText
} from './openai-message-normalize-control-text.js';
export {
  inspectBridgeInputToolHistory,
  inspectOpenAiChatToolHistory
} from './openai-message-normalize-tool-history.js';

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

  // 工具消息文本化 + 最后一轮 call 结果一致化 + 空 assistant 回合清理（native）
  const msgs: any[] = Array.isArray((normalized as any).messages) ? ((normalized as any).messages as any[]) : [];
  if (msgs.length) {
    (normalized as any).messages = normalizeOpenaiChatMessagesWithNative(msgs) as Array<Record<string, unknown>>;
  }

  // 注意：不合并/删除多条 system（与 统一标准，避免高风险修改）。

  // Do not invoke legacy tooling stage here; codecs perform canonicalization
  return normalized;
}

function normalizeMessage(message: any): any {
  const disableShellCoerce = String(process?.env?.RCC_DISABLE_SHELL_COERCE ?? process?.env?.ROUTECODEX_DISABLE_SHELL_COERCE ?? '').toLowerCase();
  const isDisabled = disableShellCoerce === '1' || disableShellCoerce === 'true';
  return normalizeOpenaiMessageWithNative(message, isDisabled);
}

function normalizeTool(tool: any): any {
  return normalizeOpenaiToolWithNative(tool);
}
