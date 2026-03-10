import type { JsonObject } from '../../../conversion/hub/types/json.js';
import { readRuntimeMetadata } from '../../../conversion/runtime-metadata.js';
import type { RoutingInstructionState } from '../../../router/virtual-router/routing-instructions.js';
import {
  saveRoutingInstructionStateSync
} from '../../../router/virtual-router/sticky-session-store.js';
import { isStopEligibleForServerTool } from '../../stop-gateway-context.js';
import { extractResponsesOutputText, hasToolLikeOutput } from './iflow-followup.js';
import { resolveStopMessageSnapshot } from './routing-state.js';

export function resolveStickyKey(
  record: {
    requestId?: unknown;
    providerProtocol?: unknown;
    responsesResume?: unknown;
    sessionId?: unknown;
    conversationId?: unknown;
    metadata?: unknown;
    [key: string]: unknown;
  },
  runtimeMetadata?: unknown
): string | undefined {
  const injectScope = resolveStopMessageInjectScope(record, runtimeMetadata);
  if (injectScope) {
    return injectScope;
  }
  return undefined;
}

export function persistStopMessageState(stickyKey: string | undefined, state: RoutingInstructionState): void {
  if (!stickyKey) {
    return;
  }
  const hasLifecycleStamp =
    (typeof state.stopMessageUpdatedAt === 'number' && Number.isFinite(state.stopMessageUpdatedAt)) ||
    (typeof state.stopMessageLastUsedAt === 'number' && Number.isFinite(state.stopMessageLastUsedAt));
  const empty =
    (!state.stopMessageText || !state.stopMessageText.trim()) &&
    (typeof state.stopMessageMaxRepeats !== 'number' || !Number.isFinite(state.stopMessageMaxRepeats)) &&
    (typeof state.stopMessageUsed !== 'number' || !Number.isFinite(state.stopMessageUsed)) &&
    (typeof state.stopMessageStageMode !== 'string' || !state.stopMessageStageMode.trim()) &&
    (typeof state.stopMessageAiMode !== 'string' || !state.stopMessageAiMode.trim()) &&
    !hasLifecycleStamp;
  if (empty) {
    saveRoutingInstructionStateSync(stickyKey, null);
    return;
  }
  saveRoutingInstructionStateSync(stickyKey, state);
}

export function resolveStopMessageSessionScope(
  record: {
    sessionId?: unknown;
    metadata?: unknown;
    [key: string]: unknown;
  },
  runtimeMetadata?: unknown
): string | undefined {
  return resolveStopMessageInjectScope(record, runtimeMetadata);
}

export function resolveRuntimeStopMessageState(runtimeMetadata: unknown): {
  text: string;
  maxRepeats: number;
  used: number;
  source?: string;
  updatedAt?: number;
  lastUsedAt?: number;
  stageMode?: 'on' | 'off' | 'auto';
  aiMode?: 'on' | 'off';
} | null {
  const runtime = asRecord(runtimeMetadata);
  const state = runtime ? asRecord(runtime.stopMessageState) : null;
  return resolveStopMessageSnapshot(state);
}

export function readRuntimeStopMessageStageMode(runtimeMetadata: unknown): 'on' | 'off' | 'auto' | undefined {
  const runtime = asRecord(runtimeMetadata);
  const state = runtime ? asRecord(runtime.stopMessageState) : null;
  const value = state?.stopMessageStageMode;
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'on' || normalized === 'off' || normalized === 'auto') {
    return normalized;
  }
  return undefined;
}

function resolveStopMessageInjectScope(
  record: {
    metadata?: unknown;
    [key: string]: unknown;
  },
  runtimeMetadata?: unknown
): string | undefined {
  const runtime = asRecord(runtimeMetadata);
  const runtimeInjectScope = toNonEmptyText(runtime?.stopMessageClientInjectSessionScope);
  if (runtimeInjectScope && runtimeInjectScope.startsWith('tmux:')) {
    return runtimeInjectScope;
  }

  const tmuxSessionId =
    readSessionScopeValue(record, runtimeMetadata, 'clientTmuxSessionId') ||
    readSessionScopeValue(record, runtimeMetadata, 'client_tmux_session_id') ||
    readSessionScopeValue(record, runtimeMetadata, 'tmuxSessionId') ||
    readSessionScopeValue(record, runtimeMetadata, 'tmux_session_id');
  if (tmuxSessionId) {
    return `tmux:${tmuxSessionId}`;
  }
  return undefined;
}

