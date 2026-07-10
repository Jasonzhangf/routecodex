import type {
  ProviderErrorEvent,
  ProviderFailureEvent,
  ProviderSuccessEvent,
  RouterMetadataInput,
  RoutingDecision,
  RoutingDiagnostics,
  RoutingStatusSnapshot,
  VirtualRouterDryRunDiagnostics,
  StopMessageStateSnapshot,
  PreCommandStateSnapshot,
  TargetMetadata,
  VirtualRouterConfig,
  VirtualRouterHealthStore
} from './virtual-router-contracts.js';
import {
  failNativeRequired,
  parseJson,
  parseRecord,
  readNativeFunction,
  resolveRccUserDirWithNative as resolveRccUserDir,
  safeStringify,
  VirtualRouterError,
  VirtualRouterErrorCode
} from './native-router-hotpath-loader.js';
import {
  extractVirtualRouterNativeErrorMessage,
  parseVirtualRouterNativeError,
  VIRTUAL_ROUTER_ERROR_PREFIX
} from './native-router-hotpath-loader.js';
import { callNativeJson } from './native-router-hotpath-loader.js';

export type {
  ClassificationResult,
  ProviderProfile,
  RouterMetadataInput,
  RoutingDecision,
  RoutingDiagnostics,
  RoutingFeatures,
  RoutingInstructionMode,
  RoutingStatusSnapshot,
  StopMessageStateSnapshot,
  TargetMetadata,
  VirtualRouterConfig,
  VirtualRouterContextRoutingConfig,
  VirtualRouterDryRunDiagnostics,
  VirtualRouterHealthStore
} from './virtual-router-contracts.js';

type TokenEstimateOutput = {
  tokens?: unknown;
};

type NativeRouterRequest = Record<string, unknown>;

type RoutingInstruction =
  | { type: 'stopMessageClear' }
  | {
      type: 'stopMessageMode';
      stopMessageStageMode: 'on' | 'off' | 'auto';
      stopMessageMaxRepeats?: number;
    }
  | {
      type: 'stopMessageSet';
      stopMessageText: string;
      stopMessageMaxRepeats?: number;
      stopMessageSource?: 'explicit_file' | 'explicit_text';
    };

type StopMessageResolvedNativeParseOutput = RoutingInstruction;

export type VirtualRouterHitLogOmitField =
  | 'requestId'
  | 'sessionId'
  | 'model'
  | 'reason'
  | 'continuation'
  | 'requestTokens'
  | 'selectionPenalty'
  | 'stopMessage';

export type VirtualRouterHitLogConfig = {
  omit?: VirtualRouterHitLogOmitField[];
};

export type VirtualRouterRouteHostEffects = {
  finalize: (
    result: { target: TargetMetadata; decision: RoutingDecision },
    getStopMessageState: (metadata: RouterMetadataInput) => StopMessageStateSnapshot | null
  ) => void;
};

export type StopMessageMarkerParseLog = {
  requestId: string;
  markerDetected: boolean;
  preview: string;
  stopMessageTypes: string[];
  scopedTypes: string[];
  stopScope?: string;
};

// Inlined from retired native-virtual-router-engine-proxy.ts
export interface NativeVirtualRouterEngineProxy {
  initialize(configJson: string): void;
  updateDeps(deps: object): void;
  updateVirtualRouterConfig(configJson: string): void;
  route(requestJson: string, metadataJson: string): string;
  diagnoseRoute?(requestJson: string, metadataJson: string): string;
  getStopMessageState(metadataJson: string): string;
  getPreCommandState(metadataJson: string): string;
  markProviderCooldown(providerKey: string, cooldownMs?: number): void;
  clearProviderCooldown(providerKey: string): void;
  handleProviderFailure(eventJson: string): void;
  handleProviderError(eventJson: string): void;
  handleProviderSuccess(eventJson: string): void;
  getStatus(): string;
  resetProviderQuota?(providerKey: string): void;
  recoverProviderQuota?(providerKey: string): void;
  disableProviderQuota?(providerKey: string, mode: string, durationMs?: number): void;
  applyKeepPoolCooldownQuota?(providerKey: string, cooldownUntilMs: number, lastErrorCode?: string): void;
  markConcurrencyScopeBusy?(scopeKey: string): void;
  markConcurrencyScopeIdle?(scopeKey: string): void;
  registerProviderRuntimeIngress?(): void;
  unregisterProviderRuntimeIngress?(): void;
}

