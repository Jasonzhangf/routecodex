import path from 'node:path';
import { createRequire } from 'node:module';

import {
  parseVirtualRouterNativeError,
  VIRTUAL_ROUTER_ERROR_PREFIX,
  VirtualRouterError,
  VirtualRouterErrorCode
} from '../../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-loader.js';
import type {
  ProviderErrorEvent,
  ProviderFailureEvent,
  ProviderSuccessEvent,
  RouterMetadataInput,
  RoutingDecision,
  RoutingDiagnostics,
  RoutingStatusSnapshot,
  StopMessageStateSnapshot,
  PreCommandStateSnapshot,
  TargetMetadata,
  VirtualRouterConfig,
  VirtualRouterDryRunDiagnostics,
  VirtualRouterHealthStore
} from '../../../sharedmodule/llmswitch-core/src/native/router-hotpath/virtual-router-contracts.js';

const nodeRequire = createRequire(import.meta.url);
const nativeBinding = nodeRequire(
  path.resolve(process.cwd(), 'sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node')
) as Record<string, unknown>;

type NativeRouterRequest = Record<string, unknown>;

type TokenEstimateOutput = {
  tokens?: unknown;
};

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

export type VirtualRouterRuntimeDeps = {
  healthStore?: VirtualRouterHealthStore;
  routingStateStore?: {
    loadSync: (key: string) => unknown;
    saveAsync: (key: string, state: unknown) => void;
    saveSync?: (key: string, state: unknown) => void;
  };
};

type NativeVirtualRouterEngineProxy = {
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
};

type ProxyConstructor = new (engine?: object) => NativeVirtualRouterEngineProxy;

function nativeFn(name: string): (...args: unknown[]) => unknown {
  const fn = nativeBinding[name];
  if (typeof fn !== 'function') {
    throw new Error(`${name} native export is required`);
  }
  return fn as (...args: unknown[]) => unknown;
}

function proxyConstructor(): ProxyConstructor {
  return nativeFn('VirtualRouterEngineProxy') as unknown as ProxyConstructor;
}

function injectVirtualRouterRuntimeMetadata(
  metadata: RouterMetadataInput | Record<string, unknown>
): Record<string, unknown> {
  const metadataRecord = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  const existingSnapshot = metadataRecord.metadataCenterSnapshot
    && typeof metadataRecord.metadataCenterSnapshot === 'object'
    && !Array.isArray(metadataRecord.metadataCenterSnapshot)
    ? metadataRecord.metadataCenterSnapshot as Record<string, unknown>
    : {};
  const existingRt = metadataRecord.__rt && typeof metadataRecord.__rt === 'object' && !Array.isArray(metadataRecord.__rt)
    ? metadataRecord.__rt as Record<string, unknown>
    : {};
  const runtimeControl: Record<string, unknown> = existingSnapshot.runtimeControl
    && typeof existingSnapshot.runtimeControl === 'object'
    && !Array.isArray(existingSnapshot.runtimeControl)
    ? { ...existingSnapshot.runtimeControl as Record<string, unknown> }
    : {};
  for (const key of ['sessionDir', 'session_dir', 'rccUserDir', 'rcc_user_dir']) {
    if (existingRt[key] !== undefined && runtimeControl[key] === undefined) {
      runtimeControl[key] = existingRt[key];
    }
  }
  const metadataCenterSnapshot: Record<string, unknown> = {
    ...existingSnapshot,
    runtimeControl
  };
  const snapshotMirrorKeys = [
    'requestId',
    'sessionId',
    'conversationId',
    'tmuxSessionId',
    'clientTmuxSessionId',
    'entryEndpoint',
    'processMode',
    'stream',
    'direction',
    'providerProtocol',
    'stage',
    'routeHint',
    'serverToolRequired',
    'excludedProviderKeys',
    'allowedProviders',
    'disabledProviderKeyAliases',
    'continuation',
    'retryProviderKey'
  ];
  for (const key of snapshotMirrorKeys) {
    const value = metadataRecord[key];
    if (value !== undefined && metadataCenterSnapshot[key] === undefined) {
      metadataCenterSnapshot[key] = value;
    }
  }
  const routeControlKeys = ['requestId', 'sessionId', 'conversationId', 'excludedProviderKeys', 'continuation'];
  const topLevelRouteControls: Record<string, unknown> = {};
  for (const key of routeControlKeys) {
    if (metadataRecord[key] !== undefined) {
      metadataCenterSnapshot[key] = metadataRecord[key];
      topLevelRouteControls[key] = metadataRecord[key];
    } else if (existingSnapshot[key] !== undefined) {
      topLevelRouteControls[key] = existingSnapshot[key];
    }
  }
  return {
    ...metadataRecord,
    ...topLevelRouteControls,
    metadataCenterSnapshot,
    __rt: {
      ...existingRt,
      nowMs: Date.now()
    }
  };
}