export function resolveBdWorkingDirectoryForRecord(
  record: {
    metadata?: unknown;
    [key: string]: unknown;
  },
  runtimeMetadata: unknown
): string | undefined {
  const fromWorkdir = readSessionScopeValue(record, runtimeMetadata, 'workdir');
  if (fromWorkdir) {
    return fromWorkdir;
  }
  const fromCwd = readSessionScopeValue(record, runtimeMetadata, 'cwd');
  if (fromCwd) {
    return fromCwd;
  }
  const fromWorkingDirectory = readSessionScopeValue(record, runtimeMetadata, 'workingDirectory');
  if (fromWorkingDirectory) {
    return fromWorkingDirectory;
  }
  return undefined;
}

export function readServerToolFollowupFlowId(runtimeMetadata: unknown): string {
  const runtime = asRecord(runtimeMetadata);
  const loopState = runtime ? asRecord(runtime.serverToolLoopState) : null;
  const flowId = loopState ? toNonEmptyText(loopState.flowId) : '';
  return flowId;
}

export function resolveStopMessageFollowupProviderKey(args: {
  record: {
    providerKey?: unknown;
    providerId?: unknown;
    metadata?: unknown;
  };
  runtimeMetadata?: unknown;
}): string {
  const direct =
    toNonEmptyText(args.record.providerKey) ||
    toNonEmptyText(args.record.providerId) ||
    readProviderKeyFromMetadata(args.record.metadata) ||
    readProviderKeyFromMetadata(args.runtimeMetadata);
  return direct;
}

export function resolveStopMessageFollowupToolContentMaxChars(params: {
  providerKey?: string;
  model?: string;
}): number | undefined {
  const raw = String(process.env.ROUTECODEX_STOPMESSAGE_FOLLOWUP_TOOL_CONTENT_MAX_CHARS || '').trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.max(64, Math.floor(parsed));
    }
    return undefined;
  }

  const providerKey = typeof params.providerKey === 'string' ? params.providerKey.trim().toLowerCase() : '';
  if (providerKey.startsWith('iflow.')) {
    return 1200;
  }

  const model = typeof params.model === 'string' ? params.model.trim().toLowerCase() : '';
  if (model === 'kimi-k2.5' || model.startsWith('kimi-k2.5-')) {
    return 1200;
  }

  return undefined;
}

export function getCapturedRequest(adapterContext: unknown): JsonObject | null {
  if (!adapterContext || typeof adapterContext !== 'object') {
    return null;
  }
  const contextRecord = adapterContext as Record<string, unknown>;

  const direct = contextRecord.capturedChatRequest;
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    return direct as JsonObject;
  }

  const originalRequest = contextRecord.originalRequest;
  if (originalRequest && typeof originalRequest === 'object' && !Array.isArray(originalRequest)) {
    return originalRequest as JsonObject;
  }

  return null;
}

export function resolveClientConnectionState(value: unknown): { disconnected?: boolean } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as { disconnected?: boolean } | null;
}

export function hasCompactionFlag(rt: unknown): boolean {
  const flag = rt && typeof rt === 'object' && !Array.isArray(rt) ? (rt as any).compactionRequest : undefined;
  if (flag === true) {
    return true;
  }
  if (typeof flag === 'string' && flag.trim().toLowerCase() === 'true') {
    return true;
  }
  return false;
}