type ProxyConstructor = new (engine?: object) => NativeVirtualRouterEngineProxy;

function resolveProxyConstructor(): ProxyConstructor {
  const ctor = readNativeFunction('VirtualRouterEngineProxy');
  if (typeof ctor !== 'function') {
    return failNativeRequired<ProxyConstructor>('VirtualRouterEngineProxy', 'missing native proxy constructor');
  }
  return ctor as unknown as ProxyConstructor;
}

export function createVirtualRouterEngineProxy(engine?: object): NativeVirtualRouterEngineProxy {
  const Ctor = resolveProxyConstructor();
  return new Ctor(engine);
}

export type VirtualRouterRuntimeDeps = {
  healthStore?: VirtualRouterHealthStore;
  routingStateStore?: {
    loadSync: (key: string) => unknown;
    saveAsync: (key: string, state: unknown) => void;
    saveSync?: (key: string, state: unknown) => void;
  };
};

export type VirtualRouterRuntime = {
  initialize(config: VirtualRouterConfig): void;
  updateDeps(deps: {
    healthStore?: VirtualRouterHealthStore | null;
    routingStateStore?: VirtualRouterRuntimeDeps['routingStateStore'] | null;
  }): void;
  updateVirtualRouterConfig(config: VirtualRouterConfig): void;
  route(
    request: NativeRouterRequest,
    metadata: RouterMetadataInput | Record<string, unknown>
  ): { target: TargetMetadata; decision: RoutingDecision; diagnostics: RoutingDiagnostics };
  getStopMessageState(metadata: RouterMetadataInput | Record<string, unknown>): StopMessageStateSnapshot | null;
  getPreCommandState(metadata: RouterMetadataInput | Record<string, unknown>): PreCommandStateSnapshot | null;
  markProviderCooldown(providerKey: string, cooldownMs: number | undefined): void;
  clearProviderCooldown(providerKey: string): void;
  markConcurrencyScopeBusy(scopeKey: string): void;
  markConcurrencyScopeIdle(scopeKey: string): void;
  handleProviderFailure(event: ProviderFailureEvent): void;
  handleProviderError(event: ProviderErrorEvent): void;
  handleProviderSuccess(event: ProviderSuccessEvent): void;
  getStatus(): RoutingStatusSnapshot;
  diagnoseRoute(
    request: NativeRouterRequest,
    metadata: RouterMetadataInput | Record<string, unknown>
  ): VirtualRouterDryRunDiagnostics;
  resetProviderQuota(providerKey: string): void;
  recoverProviderQuota(providerKey: string): void;
  disableProviderQuota(providerKey: string, mode: 'cooldown' | 'blacklist', durationMs: number): void;
  applyKeepPoolCooldownQuota(providerKey: string, cooldownUntilMs: number, lastErrorCode?: string): void;
  registerProviderRuntimeIngress(): void;
  unregisterProviderRuntimeIngress(): void;
};

export class VirtualRouterEngine implements VirtualRouterRuntime {
  private readonly nativeProxy: NativeVirtualRouterEngineProxy;

  constructor(deps?: VirtualRouterRuntimeDeps) {
    this.nativeProxy = createVirtualRouterEngineProxy();
    if (deps) {
      this.nativeProxy.updateDeps(deps as unknown as object);
    }
  }

  initialize(config: VirtualRouterConfig): void {
    assertNativeVoidResult(this.nativeProxy.initialize(JSON.stringify(config)));
  }

  updateDeps(deps: {
    healthStore?: VirtualRouterHealthStore | null;
    routingStateStore?: VirtualRouterRuntimeDeps['routingStateStore'] | null;
  }): void {
    this.nativeProxy.updateDeps(deps as unknown as object);
  }

  updateVirtualRouterConfig(config: VirtualRouterConfig): void {
    assertNativeVoidResult(this.nativeProxy.updateVirtualRouterConfig(JSON.stringify(config)));
  }

  route(
    request: NativeRouterRequest,
    metadata: RouterMetadataInput | Record<string, unknown> = {}
  ): { target: TargetMetadata; decision: RoutingDecision; diagnostics: RoutingDiagnostics } {
    const routeHostEffects = createVirtualRouterRouteHostEffects({ request, metadata });
    const nativeMetadata = injectVirtualRouterRuntimeMetadata(metadata);
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
    routeHostEffects.finalize(parsed, (stateMetadata) => this.getStopMessageState(stateMetadata));
    return parsed;
  }