function assertNativeVoidResult(raw: unknown): void {
  if (raw === undefined || raw === null) {
    return;
  }
  if (typeof raw === 'string' && (raw.startsWith('Error:') || raw.startsWith(VIRTUAL_ROUTER_ERROR_PREFIX))) {
    throw normalizeNativeVirtualRouterError(raw);
  }
  if (raw instanceof Error) {
    throw normalizeNativeVirtualRouterError(raw);
  }
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message.trim()) {
      throw normalizeNativeVirtualRouterError(record);
    }
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
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const code = typeof record.code === 'string' && Object.values(VirtualRouterErrorCode).includes(record.code as VirtualRouterErrorCode)
      ? record.code as VirtualRouterErrorCode
      : undefined;
    if (code) {
      const details = record.details && typeof record.details === 'object' && !Array.isArray(record.details)
        ? record.details as Record<string, unknown>
        : undefined;
      return new VirtualRouterError(
        typeof record.message === 'string' && record.message ? record.message : 'Virtual router error',
        code,
        details
      );
    }
  }
  return error instanceof Error ? error : new Error(String(error ?? 'Virtual router error'));
}

function parseRecord(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || !raw) return null;
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

function parseNativeJson<T>(capability: string, raw: unknown): T {
  if (typeof raw !== 'string') {
    throw new Error(`${capability} returned non-string result`);
  }
  if (!raw) {
    throw new Error(`${capability} returned empty result`);
  }
  return JSON.parse(raw) as T;
}

function parseStringArrayPayload(capability: string, raw: unknown): string[] {
  const parsed = parseNativeJson<unknown>(capability, raw);
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) {
    throw new Error(`${capability} returned invalid string array`);
  }
  return parsed;
}

function parseStopMessageInstructionPayload(raw: unknown): RoutingInstruction | null {
  if (typeof raw !== 'string') {
    throw new Error('parseResolvedStopMessageInstructionJson returned non-string result');
  }
  if (!raw || raw === 'null') return null;
  const parsed = parseRecord(raw);
  if (!parsed) {
    throw new Error('parseResolvedStopMessageInstructionJson returned invalid payload');
  }
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
  if (parsed.type !== 'stopMessageSet' || typeof parsed.stopMessageText !== 'string') {
    throw new Error('parseResolvedStopMessageInstructionJson returned invalid stop-message payload');
  }
  return {
    type: 'stopMessageSet',
    stopMessageText: parsed.stopMessageText,
    ...(typeof parsed.stopMessageMaxRepeats === 'number' ? { stopMessageMaxRepeats: parsed.stopMessageMaxRepeats } : {}),
    ...(parsed.stopMessageSource === 'explicit_file' || parsed.stopMessageSource === 'explicit_text'
      ? { stopMessageSource: parsed.stopMessageSource }
      : {})
  };
}