export function resolveImplicitGeminiStopMessageSnapshot(
  ctx: {
    base: unknown;
    adapterContext: unknown;
    providerProtocol?: string;
  },
  record: {
    providerProtocol?: unknown;
    entryEndpoint?: unknown;
    metadata?: unknown;
  }
): {
  text: string;
  maxRepeats: number;
  used: number;
  source?: string;
  updatedAt?: number;
  lastUsedAt?: number;
} | null {
  try {
    const protoFromCtx = ctx.providerProtocol;
    const protoFromRecord =
      typeof record.providerProtocol === 'string' && record.providerProtocol.trim()
        ? String(record.providerProtocol).trim()
        : undefined;
    const providerProtocol = (protoFromCtx || protoFromRecord || '').toString().toLowerCase();
    if (providerProtocol !== 'gemini-chat') {
      return null;
    }

    const entryFromRecord =
      typeof record.entryEndpoint === 'string' && record.entryEndpoint.trim()
        ? String(record.entryEndpoint).trim()
        : undefined;
    const metaEntry =
      record.metadata &&
      typeof record.metadata === 'object' &&
      (record.metadata as Record<string, unknown>).entryEndpoint;
    const entryFromMeta =
      typeof metaEntry === 'string' && metaEntry.trim() ? metaEntry.trim() : undefined;
    const entryEndpoint = (entryFromRecord || entryFromMeta || '').toLowerCase();
    if (!entryEndpoint.includes('/v1/responses')) {
      return null;
    }

    if (!isStopEligibleForServerTool(ctx.base, ctx.adapterContext)) {
      return null;
    }

    if (!isEmptyAssistantReply(ctx.base)) {
      return null;
    }

    return {
      text: '继续执行',
      maxRepeats: 1,
      used: 0,
      source: 'auto'
    };
  } catch {
    return null;
  }
}

export function resolveDefaultStopMessageSnapshot(
  ctx: {
    base: unknown;
    adapterContext: unknown;
  },
  options?: {
    text?: string;
    maxRepeats?: number;
  }
): {
  text: string;
  maxRepeats: number;
  used: number;
  source?: string;
  updatedAt?: number;
  lastUsedAt?: number;
} | null {
  try {
    if (!isStopEligibleForServerTool(ctx.base, ctx.adapterContext)) {
      return null;
    }

    const text = typeof options?.text === 'string' && options.text.trim().length
      ? options.text.trim()
      : '继续执行';
    const maxRepeats =
      typeof options?.maxRepeats === 'number' && Number.isFinite(options.maxRepeats) && options.maxRepeats > 0
        ? Math.floor(options.maxRepeats)
        : 1;

    return {
      text,
      maxRepeats,
      used: 0,
      source: 'default'
    };
  } catch {
    return null;
  }
}

export function resolveEntryEndpoint(record: Record<string, unknown>): string {
  const raw = typeof record.entryEndpoint === 'string' && record.entryEndpoint.trim()
    ? record.entryEndpoint.trim()
    : undefined;
  if (raw) {
    return raw;
  }
  const metaEntry = record.metadata && typeof record.metadata === 'object' && (record.metadata as Record<string, unknown>).entryEndpoint;
  if (typeof metaEntry === 'string' && metaEntry.trim()) {
    return metaEntry.trim();
  }
  return '/v1/chat/completions';
}

