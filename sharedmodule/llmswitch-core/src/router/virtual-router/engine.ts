import type { ProcessedRequest, StandardizedMessage, StandardizedRequest } from '../../conversion/hub/types/standardized.js';
import type {
  ProviderErrorEvent,
  ProviderFailureEvent,
  ProviderQuotaView,
  ProviderSuccessEvent,
  RouterMetadataInput,
  RoutingDecision,
  RoutingDiagnostics,
  RoutingStatusSnapshot,
  StopMessageStateSnapshot,
  PreCommandStateSnapshot,
  TargetMetadata,
  VirtualRouterConfig,
  VirtualRouterHealthStore
} from './types.js';
import { VirtualRouterError, VirtualRouterErrorCode } from './types.js';
import { createVirtualRouterEngineProxy, type NativeVirtualRouterEngineProxy } from './engine-selection/native-virtual-router-engine-proxy.js';
import {
  cleanRoutingInstructionMarkersWithNative,
  parseRoutingInstructionKindsWithNative
} from './engine-selection/native-virtual-router-routing-instructions-semantics.js';
import { extractMessageText, getLatestUserMessage } from './message-utils.js';
import { ProviderRegistry } from './provider-registry.js';
import { resolveStopMessageScope } from './engine/routing-state/store.js';
import { loadRoutingInstructionStateSync } from './sticky-session-store.js';
import { mergeStopMessageFromPersisted } from './stop-message-state-sync.js';
import type { RoutingInstructionState } from './routing-instructions.js';
import { resolveRouteColor, resolveSessionColor } from './engine-logging.js';

export class VirtualRouterEngine {
  private readonly nativeProxy: NativeVirtualRouterEngineProxy;
  private readonly registry: ProviderRegistry;
  private readonly routingInstructionStateStore: Map<string, unknown>;

  constructor(deps?: {
    healthStore?: VirtualRouterHealthStore;
    routingStateStore?: {
      loadSync: (key: string) => unknown;
      saveAsync: (key: string, state: unknown) => void;
      saveSync?: (key: string, state: unknown) => void;
    };
    quotaView?: ProviderQuotaView;
  }) {
    this.nativeProxy = createVirtualRouterEngineProxy();
    this.registry = new ProviderRegistry();
    this.routingInstructionStateStore = new Map();
    if (deps) {
      this.nativeProxy.updateDeps(deps as unknown as object);
    }
  }

  get antigravitySessionAliasStore(): Map<string, string> {
    return this.nativeProxy.antigravitySessionAliasStore as unknown as Map<string, string>;
  }

  get routingInstructionState(): Map<string, unknown> {
    return this.routingInstructionStateStore;
  }

  get providerRegistry(): unknown {
    return this.registry;
  }

  initialize(config: VirtualRouterConfig): void {
    this.nativeProxy.initialize(JSON.stringify(config));
    this.registry.load(config.providers ?? {});
    this.routingInstructionStateStore.clear();
  }

  updateDeps(deps: {
    healthStore?: VirtualRouterHealthStore | null;
    routingStateStore?: {
      loadSync: (key: string) => unknown;
      saveAsync: (key: string, state: unknown) => void;
      saveSync?: (key: string, state: unknown) => void;
    } | null;
    quotaView?: ProviderQuotaView | null;
  }): void {
    this.nativeProxy.updateDeps(deps as unknown as object);
  }

  updateVirtualRouterConfig(config: VirtualRouterConfig): void {
    this.nativeProxy.updateVirtualRouterConfig(JSON.stringify(config));
    this.registry.load(config.providers ?? {});
  }

  markProviderCooldown(providerKey: string, cooldownMs: number | undefined): void {
    this.nativeProxy.markProviderCooldown(providerKey, cooldownMs);
  }

  clearProviderCooldown(providerKey: string): void {
    this.nativeProxy.clearProviderCooldown(providerKey);
  }

