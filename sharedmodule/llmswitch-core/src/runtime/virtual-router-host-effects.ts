import type { ProcessedRequest, StandardizedRequest } from '../conversion/hub/types/standardized.js';
import type {
  RouterMetadataInput,
  RoutingDecision,
  StopMessageStateSnapshot,
  TargetMetadata
} from '../native/router-hotpath/native-virtual-router-runtime.js';
import { resolveRccUserDir } from './user-data-paths.js';
import { parseRoutingInstructionKindsWithNative } from '../native/router-hotpath/native-virtual-router-routing-instructions-semantics.js';
import { parseResolvedStopMessageInstructionWithNative } from '../native/router-hotpath/native-virtual-router-stop-message-semantics.js';
import {
  resolveStopMessageScope,
} from '../native/router-hotpath/native-virtual-router-routing-state.js';
import { formatVirtualRouterHit, createVirtualRouterHitRecord, resolveSessionLogColorKey, type VirtualRouterHitLogConfig } from './virtual-router-hit-log.js';
import type { RoutingInstruction } from '../native/router-hotpath/native-virtual-router-routing-state.js';
import { failNativeRequired } from '../native/router-hotpath/native-router-hotpath-policy.js';
import {
  parseRecord,
  readNativeFunction,
  safeStringify
} from '../native/router-hotpath/native-shared-conversion-semantics-core.js';

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
  request: StandardizedRequest | ProcessedRequest,
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
  request: StandardizedRequest | ProcessedRequest | Record<string, unknown>;
  metadata: RouterMetadataInput | Record<string, unknown>;
  hitLog?: VirtualRouterHitLogConfig;
}): VirtualRouterRouteHostEffects {
  const metadata = coerceRouterMetadata(args.metadata);
  const parseLog = buildStopMessageMarkerParseLog(args.request as StandardizedRequest | ProcessedRequest, metadata);
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
  return resolveSessionLogColorKey(metadata as unknown as Record<string, unknown>);
}