function parseRoutingInstructionKinds(request: Record<string, unknown>): string[] {
  return parseStringArrayPayload(
    'parseRoutingInstructionKindsJson',
    nativeFn('parseRoutingInstructionKindsJson')(
      JSON.stringify(request),
      JSON.stringify({ rccUserDir: process.env.RCC_USER_DIR || undefined })
    )
  );
}

function resolveStopMessageScope(metadata: RouterMetadataInput | Record<string, unknown>): string | undefined {
  const raw = nativeFn('resolveVirtualRouterStopMessageScopeJson')(JSON.stringify(metadata ?? null));
  const parsed = parseNativeJson<unknown>('resolveVirtualRouterStopMessageScopeJson', raw);
  return typeof parsed === 'string' && parsed.trim() ? parsed.trim() : undefined;
}

export class VirtualRouterEngine {
  public nativeProxy: NativeVirtualRouterEngineProxy;

  constructor(deps?: VirtualRouterRuntimeDeps) {
    const Ctor = proxyConstructor();
    this.nativeProxy = new Ctor();
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
    let raw: unknown;
    try {
      raw = this.nativeProxy.route(
        JSON.stringify(request),
        JSON.stringify(injectVirtualRouterRuntimeMetadata(metadata))
      );
    } catch (error) {
      throw normalizeNativeVirtualRouterError(error);
    }
    if (typeof raw !== 'string' || raw.startsWith('Error:') || raw.startsWith(VIRTUAL_ROUTER_ERROR_PREFIX)) {
      throw normalizeNativeVirtualRouterError(raw);
    }
    return JSON.parse(raw) as { target: TargetMetadata; decision: RoutingDecision; diagnostics: RoutingDiagnostics };
  }

  getStopMessageState(metadata: RouterMetadataInput | Record<string, unknown>): StopMessageStateSnapshot | null {
    return JSON.parse(
      this.nativeProxy.getStopMessageState(JSON.stringify(injectVirtualRouterRuntimeMetadata(metadata)))
    ) as StopMessageStateSnapshot | null;
  }