  route(
    request: StandardizedRequest | ProcessedRequest,
    metadata: RouterMetadataInput
  ): { target: TargetMetadata; decision: RoutingDecision; diagnostics: RoutingDiagnostics } {
    const parseLog = buildRoutingInstructionParseLog(request, metadata);
    const nativeMetadata = injectRuntimeNowMs(metadata);
    let raw: unknown;
    try {
      raw = this.nativeProxy.route(JSON.stringify(request), JSON.stringify(nativeMetadata));
    } catch (error) {
      throw normalizeNativeVirtualRouterError(error);
    }
    if (typeof raw !== 'string') {
      throw normalizeNativeVirtualRouterError(raw);
    }
    if (raw.startsWith('Error:') || raw.startsWith(VIRTUAL_ROUTER_ERROR_PREFIX)) {
      throw normalizeNativeVirtualRouterError(raw);
    }
    const parsed = JSON.parse(raw) as {
      target: TargetMetadata;
      decision: RoutingDecision;
      diagnostics: RoutingDiagnostics;
    };
    emitRoutingInstructionParseLog(parseLog);
    // Keep legacy observable behavior for callers/tests that inspect the request object
    // after route(): instruction markers are stripped from forwarded payload structures.
    cleanRoutingInstructionMarkersInPlace(request as unknown as Record<string, unknown>);
    const stopScope = parseLog?.stopScope || resolveStopMessageScope(metadata);
    const stopState = stopScope ? this.getStopMessageState(metadata) : null;
    const forceStopStatusLabel = Boolean(
      parseLog?.stopMessageTypes.length ||
      parseLog?.scopedTypes.some((type) => type === 'stopMessageSet' || type === 'stopMessageMode' || type === 'stopMessageClear')
    );
    emitVirtualRouterHitLog(parsed, {
      requestId: metadata.requestId,
      sessionId: resolveVirtualRouterLogSessionId(metadata),
      stopScope,
      stopState,
      forceStopStatusLabel
    });
    return parsed;
  }

  getStopMessageState(metadata: RouterMetadataInput): StopMessageStateSnapshot | null {
    const raw = this.nativeProxy.getStopMessageState(JSON.stringify(metadata));
    const snapshot = JSON.parse(raw) as StopMessageStateSnapshot | null;
    const scope = resolveStopMessageScope(metadata);
    return mergeStopMessageSnapshotWithPersisted(snapshot, scope);
  }

  getPreCommandState(metadata: RouterMetadataInput): PreCommandStateSnapshot | null {
    const raw = this.nativeProxy.getPreCommandState(JSON.stringify(metadata));
    return JSON.parse(raw) as PreCommandStateSnapshot | null;
  }

  handleProviderFailure(event: ProviderFailureEvent): void {
    this.nativeProxy.handleProviderFailure(JSON.stringify(event));
  }

  handleProviderError(event: ProviderErrorEvent): void {
    this.nativeProxy.handleProviderError(JSON.stringify(event));
  }

  handleProviderSuccess(event: ProviderSuccessEvent): void {
    this.nativeProxy.handleProviderSuccess(JSON.stringify(event));
  }

  getStatus(): RoutingStatusSnapshot {
    return JSON.parse(this.nativeProxy.getStatus()) as RoutingStatusSnapshot;
  }
}

const VIRTUAL_ROUTER_ERROR_PREFIX = 'VIRTUAL_ROUTER_ERROR:';

function normalizeNativeVirtualRouterError(error: unknown): Error {
  if (error instanceof VirtualRouterError) {
    return error;
  }
  const message = extractNativeErrorMessage(error);
  const parsed = parseVirtualRouterErrorMessage(message);
  if (parsed) {
    return new VirtualRouterError(parsed.message, parsed.code);
  }
  if (isVirtualRouterErrorLike(error)) {
    return new VirtualRouterError(
      typeof error.message === 'string' && error.message.trim() ? error.message : 'Virtual router error',
      error.code
    );
  }
  return error instanceof Error ? error : new Error(message || 'Virtual router error');
}