function isEmptyAssistantReply(base: unknown): boolean {
  if (!base || typeof base !== 'object' || Array.isArray(base)) {
    return false;
  }
  const payload = base as { [key: string]: unknown };
  const choicesRaw = payload.choices;
  if (Array.isArray(choicesRaw) && choicesRaw.length) {
    const first = choicesRaw[0];
    if (!first || typeof first !== 'object' || Array.isArray(first)) {
      return false;
    }
    const finishReasonRaw = (first as { finish_reason?: unknown }).finish_reason;
    const finishReason =
      typeof finishReasonRaw === 'string' && finishReasonRaw.trim()
        ? finishReasonRaw.trim().toLowerCase()
        : '';
    if (finishReason !== 'stop') {
      return false;
    }
    const message =
      (first as { message?: unknown }).message &&
      typeof (first as { message?: unknown }).message === 'object' &&
      !Array.isArray((first as { message?: unknown }).message)
        ? ((first as { message: unknown }).message as { [key: string]: unknown })
        : null;
    if (!message) {
      return false;
    }
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (toolCalls.length > 0) {
      return false;
    }
    const contentRaw = message.content;
    const text = typeof contentRaw === 'string' ? contentRaw.trim() : '';
    return text.length === 0;
  }

  const statusRaw = typeof payload.status === 'string' ? payload.status.trim().toLowerCase() : '';
  if (statusRaw && statusRaw !== 'completed') {
    return false;
  }
  if (payload.required_action && typeof payload.required_action === 'object') {
    return false;
  }
  const outputText = extractResponsesOutputText(payload);
  if (outputText.length > 0) {
    return false;
  }
  const outputRaw = Array.isArray(payload.output) ? (payload.output as unknown[]) : [];
  if (outputRaw.some((item) => hasToolLikeOutput(item))) {
    return false;
  }
  return true;
}

function readSessionScopeValue(
  record: {
    sessionId?: unknown;
    conversationId?: unknown;
    metadata?: unknown;
    [key: string]: unknown;
  },
  runtimeMetadata: unknown,
  key: string
): string {
  const direct = toNonEmptyText(record[key]);
  if (direct) {
    return direct;
  }

  const metadata = asRecord(record.metadata);
  const fromMetadata = metadata ? toNonEmptyText(metadata[key]) : '';
  if (fromMetadata) {
    return fromMetadata;
  }

  const fromRecordCapture = readHubCaptureContextValue(record, key);
  if (fromRecordCapture) {
    return fromRecordCapture;
  }

  const fromMetadataContext = metadata ? toNonEmptyText(asRecord(metadata.context)?.[key]) : '';
  if (fromMetadataContext) {
    return fromMetadataContext;
  }

  const fromMetadataCapture = metadata ? readHubCaptureContextValue(metadata, key) : '';
  if (fromMetadataCapture) {
    return fromMetadataCapture;
  }

  const runtime = asRecord(runtimeMetadata);
  const fromRuntime = runtime ? toNonEmptyText(runtime[key]) : '';
  if (fromRuntime) {
    return fromRuntime;
  }

  const fromRuntimeCapture = runtime ? readHubCaptureContextValue(runtime, key) : '';
  if (fromRuntimeCapture) {
    return fromRuntimeCapture;
  }

  return '';
}

function readHubCaptureContextValue(
  source: Record<string, unknown> | null,
  key: string
): string {
  if (!source) {
    return '';
  }

  const hubCapture = asRecord(source.__hub_capture);
  const capturedContext = asRecord(source.capturedContext);
  const capturedHubCapture = asRecord(capturedContext?.__hub_capture);
  const candidateRecords: Array<Record<string, unknown> | null> = [
    source,
    asRecord(source.context),
    hubCapture,
    asRecord(hubCapture?.context),
    capturedContext,
    asRecord(capturedContext?.context),
    capturedHubCapture,
    asRecord(capturedHubCapture?.context)
  ];

  for (const candidate of candidateRecords) {
    if (!candidate) {
      continue;
    }
    const value = toNonEmptyText(candidate[key]);
    if (value) {
      return value;
    }
  }

  return '';
}

function readProviderKeyFromMetadata(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return '';
  }
  const metadata = value as Record<string, unknown>;
  const direct =
    toNonEmptyText(metadata.providerKey) ||
    toNonEmptyText(metadata.providerId) ||
    toNonEmptyText(metadata.targetProviderKey);
  if (direct) {
    return direct;
  }
  const target = metadata.target;
  if (target && typeof target === 'object' && !Array.isArray(target)) {
    const targetRecord = target as Record<string, unknown>;
    return toNonEmptyText(targetRecord.providerKey) || toNonEmptyText(targetRecord.providerId);
  }
  return '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function toNonEmptyText(value: unknown): string {
  return typeof value === 'string' && value.trim().length ? value.trim() : '';
}