  getPreCommandState(metadata: RouterMetadataInput | Record<string, unknown>): PreCommandStateSnapshot | null {
    return JSON.parse(
      this.nativeProxy.getPreCommandState(JSON.stringify(injectVirtualRouterRuntimeMetadata(metadata)))
    ) as PreCommandStateSnapshot | null;
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
    return JSON.parse(
      this.nativeProxy.diagnoseRoute(
        JSON.stringify(request),
        JSON.stringify(injectVirtualRouterRuntimeMetadata(metadata))
      )
    ) as VirtualRouterDryRunDiagnostics;
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

export function countRequestTokens(request: NativeRouterRequest): number {
  const raw = nativeFn('estimateVirtualRouterRequestTokensJson')(JSON.stringify({ request }));
  const parsed = JSON.parse(String(raw)) as TokenEstimateOutput;
  if (typeof parsed.tokens !== 'number' || !Number.isSafeInteger(parsed.tokens) || parsed.tokens < 0) {
    throw new Error('estimateVirtualRouterRequestTokensJson returned invalid token count');
  }
  return parsed.tokens;
}

export function computeRequestTokens(request: NativeRouterRequest, _fallbackText = ''): number {
  return countRequestTokens(request);
}

export function parseStopMessageInstruction(instruction: string): RoutingInstruction | null {
  return parseStopMessageInstructionPayload(
    nativeFn('parseResolvedStopMessageInstructionJson')(
      String(instruction || ''),
      JSON.stringify({ rccUserDir: process.env.RCC_USER_DIR || undefined })
    )
  );
}

export function buildStopMessageMarkerParseLog(
  request: NativeRouterRequest,
  metadata: RouterMetadataInput
): StopMessageMarkerParseLog | null {
  const parsedKinds = parseRoutingInstructionKinds(request);
  const stopScope = resolveStopMessageScope(metadata);
  const raw = nativeFn('buildStopMessageMarkerParseLogJson')(
    JSON.stringify(request ?? null),
    JSON.stringify(metadata ?? null),
    JSON.stringify(parsedKinds),
    stopScope
  );
  if (raw === 'null') return null;
  const parsed = parseRecord(raw);
  if (!parsed) {
    throw new Error('buildStopMessageMarkerParseLogJson returned invalid payload');
  }
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
}

export function cleanStopMessageMarkersInPlace(request: Record<string, unknown>): void {
  const raw = nativeFn('cleanStopMessageMarkersInPlaceJson')(JSON.stringify(request ?? null));
  const parsed = parseRecord(raw);
  if (!parsed) {
    throw new Error('cleanStopMessageMarkersInPlaceJson returned invalid payload');
  }
  for (const key of Object.keys(request)) {
    delete request[key];
  }
  Object.assign(request, parsed);
}

export function formatStopMessageStatusLabel(
  snapshot: StopMessageStateSnapshot | null,
  scope: string | undefined,
  forceShow: boolean
): string {
  const raw = nativeFn('formatStopMessageStatusLabelJson')(
    snapshot ? JSON.stringify(snapshot) : undefined,
    scope,
    forceShow
  );
  if (typeof raw !== 'string') {
    throw new Error('formatStopMessageStatusLabelJson returned invalid payload');
  }
  return raw;
}

function emitStopMessageMarkerParseLog(log: StopMessageMarkerParseLog | null): void {
  nativeFn('emitStopMessageMarkerParseLogJson')(log ? JSON.stringify(log) : undefined);
}

function createVirtualRouterHitRecord(input: Record<string, unknown>): Record<string, unknown> {
  const parsed = parseRecord(nativeFn('createVirtualRouterHitRecordJson')(JSON.stringify(input)));
  if (!parsed) {
    throw new Error('createVirtualRouterHitRecordJson returned invalid payload');
  }
  return parsed;
}

function formatVirtualRouterHit(record: Record<string, unknown>, config?: VirtualRouterHitLogConfig): string {
  const raw = nativeFn('formatVirtualRouterHitJson')(
    JSON.stringify(record),
    config ? JSON.stringify(config) : undefined
  );
  if (typeof raw !== 'string' || !raw) {
    throw new Error('formatVirtualRouterHitJson returned invalid payload');
  }
  return raw;
}

function resolveSessionLogColorKey(metadata: Record<string, unknown>): string | undefined {
  const raw = nativeFn('resolveSessionLogColorKeyJson')(JSON.stringify(metadata ?? null));
  const parsed = parseNativeJson<unknown>('resolveSessionLogColorKeyJson', raw);
  return typeof parsed === 'string' && parsed.trim() ? parsed.trim() : undefined;
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

function emitVirtualRouterHitLog(result: {
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
  const record = createVirtualRouterHitRecord({
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
  const line = formatVirtualRouterHit(record, options?.hitLog);
  const forcedStopStatusLabel = options?.forceStopStatusLabel && !stopState
    ? formatStopMessageStatusLabel(null, options?.stopScope, true)
    : '';
  console.log(forcedStopStatusLabel ? `${line} ${forcedStopStatusLabel}` : line);
}

export function createVirtualRouterRouteHostEffects(args: {
  request: NativeRouterRequest;
  metadata: RouterMetadataInput | Record<string, unknown>;
  hitLog?: VirtualRouterHitLogConfig;
}): VirtualRouterRouteHostEffects {
  const metadata = (args.metadata && typeof args.metadata === 'object' && !Array.isArray(args.metadata)
    ? args.metadata
    : {}) as RouterMetadataInput;
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
      const rt = (metadata as { __rt?: Record<string, unknown> }).__rt;
      if (rt?.disableVirtualRouterHitLog !== true) {
        emitVirtualRouterHitLog(result, {
          requestId: resolveVirtualRouterLogRequestId(metadata),
          sessionId: resolveSessionLogColorKey(metadata as unknown as Record<string, unknown>),
          stopScope,
          stopState,
          forceStopStatusLabel,
          hitLog: args.hitLog
        });
      }
    }
  };
}