function mergeStopMessageSnapshotWithPersisted(
  snapshot: StopMessageStateSnapshot | null,
  scope?: string
): StopMessageStateSnapshot | null {
  if (!scope) {
    return snapshot;
  }
  let persisted: RoutingInstructionState | null = null;
  try {
    persisted = loadRoutingInstructionStateSync(scope) as RoutingInstructionState | null;
  } catch {
    return snapshot;
  }
  if (!persisted) {
    return snapshot;
  }
  const persistedText =
    typeof persisted.stopMessageText === 'string' ? persisted.stopMessageText.trim() : '';
  if (!snapshot && !persistedText) {
    return snapshot;
  }

  const existing = {
    stopMessageSource: snapshot?.stopMessageSource,
    stopMessageText: snapshot?.stopMessageText,
    stopMessageMaxRepeats: snapshot?.stopMessageMaxRepeats,
    stopMessageUsed: snapshot?.stopMessageUsed,
    stopMessageUpdatedAt: snapshot?.stopMessageUpdatedAt,
    stopMessageLastUsedAt: snapshot?.stopMessageLastUsedAt,
    stopMessageStageMode: snapshot?.stopMessageStageMode,
    stopMessageAiMode: snapshot?.stopMessageAiMode,
    stopMessageAiSeedPrompt: snapshot?.stopMessageAiSeedPrompt,
    stopMessageAiHistory: snapshot?.stopMessageAiHistory
  };
  const merged = mergeStopMessageFromPersisted(existing, persisted);
  const base: StopMessageStateSnapshot = snapshot ?? {
    stopMessageMaxRepeats:
      typeof merged.stopMessageMaxRepeats === 'number' && Number.isFinite(merged.stopMessageMaxRepeats)
        ? merged.stopMessageMaxRepeats
        : 0
  };
  const mergedMaxRepeats =
    typeof merged.stopMessageMaxRepeats === 'number' && Number.isFinite(merged.stopMessageMaxRepeats)
      ? merged.stopMessageMaxRepeats
      : base.stopMessageMaxRepeats;

  return {
    ...base,
    stopMessageSource: merged.stopMessageSource,
    stopMessageText: merged.stopMessageText,
    stopMessageMaxRepeats: mergedMaxRepeats,
    stopMessageUsed: merged.stopMessageUsed,
    stopMessageUpdatedAt: merged.stopMessageUpdatedAt,
    stopMessageLastUsedAt: merged.stopMessageLastUsedAt,
    stopMessageStageMode: merged.stopMessageStageMode,
    stopMessageAiMode: merged.stopMessageAiMode,
    stopMessageAiSeedPrompt: merged.stopMessageAiSeedPrompt,
    stopMessageAiHistory: merged.stopMessageAiHistory
  };
}

function extractNativeErrorMessage(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') {
      return message;
    }
  }
  return '';
}

function parseVirtualRouterErrorMessage(message: string): { code: VirtualRouterErrorCode; message: string } | null {
  if (!message) {
    return null;
  }
  const normalized = message.startsWith('Error:') ? message.replace(/^Error:\s*/, '') : message;
  if (!normalized.startsWith(VIRTUAL_ROUTER_ERROR_PREFIX)) {
    return null;
  }
  const remainder = normalized.slice(VIRTUAL_ROUTER_ERROR_PREFIX.length);
  const idx = remainder.indexOf(':');
  if (idx <= 0) {
    return null;
  }
  const code = remainder.slice(0, idx);
  const detail = remainder.slice(idx + 1).trim();
  if (!isVirtualRouterErrorCode(code)) {
    return null;
  }
  return { code, message: detail || 'Virtual router error' };
}

function isVirtualRouterErrorCode(value: string): value is VirtualRouterErrorCode {
  return Object.values(VirtualRouterErrorCode).includes(value as VirtualRouterErrorCode);
}

function isVirtualRouterErrorLike(
  error: unknown
): error is { code: VirtualRouterErrorCode; message?: string } {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const record = error as { code?: unknown };
  return typeof record.code === 'string' && isVirtualRouterErrorCode(record.code);
}

function injectRuntimeNowMs(metadata: RouterMetadataInput): RouterMetadataInput {
  const nowMs = Date.now();
  const rt = (metadata as { __rt?: unknown }).__rt;
  if (rt && typeof rt === 'object' && !Array.isArray(rt)) {
    return { ...metadata, __rt: { ...(rt as Record<string, unknown>), nowMs } } as RouterMetadataInput;
  }
  return { ...metadata, __rt: { nowMs } } as RouterMetadataInput;
}