  getStopMessageState(metadata: RouterMetadataInput | Record<string, unknown>): StopMessageStateSnapshot | null {
    const raw = this.nativeProxy.getStopMessageState(JSON.stringify(injectVirtualRouterRuntimeMetadata(metadata)));
    return JSON.parse(raw) as StopMessageStateSnapshot | null;
  }

  getPreCommandState(metadata: RouterMetadataInput | Record<string, unknown>): PreCommandStateSnapshot | null {
    const raw = this.nativeProxy.getPreCommandState(JSON.stringify(injectVirtualRouterRuntimeMetadata(metadata)));
    return JSON.parse(raw) as PreCommandStateSnapshot | null;
  }

  markProviderCooldown(providerKey: string, cooldownMs: number | undefined): void {
    this.nativeProxy.markProviderCooldown(providerKey, cooldownMs);
  }

  clearProviderCooldown(providerKey: string): void {
    this.nativeProxy.clearProviderCooldown(providerKey);
  }

  markConcurrencyScopeBusy(scopeKey: string): void {
    this.nativeProxy.markConcurrencyScopeBusy?.(scopeKey);
  }

  markConcurrencyScopeIdle(scopeKey: string): void {
    this.nativeProxy.markConcurrencyScopeIdle?.(scopeKey);
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

  diagnoseRoute(
    request: NativeRouterRequest,
    metadata: RouterMetadataInput | Record<string, unknown> = {}
  ): VirtualRouterDryRunDiagnostics {
    if (typeof this.nativeProxy.diagnoseRoute !== 'function') {
      throw new Error('VirtualRouterEngineProxy.diagnoseRoute is not available');
    }
    const nativeMetadata = injectVirtualRouterRuntimeMetadata(metadata);
    const raw = this.nativeProxy.diagnoseRoute(JSON.stringify(request), JSON.stringify(nativeMetadata));
    return JSON.parse(raw) as VirtualRouterDryRunDiagnostics;
  }

  resetProviderQuota(providerKey: string): void {
    this.nativeProxy.resetProviderQuota?.(providerKey);
  }

  recoverProviderQuota(providerKey: string): void {
    this.nativeProxy.recoverProviderQuota?.(providerKey);
  }

  disableProviderQuota(providerKey: string, mode: 'cooldown' | 'blacklist', durationMs: number): void {
    this.nativeProxy.disableProviderQuota?.(providerKey, mode, durationMs);
  }

  applyKeepPoolCooldownQuota(providerKey: string, cooldownUntilMs: number, lastErrorCode?: string): void {
    this.nativeProxy.applyKeepPoolCooldownQuota?.(providerKey, cooldownUntilMs, lastErrorCode);
  }

  registerProviderRuntimeIngress(): void {
    if (typeof this.nativeProxy.registerProviderRuntimeIngress !== 'function') {
      throw new Error('VirtualRouterEngineProxy.registerProviderRuntimeIngress is not available');
    }
    this.nativeProxy.registerProviderRuntimeIngress();
  }

  unregisterProviderRuntimeIngress(): void {
    if (typeof this.nativeProxy.unregisterProviderRuntimeIngress !== 'function') {
      throw new Error('VirtualRouterEngineProxy.unregisterProviderRuntimeIngress is not available');
    }
    this.nativeProxy.unregisterProviderRuntimeIngress();
  }
}

export function createVirtualRouterRuntime(deps?: VirtualRouterRuntimeDeps): VirtualRouterRuntime {
  return new VirtualRouterEngine(deps);
}

function invokeTokenEstimator(request: NativeRouterRequest): number {
  const parsed = callNativeJson(
    'estimateVirtualRouterRequestTokensJson',
    'estimateVirtualRouterRequestTokensJson',
    [JSON.stringify({ request })],
    (raw) => {
      try {
        return JSON.parse(raw) as TokenEstimateOutput;
      } catch {
        return null;
      }
    },
    {
      emptyReason: 'empty result',
      invalidReason: 'invalid result'
    }
  );
  if (typeof parsed.tokens !== 'number' || !Number.isSafeInteger(parsed.tokens) || parsed.tokens < 0) {
    throw failNativeRequired<number>('estimateVirtualRouterRequestTokensJson', 'invalid token count');
  }
  return parsed.tokens;
}

export function countRequestTokens(request: NativeRouterRequest): number {
  return invokeTokenEstimator(request);
}

export function computeRequestTokens(
  request: NativeRouterRequest,
  _fallbackText = ''
): number {
  return invokeTokenEstimator(request);
}

function stringifyForNative(capability: string, value: unknown): string {
  return safeStringify(value) ?? failNativeRequired<string>(capability, 'json stringify failed');
}

function parseStringArrayPayload(raw: string): string[] | null {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) return null;
  return parsed.every((entry) => typeof entry === 'string') ? parsed : null;
}

