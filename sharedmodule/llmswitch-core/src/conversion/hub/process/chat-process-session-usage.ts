import type { AdapterContext } from '../types/chat-envelope.js';
import type { ProcessedRequest, StandardizedRequest, StandardizedMessage } from '../types/standardized.js';
import type { RoutingInstructionState } from '../../../router/virtual-router/routing-instructions/types.js';
import {
  loadRoutingInstructionStateSync,
  saveRoutingInstructionStateSync
} from '../../../router/virtual-router/sticky-session-store.js';
import { countRequestTokens } from '../../../router/virtual-router/token-counter.js';

type UsageLike = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

type SessionUsageSnapshot = UsageLike & {
  scope: string;
  messageCount?: number;
  updatedAtMs?: number;
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
  try {
    return loadRoutingInstructionStateSync(scope);
  } catch {
    return null;
  }
}

function readRoundedToken(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const rounded = Math.round(value);
  return rounded > 0 ? rounded : undefined;
}

function buildSnapshot(scope: string, state: RoutingInstructionState | null): SessionUsageSnapshot | null {
  if (!state) {
    return null;
  }
  const totalTokens = readRoundedToken(state.chatProcessLastTotalTokens);
  const inputTokens = readRoundedToken(state.chatProcessLastInputTokens);
  const messageCount = readRoundedToken(state.chatProcessLastMessageCount);
  const updatedAtMs = readRoundedToken(state.chatProcessLastUpdatedAt);
  if (totalTokens === undefined && inputTokens === undefined) {
    return null;
  }
  return {
    scope,
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(messageCount !== undefined ? { messageCount } : {}),
    ...(updatedAtMs !== undefined ? { updatedAtMs } : {})
  };
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

function estimateDeltaTokens(
  request: StandardizedRequest | ProcessedRequest,
  previousMessageCount: number
): number | undefined {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  if (previousMessageCount < 0 || previousMessageCount > messages.length) {
    return undefined;
  }
  const appendedMessages = messages.slice(previousMessageCount);
  if (appendedMessages.length === 0) {
    return 0;
  }
  return countRequestTokens({
    model: request.model,
    messages: appendedMessages as StandardizedMessage[],
    parameters: {},
    metadata: { originalEndpoint: request.metadata?.originalEndpoint ?? '/v1/chat/completions' }
  } as StandardizedRequest);
}

export function estimateSessionBoundTokens(
  request: StandardizedRequest | ProcessedRequest,
  metadata: Record<string, unknown> | undefined
): number | undefined {
  const scope = resolveSessionUsageScope(metadata);
  if (!scope) {
    return undefined;
  }
  const snapshot = buildSnapshot(scope, loadState(scope));
  if (!snapshot) {
    return undefined;
  }
  const previousTotal = snapshot.totalTokens ?? snapshot.inputTokens;
  const previousMessageCount = snapshot.messageCount;
  if (previousTotal === undefined || previousMessageCount === undefined) {
    return undefined;
  }
  const deltaTokens = estimateDeltaTokens(request, previousMessageCount);
  if (deltaTokens === undefined) {
    return undefined;
  }
  return Math.max(1, Math.round(previousTotal + deltaTokens));
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