type RoutingInstructionParseLog = {
  requestId: string;
  markerDetected: boolean;
  preview: string;
  stopMessageTypes: string[];
  scopedTypes: string[];
  stopScope?: string;
};

function buildRoutingInstructionParseLog(
  request: StandardizedRequest | ProcessedRequest,
  metadata: RouterMetadataInput
): RoutingInstructionParseLog | null {
  const messages = Array.isArray((request as { messages?: unknown }).messages)
    ? (((request as { messages?: unknown[] }).messages ?? []) as StandardizedMessage[])
    : [];
  if (!messages.length) {
    return null;
  }
  const latest = getLatestUserMessage(messages);
  const latestText = latest ? extractMessageText(latest).trim() : '';
  const latestHasMarker = /<\*\*[\s\S]*?\*\*>/.test(latestText);
  const hasStopKeyword = /stopmessage/i.test(latestText);
  if (!hasStopKeyword && !latestHasMarker) {
    return null;
  }
  const parsedKinds = parseRoutingInstructionKindsWithNative(request as unknown as Record<string, unknown>);
  const stopMessageTypes = parsedKinds.filter(
    (type) => type === 'stopMessageSet' || type === 'stopMessageMode' || type === 'stopMessageClear'
  );
  const scopedTypes = parsedKinds.filter(
    (type) =>
      type === 'stopMessageSet' ||
      type === 'stopMessageMode' ||
      type === 'stopMessageClear' ||
      type === 'preCommandSet' ||
      type === 'preCommandClear'
  );
  if (!hasStopKeyword && stopMessageTypes.length === 0 && scopedTypes.length === 0) {
    return null;
  }
  return {
    requestId: metadata.requestId || 'n/a',
    markerDetected: latestHasMarker,
    preview: latestText.replace(/\s+/g, ' ').slice(0, 120),
    stopMessageTypes,
    scopedTypes,
    stopScope: resolveStopMessageScope(metadata)
  };
}

function emitRoutingInstructionParseLog(log: RoutingInstructionParseLog | null): void {
  if (!log) {
    return;
  }
  const reset = '\x1b[0m';
  const tagColor = '\x1b[38;5;39m';
  const scopeColor = '\x1b[38;5;220m';
  console.log(
    `${tagColor}[virtual-router][stop_message_parse]${reset} requestId=${log.requestId} marker=${log.markerDetected ? 'detected' : 'missing'} parsed=${log.stopMessageTypes.join(',') || 'none'} preview=${log.preview}`
  );
  if (log.scopedTypes.length > 0) {
    if (log.stopScope) {
      console.log(
        `${scopeColor}[virtual-router][stop_scope]${reset} requestId=${log.requestId} stage=apply scope=${log.stopScope} instructions=${log.scopedTypes.join(',')}`
      );
    } else {
      console.log(
        `${scopeColor}[virtual-router][stop_scope]${reset} requestId=${log.requestId} stage=drop reason=missing_tmux_scope instructions=${log.scopedTypes.join(',')}`
      );
    }
  }
}

function emitVirtualRouterHitLog(result: {
  target: TargetMetadata;
  decision: RoutingDecision;
}, options?: {
  requestId?: string;
  sessionId?: string;
  stopScope?: string;
  stopState?: StopMessageStateSnapshot | null;
  forceStopStatusLabel?: boolean;
}): void {
  const reset = '\x1b[0m';
  const prefixColor = '\x1b[38;5;208m';
  const timeColor = '\x1b[90m';
  const stopColor = '\x1b[38;5;214m';
  const now = new Date();
  const timestamp = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  const routeLabel = result.decision.poolId
    ? `${result.decision.routeName}/${result.decision.poolId}`
    : result.decision.routeName;
  const routeColor = resolveSessionColor(options?.sessionId) || resolveRouteColor(result.decision.routeName);
  const providerKey = result.decision.providerKey || result.target.providerKey;
  const modelSuffix = result.target.modelId ? `.${result.target.modelId}` : '';
  const reason = result.decision.reasoning ? ` reason=${result.decision.reasoning}` : '';
  const stopStatusLabel = formatStopMessageStatusLabel(
    options?.stopState ?? null,
    options?.stopScope,
    Boolean(options?.forceStopStatusLabel)
  );
  const requestId = typeof options?.requestId === 'string' ? options.requestId : '';
  const requestLabel = requestId && !requestId.includes('unknown') ? ` req=${requestId}` : '';
  const sessionId = typeof options?.sessionId === 'string' ? options.sessionId.trim() : '';
  const sessionLabel = sessionId ? ` sid=${sessionId}` : '';
  console.log(
    `${prefixColor}[virtual-router-hit]${reset} ${timeColor}${timestamp}${reset}${requestLabel}${sessionLabel} ${routeColor}${routeLabel} -> ${providerKey}${modelSuffix}${reason}${reset}${stopStatusLabel ? ` ${stopColor}${stopStatusLabel}${reset}` : ''}`
  );
}

