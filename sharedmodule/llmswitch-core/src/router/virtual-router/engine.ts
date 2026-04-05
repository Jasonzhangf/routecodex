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
import { ProviderRegistry } from './provider-registry.js';
import { loadRoutingInstructionStateSync } from './sticky-session-store.js';
import { mergeStopMessageFromPersisted } from './stop-message-state-sync.js';
import { resolveStopMessageScope } from './engine/routing-state/store.js';
import type { RoutingInstructionState } from './routing-instructions.js';
import { resolveRouteColor, resolveSessionColor } from './engine-logging.js';
import { resolveRccUserDir } from '../../runtime/user-data-paths.js';
import {
  buildStopMessageMarkerParseLog,
  cleanStopMessageMarkersInPlace,
  emitStopMessageMarkerParseLog,
  formatStopMessageStatusLabel
} from './stop-message-markers.js';

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
    const parseLog = buildStopMessageMarkerParseLog(request, metadata);
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
    emitStopMessageMarkerParseLog(parseLog);
    cleanStopMessageMarkersInPlace(request as unknown as Record<string, unknown>);
    const stopScope = parseLog?.stopScope || resolveStopMessageScope(metadata);
    const stopState = stopScope ? this.getStopMessageState(metadata) : null;
    const forceStopStatusLabel = Boolean(
      parseLog?.stopMessageTypes.length ||
      parseLog?.scopedTypes.some((type) => type === 'stopMessageSet' || type === 'stopMessageMode' || type === 'stopMessageClear')
    );
    if ((metadata as { __rt?: Record<string, unknown> }).__rt?.disableVirtualRouterHitLog !== true) {
      emitVirtualRouterHitLog(parsed, {
        requestId: metadata.requestId,
        sessionId: resolveVirtualRouterLogSessionId(metadata),
        stopScope,
        stopState,
        forceStopStatusLabel
      });
    }
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
  const sessionDir = String(process.env.ROUTECODEX_SESSION_DIR || '').trim();
  const runtimeOverrides: Record<string, unknown> = { nowMs };
  if (sessionDir) {
    runtimeOverrides.sessionDir = sessionDir;
  }
  const rccUserDir = resolveRccUserDir();
  if (rccUserDir) {
    runtimeOverrides.rccUserDir = rccUserDir;
  }
  if (rt && typeof rt === 'object' && !Array.isArray(rt)) {
    return {
      ...metadata,
      __rt: { ...(rt as Record<string, unknown>), ...runtimeOverrides }
    } as RouterMetadataInput;
  }
  return { ...metadata, __rt: runtimeOverrides } as RouterMetadataInput;
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