function parseStopMessageInstructionPayload(raw: string): StopMessageResolvedNativeParseOutput | null {
  const parsed = parseRecord(raw);
  if (!parsed) return null;
  if (parsed.type === 'stopMessageClear') return { type: 'stopMessageClear' };
  if (
    parsed.type === 'stopMessageMode' &&
    (parsed.stopMessageStageMode === 'on' ||
      parsed.stopMessageStageMode === 'off' ||
      parsed.stopMessageStageMode === 'auto')
  ) {
    return {
      type: 'stopMessageMode',
      stopMessageStageMode: parsed.stopMessageStageMode,
      ...(typeof parsed.stopMessageMaxRepeats === 'number' ? { stopMessageMaxRepeats: parsed.stopMessageMaxRepeats } : {})
    };
  }
  if (parsed.type !== 'stopMessageSet' || typeof parsed.stopMessageText !== 'string') return null;
  return {
    type: 'stopMessageSet',
    stopMessageText: parsed.stopMessageText,
    ...(typeof parsed.stopMessageMaxRepeats === 'number' ? { stopMessageMaxRepeats: parsed.stopMessageMaxRepeats } : {}),
    ...(parsed.stopMessageSource === 'explicit_file' || parsed.stopMessageSource === 'explicit_text'
      ? { stopMessageSource: parsed.stopMessageSource }
      : {})
  };
}