function resolveVirtualRouterLogSessionId(metadata: RouterMetadataInput): string | undefined {
  const candidates = [
    metadata.sessionId,
    metadata.clientTmuxSessionId,
    metadata.client_tmux_session_id,
    metadata.tmuxSessionId,
    metadata.tmux_session_id,
    metadata.conversationId
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function formatStopMessageStatusLabel(
  snapshot: StopMessageStateSnapshot | null,
  scope: string | undefined,
  forceShow: boolean
): string {
  const scopeLabel = scope && scope.trim() ? scope.trim() : 'none';

  if (!snapshot) {
    if (!forceShow) {
      return '';
    }
    return `[stopMessage:scope=${scopeLabel} active=no state=cleared]`;
  }

  const text = typeof snapshot.stopMessageText === 'string' ? snapshot.stopMessageText.trim() : '';
  const safeText = text ? (text.length > 24 ? `${text.slice(0, 21)}...` : text) : '(mode-only)';
  const mode = (snapshot.stopMessageStageMode || 'unset').toString().toLowerCase();
  const maxRepeats =
    typeof snapshot.stopMessageMaxRepeats === 'number' && Number.isFinite(snapshot.stopMessageMaxRepeats)
      ? Math.max(0, Math.floor(snapshot.stopMessageMaxRepeats))
      : 0;
  const used =
    typeof snapshot.stopMessageUsed === 'number' && Number.isFinite(snapshot.stopMessageUsed)
      ? Math.max(0, Math.floor(snapshot.stopMessageUsed))
      : 0;
  const remaining = maxRepeats > 0 ? Math.max(0, maxRepeats - used) : -1;
  const active = mode !== 'off' && Boolean(text) && maxRepeats > 0;
  const rounds = maxRepeats > 0 ? `${used}/${maxRepeats}` : `${used}/-`;
  const left = remaining >= 0 ? String(remaining) : 'n/a';

  return `[stopMessage:scope=${scopeLabel} text="${safeText}" mode=${mode} round=${rounds} left=${left} active=${active ? 'yes' : 'no'}]`;
}

function cleanRoutingInstructionMarkersInPlace(request: Record<string, unknown>): void {
  const cleaned = cleanRoutingInstructionMarkersWithNative(request);
  if (Array.isArray((cleaned as { messages?: unknown }).messages)) {
    request.messages = (cleaned as { messages: unknown }).messages as unknown;
  }
  const cleanedSemantics = (cleaned as { semantics?: unknown }).semantics;
  if (cleanedSemantics && typeof cleanedSemantics === 'object' && !Array.isArray(cleanedSemantics)) {
    const cleanedResponses = (cleanedSemantics as { responses?: unknown }).responses;
    if (cleanedResponses && typeof cleanedResponses === 'object' && !Array.isArray(cleanedResponses)) {
      const cleanedContext = (cleanedResponses as { context?: unknown }).context;
      if (cleanedContext !== undefined) {
        const semantics =
          request.semantics && typeof request.semantics === 'object' && !Array.isArray(request.semantics)
            ? (request.semantics as Record<string, unknown>)
            : {};
        const responses =
          semantics.responses && typeof semantics.responses === 'object' && !Array.isArray(semantics.responses)
            ? (semantics.responses as Record<string, unknown>)
            : {};
        responses.context = cleanedContext;
        semantics.responses = responses;
        request.semantics = semantics;
      }
    }
  }
}
