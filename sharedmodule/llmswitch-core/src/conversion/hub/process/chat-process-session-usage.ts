import type { AdapterContext } from '../types/chat-envelope.js';
import type { RoutingInstructionState } from '../../../native/router-hotpath/native-virtual-router-routing-state.js';
import {
  loadRoutingInstructionStateSync,
  saveRoutingInstructionStateSync
} from '../../../native/router-hotpath/native-virtual-router-routing-state.js';

type UsageLike = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

function createEmptyRoutingInstructionState(): RoutingInstructionState {
  return {
    allowedProviders: new Set(),
    disabledProviders: new Set(),
    disabledKeys: new Map(),
    disabledModels: new Map()
  };
}

function resolveSessionUsageScope(record: Record<string, unknown> | undefined): string | undefined {
  const explicitScope =
    typeof record?.stopMessageClientInjectSessionScope === 'string'
      ? record.stopMessageClientInjectSessionScope.trim()
      : '';
  if (explicitScope.startsWith('tmux:')) {
    return explicitScope;
  }
  const tmuxSessionId =
    typeof record?.clientTmuxSessionId === 'string'
      ? record.clientTmuxSessionId.trim()
      : (typeof record?.tmuxSessionId === 'string' ? record.tmuxSessionId.trim() : '');
  if (tmuxSessionId) {
    return `tmux:${tmuxSessionId}`;
  }
  const sessionId = typeof record?.sessionId === 'string' ? record.sessionId.trim() : '';
  if (sessionId) {
    return undefined;
  }
  const conversationId =
    typeof record?.conversationId === 'string' ? record.conversationId.trim() : '';
  if (conversationId) {
    return undefined;
  }
  return undefined;
}

function loadState(scope: string): RoutingInstructionState | null {
  return loadRoutingInstructionStateSync(scope);
}

function readRoundedToken(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const rounded = Math.round(value);
  return rounded > 0 ? rounded : undefined;
}

function normalizeUsage(usage: Record<string, unknown> | undefined): UsageLike | null {
  if (!usage || typeof usage !== 'object') {
    return null;
  }
  const inputTokens = readRoundedToken(
    usage.input_tokens ??
      usage.prompt_tokens ??
      usage.inputTokens ??
      usage.promptTokens ??
      usage.request_tokens ??
      usage.requestTokens
  );
  const outputTokens = readRoundedToken(
    usage.output_tokens ??
      usage.completion_tokens ??
      usage.outputTokens ??
      usage.completionTokens ??
      usage.response_tokens ??
      usage.responseTokens
  );
  const totalTokens = readRoundedToken(
    usage.total_tokens ??
      usage.totalTokens ??
      ((inputTokens ?? 0) + (outputTokens ?? 0) > 0
        ? (inputTokens ?? 0) + (outputTokens ?? 0)
        : undefined)
  );
  if (totalTokens === undefined && inputTokens === undefined) {
    return null;
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {})
  };
}

export function saveChatProcessSessionActualUsage(options: {
  context: AdapterContext;
  usage: Record<string, unknown> | undefined;
}): void {
  const scope = resolveSessionUsageScope(options.context as unknown as Record<string, unknown>);
  if (!scope) {
    return;
  }
  const normalizedUsage = normalizeUsage(options.usage);
  if (!normalizedUsage) {
    return;
  }
  const capturedChatRequest = (options.context as { capturedChatRequest?: unknown }).capturedChatRequest;
  const messageCount = Array.isArray((capturedChatRequest as { messages?: unknown[] } | undefined)?.messages)
    ? ((capturedChatRequest as { messages?: unknown[] }).messages ?? []).length
    : undefined;
  const state = loadState(scope) ?? createEmptyRoutingInstructionState();
  if (normalizedUsage.totalTokens !== undefined) {
    state.chatProcessLastTotalTokens = normalizedUsage.totalTokens;
  }
  if (normalizedUsage.inputTokens !== undefined) {
    state.chatProcessLastInputTokens = normalizedUsage.inputTokens;
  }
  if (typeof messageCount === 'number' && Number.isFinite(messageCount)) {
    state.chatProcessLastMessageCount = Math.max(0, Math.round(messageCount));
  }
  state.chatProcessLastUpdatedAt = Date.now();
  saveRoutingInstructionStateSync(scope, state);
}