function parseRoutingInstructionKindsWithNative(request: Record<string, unknown>): string[] {
  const capability = 'parseRoutingInstructionKindsJson';
  const fn = readNativeFunction(capability);
  if (!fn) return failNativeRequired<string[]>(capability);
  const requestJson = stringifyForNative(capability, request);
  const optionsJson = stringifyForNative(capability, { rccUserDir: resolveRccUserDir() });
  try {
    const raw = fn(requestJson, optionsJson);
    if (typeof raw !== 'string' || !raw) return failNativeRequired<string[]>(capability, 'empty result');
    return parseStringArrayPayload(raw) ?? failNativeRequired<string[]>(capability, 'invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return failNativeRequired<string[]>(capability, reason);
  }
}

function parseResolvedStopMessageInstructionWithNative(
  instruction: string
): StopMessageResolvedNativeParseOutput | null {
  const capability = 'parseResolvedStopMessageInstructionJson';
  const fn = readNativeFunction(capability);
  if (!fn) return failNativeRequired<StopMessageResolvedNativeParseOutput | null>(capability);
  const optionsJson = stringifyForNative(capability, { rccUserDir: resolveRccUserDir() });
  try {
    const raw = fn(String(instruction || ''), optionsJson);
    if (typeof raw !== 'string') return failNativeRequired<StopMessageResolvedNativeParseOutput | null>(capability, 'non-string result');
    if (!raw || raw === 'null') return null;
    return parseStopMessageInstructionPayload(raw) ?? failNativeRequired<StopMessageResolvedNativeParseOutput | null>(capability, 'invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return failNativeRequired<StopMessageResolvedNativeParseOutput | null>(capability, reason);
  }
}

function resolveStopMessageScope(metadata: RouterMetadataInput | Record<string, unknown>): string | undefined {
  const capability = 'resolveVirtualRouterStopMessageScopeJson';
  const fn = readNativeFunction(capability);
  if (!fn) return failNativeRequired<string | undefined>(capability);
  try {
    const raw = fn(stringifyForNative(capability, metadata ?? null));
    if (typeof raw !== 'string' || !raw) return failNativeRequired<string | undefined>(capability, 'empty result');
    const parsed = parseJson(raw);
    if (parsed === null) return undefined;
    return typeof parsed === 'string' && parsed.trim()
      ? parsed.trim()
      : failNativeRequired<string | undefined>(capability, 'invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return failNativeRequired<string | undefined>(capability, reason);
  }
}

export function parseStopMessageInstruction(instruction: string): RoutingInstruction | null {
  const resolved = parseResolvedStopMessageInstructionWithNative(instruction);
  if (!resolved) return null;
  if (resolved.type === 'stopMessageClear') return { type: 'stopMessageClear' };
  if (resolved.type === 'stopMessageMode') {
    return {
      type: 'stopMessageMode',
      stopMessageStageMode: resolved.stopMessageStageMode,
      stopMessageMaxRepeats: resolved.stopMessageMaxRepeats
    };
  }
  return {
    type: 'stopMessageSet',
    stopMessageText: resolved.stopMessageText,
    stopMessageMaxRepeats: resolved.stopMessageMaxRepeats,
    stopMessageSource: resolved.stopMessageSource
  };
}

export function buildStopMessageMarkerParseLog(
  request: NativeRouterRequest,
  metadata: RouterMetadataInput
): StopMessageMarkerParseLog | null {
  const capability = 'buildStopMessageMarkerParseLogJson';
  const fn = readNativeFunction(capability);
  if (!fn) return failNativeRequired<StopMessageMarkerParseLog | null>(capability);
  const parsedKinds = parseRoutingInstructionKindsWithNative(request as unknown as Record<string, unknown>);
  const requestJson = safeStringify(request ?? null);
  const metadataJson = safeStringify(metadata ?? null);
  const parsedKindsJson = safeStringify(parsedKinds);
  if (!requestJson || !metadataJson || !parsedKindsJson) {
    return failNativeRequired<StopMessageMarkerParseLog | null>(capability, 'json stringify failed');
  }
  const stopScope = resolveStopMessageScope(metadata);
  try {
    const raw = fn(requestJson, metadataJson, parsedKindsJson, stopScope);
    if (typeof raw !== 'string' || !raw) {
      return failNativeRequired<StopMessageMarkerParseLog | null>(capability, 'empty result');
    }
    if (raw === 'null') return null;
    const parsed = parseRecord(raw);
    if (!parsed) return failNativeRequired<StopMessageMarkerParseLog | null>(capability, 'invalid payload');
    return {
      requestId: typeof parsed.requestId === 'string' ? parsed.requestId : 'n/a',
      markerDetected: parsed.markerDetected === true,
      preview: typeof parsed.preview === 'string' ? parsed.preview : '',
      stopMessageTypes: Array.isArray(parsed.stopMessageTypes)
        ? parsed.stopMessageTypes.filter((entry): entry is string => typeof entry === 'string')
        : [],
      scopedTypes: Array.isArray(parsed.scopedTypes)
        ? parsed.scopedTypes.filter((entry): entry is string => typeof entry === 'string')
        : [],
      ...(typeof parsed.stopScope === 'string' ? { stopScope: parsed.stopScope } : {})
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return failNativeRequired<StopMessageMarkerParseLog | null>(capability, reason);
  }
}

export function emitStopMessageMarkerParseLog(log: StopMessageMarkerParseLog | null): void {
  const capability = 'emitStopMessageMarkerParseLogJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    failNativeRequired<void>(capability);
    return;
  }
  const logJson = log ? safeStringify(log) : undefined;
  if (log && !logJson) {
    failNativeRequired<void>(capability, 'json stringify failed');
    return;
  }
  try {
    fn(logJson);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    failNativeRequired<void>(capability, reason);
  }
}

export function cleanStopMessageMarkersInPlace(request: Record<string, unknown>): void {
  const capability = 'cleanStopMessageMarkersInPlaceJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    failNativeRequired<void>(capability);
    return;
  }
  const requestJson = safeStringify(request ?? null);
  if (!requestJson) {
    failNativeRequired<void>(capability, 'json stringify failed');
    return;
  }
  try {
    const raw = fn(requestJson);
    if (typeof raw !== 'string' || !raw) {
      failNativeRequired<void>(capability, 'empty result');
      return;
    }
    const parsed = parseRecord(raw);
    if (!parsed) {
      failNativeRequired<void>(capability, 'invalid payload');
      return;
    }
    for (const key of Object.keys(request)) {
      delete request[key];
    }
    Object.assign(request, parsed);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    failNativeRequired<void>(capability, reason);
  }
}

export function formatStopMessageStatusLabel(
  snapshot: StopMessageStateSnapshot | null,
  scope: string | undefined,
  forceShow: boolean
): string {
  const capability = 'formatStopMessageStatusLabelJson';
  const fn = readNativeFunction(capability);
  if (!fn) return failNativeRequired<string>(capability);
  const snapshotJson = snapshot ? safeStringify(snapshot) : undefined;
  if (snapshot && !snapshotJson) {
    return failNativeRequired<string>(capability, 'json stringify failed');
  }
  try {
    const raw = fn(snapshotJson, scope, forceShow);
    if (typeof raw !== 'string') {
      return failNativeRequired<string>(capability, 'invalid payload');
    }
    return raw;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return failNativeRequired<string>(capability, reason);
  }
}

export function createVirtualRouterRouteHostEffects(args: {
  request: NativeRouterRequest;
  metadata: RouterMetadataInput | Record<string, unknown>;
  hitLog?: VirtualRouterHitLogConfig;
}): VirtualRouterRouteHostEffects {
  const metadata = coerceRouterMetadata(args.metadata);
  const parseLog = buildStopMessageMarkerParseLog(args.request, metadata);
  return {
    finalize: (result, getStopMessageState) => {
      emitStopMessageMarkerParseLog(parseLog);
      cleanStopMessageMarkersInPlace(args.request as Record<string, unknown>);
      const stopScope = parseLog?.stopScope || resolveStopMessageScope(metadata);
      const stopState = stopScope ? getStopMessageState(metadata) : null;
      const forceStopStatusLabel = Boolean(
        parseLog?.stopMessageTypes.length ||
        parseLog?.scopedTypes.some((type) => type === 'stopMessageSet' || type === 'stopMessageMode' || type === 'stopMessageClear')
      );
      if ((metadata as { __rt?: Record<string, unknown> }).__rt?.disableVirtualRouterHitLog !== true) {
        emitVirtualRouterHitLog(result, {
          requestId: resolveVirtualRouterLogRequestId(metadata),
          sessionId: resolveVirtualRouterLogSessionId(metadata),
          stopScope,
          stopState,
          forceStopStatusLabel,
          hitLog: args.hitLog
        });
      }
    }
  };
}

export function injectVirtualRouterRuntimeMetadata(
  metadata: RouterMetadataInput | Record<string, unknown>
): Record<string, unknown> {
  const metadataRecord = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  const nowMs = Date.now();
  const rt = metadataRecord.__rt;
  const existingRt = rt && typeof rt === 'object' && !Array.isArray(rt)
    ? (rt as Record<string, unknown>)
    : undefined;
  const runtimeOverrides: Record<string, unknown> = { nowMs };

  const hasRccUserDir = typeof existingRt?.rccUserDir === 'string' && existingRt.rccUserDir.trim().length > 0;
  if (!hasRccUserDir) {
    const rccUserDir = resolveRccUserDir();
    if (rccUserDir) {
      runtimeOverrides.rccUserDir = rccUserDir;
    }
  }

  return {
    ...metadataRecord,
    __rt: { ...(existingRt ?? {}), ...runtimeOverrides }
  };
}

function coerceRouterMetadata(metadata: RouterMetadataInput | Record<string, unknown>): RouterMetadataInput {
  return (metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata
    : {}) as RouterMetadataInput;
}

export function emitVirtualRouterHitLog(result: {
  target: TargetMetadata;
  decision: RoutingDecision;
}, options?: {
  requestId?: string;
  sessionId?: string;
  stopScope?: string;
  stopState?: StopMessageStateSnapshot | null;
  forceStopStatusLabel?: boolean;
  hitLog?: VirtualRouterHitLogConfig;
}): void {
  const providerKey = result.decision.providerKey || result.target.providerKey;
  const stopState = options?.stopState ?? null;
  const record = createVirtualRouterHitRecordNative({
    requestId: options?.requestId,
    sessionId: options?.sessionId,
    routeName: result.decision.routeName,
    poolId: result.decision.poolId,
    providerKey,
    modelId: result.target.modelId,
    hitReason: result.decision.reasoning,
    routingState: stopState
      ? {
          stopMessageText: stopState.stopMessageText,
          stopMessageMaxRepeats: stopState.stopMessageMaxRepeats,
          stopMessageUsed: stopState.stopMessageUsed,
          stopMessageUpdatedAt: stopState.stopMessageUpdatedAt,
          stopMessageLastUsedAt: stopState.stopMessageLastUsedAt,
          stopMessageStageMode: stopState.stopMessageStageMode
        }
      : undefined
  });
  const line = formatVirtualRouterHitNative(record, options?.hitLog);
  const forcedStopStatusLabel = options?.forceStopStatusLabel && !stopState
    ? formatStopMessageStatusLabel(null, options?.stopScope, true)
    : '';
  console.log(forcedStopStatusLabel ? `${line} ${forcedStopStatusLabel}` : line);
}

function resolveVirtualRouterLogRequestId(metadata: RouterMetadataInput): string | undefined {
  const metadataRecord = metadata as unknown as Record<string, unknown>;
  const candidates = [
    metadata.requestId,
    metadataRecord.clientRequestId,
    metadataRecord.inputRequestId,
    metadataRecord.groupRequestId
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim() && !value.includes('unknown')) {
      return value.trim();
    }
  }
  return undefined;
}

function resolveVirtualRouterLogSessionId(metadata: RouterMetadataInput): string | undefined {
  return resolveSessionLogColorKeyNative(metadata as unknown as Record<string, unknown>);
}

function createVirtualRouterHitRecordNative(input: Record<string, unknown>): Record<string, unknown> {
  const capability = 'createVirtualRouterHitRecordJson';
  const fn = readNativeFunction(capability);
  if (!fn) return failNativeRequired<Record<string, unknown>>(capability);
  const inputJson = safeStringify(input);
  if (!inputJson) {
    return failNativeRequired<Record<string, unknown>>(capability, 'json stringify failed');
  }
  try {
    const raw = fn(inputJson);
    if (typeof raw !== 'string') {
      return failNativeRequired<Record<string, unknown>>(capability, 'invalid payload');
    }
    const parsed = parseRecord(raw);
    if (!parsed) {
      return failNativeRequired<Record<string, unknown>>(capability, 'invalid payload');
    }
    return parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return failNativeRequired<Record<string, unknown>>(capability, reason);
  }
}

function formatVirtualRouterHitNative(record: Record<string, unknown>, config?: VirtualRouterHitLogConfig): string {
  const capability = 'formatVirtualRouterHitJson';
  const fn = readNativeFunction(capability);
  if (!fn) return failNativeRequired<string>(capability);
  const recordJson = safeStringify(record);
  const configJson = config ? safeStringify(config) : undefined;
  if (!recordJson || (config && !configJson)) {
    return failNativeRequired<string>(capability, 'json stringify failed');
  }
  try {
    const raw = fn(recordJson, configJson);
    if (typeof raw !== 'string' || raw.length === 0) {
      return failNativeRequired<string>(capability, 'invalid payload');
    }
    return raw;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return failNativeRequired<string>(capability, reason);
  }
}

function resolveSessionLogColorKeyNative(metadata: Record<string, unknown>): string | undefined {
  const capability = 'resolveSessionLogColorKeyJson';
  const fn = readNativeFunction(capability);
  if (!fn) return failNativeRequired<string | undefined>(capability);
  const metadataJson = safeStringify(metadata ?? null);
  if (!metadataJson) {
    return failNativeRequired<string | undefined>(capability, 'json stringify failed');
  }
  try {
    const raw = fn(metadataJson);
    if (typeof raw !== 'string') {
      return failNativeRequired<string | undefined>(capability, 'invalid payload');
    }
    const parsed = parseJson(raw);
    if (typeof parsed !== 'string') {
      return undefined;
    }
    const trimmed = parsed.trim();
    return trimmed || undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return failNativeRequired<string | undefined>(capability, reason);
  }
}

function normalizeNativeVirtualRouterError(error: unknown): Error {
  if (error instanceof VirtualRouterError) {
    return error;
  }
  const parsed = parseVirtualRouterNativeError(error);
  if (parsed) {
    return parsed;
  }
  const message = extractVirtualRouterNativeErrorMessage(error);
  if (isVirtualRouterErrorLike(error)) {
    const details =
      (error as { details?: unknown }).details && typeof (error as { details?: unknown }).details === 'object' && !Array.isArray((error as { details?: unknown }).details)
        ? ((error as { details?: unknown }).details as Record<string, unknown>)
        : undefined;
    return new VirtualRouterError(
      typeof error.message === 'string' && error.message.trim() ? error.message : 'Virtual router error',
      error.code,
      details
    );
  }
  return error instanceof Error ? error : new Error(message || 'Virtual router error');
}

function assertNativeVoidResult(result: unknown): void {
  if (result === undefined || result === null) {
    return;
  }
  throw normalizeNativeVirtualRouterError(result);
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
