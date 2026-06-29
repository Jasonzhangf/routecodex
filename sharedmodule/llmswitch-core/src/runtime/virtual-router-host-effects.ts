import type { ProcessedRequest, StandardizedRequest } from '../conversion/hub/types/standardized.js';
import type {
  RouterMetadataInput,
  RoutingDecision,
  StopMessageStateSnapshot,
  TargetMetadata
} from '../native/router-hotpath/virtual-router-contracts.js';
import { resolveRccUserDir } from './user-data-paths.js';
import { parseRoutingInstructionKindsWithNative } from '../native/router-hotpath/native-virtual-router-routing-instructions-semantics.js';
import { parseResolvedStopMessageInstructionWithNative } from '../native/router-hotpath/native-virtual-router-stop-message-semantics.js';
import {
  resolveStopMessageScope,
} from '../native/router-hotpath/native-virtual-router-routing-state.js';
import { formatVirtualRouterHit, createVirtualRouterHitRecord, resolveSessionLogColorKey, type VirtualRouterHitLogConfig } from './virtual-router-hit-log.js';
import type { RoutingInstruction } from '../native/router-hotpath/native-virtual-router-routing-state.js';
import { cleanMarkerSyntaxInPlace, hasMarkerSyntax } from '../conversion/shared/marker-lifecycle.js';

export type VirtualRouterRouteHostEffects = {
  finalize: (
    result: { target: TargetMetadata; decision: RoutingDecision },
    getStopMessageState: (metadata: RouterMetadataInput) => StopMessageStateSnapshot | null
  ) => void;
};

const STOP_MESSAGE_INSTRUCTION_TYPES = new Set(['stopMessageSet', 'stopMessageMode', 'stopMessageClear']);
const STOP_MESSAGE_SCOPED_TYPES = new Set(['stopMessageSet', 'stopMessageMode', 'stopMessageClear', 'preCommandSet', 'preCommandClear']);
const STOP_MESSAGE_KEYWORD_PATTERN = /stopmessage/i;

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
  const messages = Array.isArray((request as { messages?: unknown }).messages)
    ? (((request as { messages?: unknown[] }).messages ?? []) as Array<{ role?: unknown; content?: unknown }>)
    : [];
  const latest = [...messages].reverse().find((message) => message?.role === 'user');
  const latestText = latest ? extractStopMessageText(latest.content).trim() : '';
  const latestHasMarker = hasMarkerSyntax(latestText);
  const hasStopKeyword = STOP_MESSAGE_KEYWORD_PATTERN.test(latestText);
  if (!hasStopKeyword && !latestHasMarker) return null;
  const parsedKinds = parseRoutingInstructionKindsWithNative(request as unknown as Record<string, unknown>);
  const stopMessageTypes = parsedKinds.filter((type) => STOP_MESSAGE_INSTRUCTION_TYPES.has(type));
  const scopedTypes = parsedKinds.filter((type) => STOP_MESSAGE_SCOPED_TYPES.has(type));
  if (!hasStopKeyword && stopMessageTypes.length === 0 && scopedTypes.length === 0) return null;
  return {
    requestId: metadata.requestId || 'n/a',
    markerDetected: latestHasMarker,
    preview: latestText.replace(/\s+/g, ' ').slice(0, 120),
    stopMessageTypes,
    scopedTypes,
    stopScope: resolveStopMessageScope(metadata)
  };
}

export function emitStopMessageMarkerParseLog(log: StopMessageMarkerParseLog | null): void {
  if (!log) return;
  const reset = '\x1b[0m';
  const tagColor = '\x1b[38;5;39m';
  const scopeColor = '\x1b[38;5;220m';
  console.log(
    `${tagColor}[virtual-router][stop_message_parse]${reset} requestId=${log.requestId} marker=${log.markerDetected ? 'detected' : 'missing'} parsed=${log.stopMessageTypes.join(',') || 'none'} preview=${log.preview}`
  );
  if (log.scopedTypes.length > 0) {
    console.log(log.stopScope
      ? `${scopeColor}[virtual-router][stop_scope]${reset} requestId=${log.requestId} stage=apply scope=${log.stopScope} instructions=${log.scopedTypes.join(',')}`
      : `${scopeColor}[virtual-router][stop_scope]${reset} requestId=${log.requestId} stage=drop reason=missing_session_scope instructions=${log.scopedTypes.join(',')}`);
  }
}

export function cleanStopMessageMarkersInPlace(request: Record<string, unknown>): void {
  cleanMarkerSyntaxInPlace(request);
}

export function formatStopMessageStatusLabel(
  snapshot: StopMessageStateSnapshot | null,
  scope: string | undefined,
  forceShow: boolean
): string {
  const scopeLabel = scope && scope.trim() ? scope.trim() : 'none';
  if (!snapshot) return forceShow ? `[stopMessage:scope=${scopeLabel} active=no state=cleared]` : '';
  const text = typeof snapshot.stopMessageText === 'string' ? snapshot.stopMessageText.trim() : '';
  const safeText = text ? (text.length > 24 ? `${text.slice(0, 21)}...` : text) : '(mode-only)';
  const mode = (snapshot.stopMessageStageMode || 'unset').toString().toLowerCase();
  const maxRepeats = typeof snapshot.stopMessageMaxRepeats === 'number' && Number.isFinite(snapshot.stopMessageMaxRepeats)
    ? Math.max(0, Math.floor(snapshot.stopMessageMaxRepeats))
    : 0;
  const used = typeof snapshot.stopMessageUsed === 'number' && Number.isFinite(snapshot.stopMessageUsed)
    ? Math.max(0, Math.floor(snapshot.stopMessageUsed))
    : 0;
  const remaining = maxRepeats > 0 ? Math.max(0, maxRepeats - used) : -1;
  const active = mode !== 'off' && Boolean(text) && maxRepeats > 0;
  return `[stopMessage:scope=${scopeLabel} text="${safeText}" mode=${mode} round=${maxRepeats > 0 ? `${used}/${maxRepeats}` : `${used}/-`} left=${remaining >= 0 ? String(remaining) : 'n/a'} active=${active ? 'yes' : 'no'}]`;
}

function extractStopMessageText(content: unknown): string {
  if (typeof content === 'string' && content.trim()) return content;
  if (!Array.isArray(content)) return '';
  const parts = content.flatMap((entry) => {
    if (typeof entry === 'string' && entry.trim()) return [entry];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as { text?: unknown; content?: unknown };
    if (typeof record.text === 'string' && record.text.trim()) return [record.text];
    if (typeof record.content === 'string' && record.content.trim()) return [record.content];
    return [];
  });
  return parts.join('\n').trim();
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
