import {
  DEFAULT_MODEL_CONTEXT_TOKENS,
  DEFAULT_ROUTE,
  type ClassificationResult,
  type ProviderProfile,
  type RoutingFeatures,
  type RoutingInstructionMode,
  type VirtualRouterContextRoutingConfig
} from '../native/router-hotpath/virtual-router-contracts.js';
import type { RoutingInstructionState } from '../native/router-hotpath/native-virtual-router-routing-state.js';
import type { VirtualRouterHitEvent } from '../telemetry/stats-center.js';

const DEFAULT_STOP_MESSAGE_MAX_REPEATS = 10;

type StopMessageRoutingStateView = Pick<
  RoutingInstructionState,
  | 'stopMessageText'
  | 'stopMessageMaxRepeats'
  | 'stopMessageUsed'
  | 'stopMessageUpdatedAt'
  | 'stopMessageLastUsedAt'
  | 'stopMessageStageMode'
>;

type LoggingDeps = {
  providers: Record<string, ProviderProfile>;
  contextRouting: VirtualRouterContextRoutingConfig | undefined;
};

export type StopMessageRuntimeSummary = {
  hasAny: boolean;
  safeText?: string;
  mode: 'on' | 'off' | 'auto' | 'unset';
  maxRepeats: number;
  used: number;
  remaining: number;
  active: boolean;
  updatedAt?: number;
  lastUsedAt?: number;
};

export type VirtualRouterHitRecord = {
  timestampMs: number;
  requestId?: string;
  sessionId?: string;
  routeName: string;
  poolId?: string;
  providerKey: string;
  modelId?: string;
  hitReason?: string;
  continuationScope?: string;
  requestTokens?: number;
  selectionPenalty?: number;
  stopMessage: StopMessageRuntimeSummary;
};

export type VirtualRouterHitEventMeta = {
  requestId: string;
  entryEndpoint?: string;
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

const HIT_LOG_OMIT_FIELDS = new Set<VirtualRouterHitLogOmitField>([
  'requestId',
  'sessionId',
  'model',
  'reason',
  'continuation',
  'requestTokens',
  'selectionPenalty',
  'stopMessage'
]);

function normalizeHitLogOmit(config?: VirtualRouterHitLogConfig): Set<VirtualRouterHitLogOmitField> {
  const out = new Set<VirtualRouterHitLogOmitField>();
  const raw = Array.isArray(config?.omit) ? config.omit : [];
  for (const field of raw) {
    if (HIT_LOG_OMIT_FIELDS.has(field)) {
      out.add(field);
    }
  }
  return out;
}

function summarizeStopMessageRuntime(state?: StopMessageRoutingStateView): StopMessageRuntimeSummary {
  if (!state) {
    return {
      hasAny: false,
      mode: 'unset',
      maxRepeats: 0,
      used: 0,
      remaining: -1,
      active: false
    };
  }
  const text = typeof state.stopMessageText === 'string' ? state.stopMessageText.trim() : '';
  const safeText = text ? (text.length > 24 ? `${text.slice(0, 21)}…` : text) : undefined;
  const modeRaw = typeof state.stopMessageStageMode === 'string' ? state.stopMessageStageMode.trim().toLowerCase() : '';
  const mode = modeRaw === 'on' || modeRaw === 'off' || modeRaw === 'auto' ? (modeRaw as 'on' | 'off' | 'auto') : 'unset';
  const parsedMaxRepeats =
    typeof state.stopMessageMaxRepeats === 'number' && Number.isFinite(state.stopMessageMaxRepeats)
      ? Math.max(0, Math.floor(state.stopMessageMaxRepeats))
      : 0;
  const hasGoalText = Boolean(text);
  const maxRepeats =
    parsedMaxRepeats > 0
      ? parsedMaxRepeats
      : hasGoalText && (mode === 'on' || mode === 'auto')
        ? DEFAULT_STOP_MESSAGE_MAX_REPEATS
        : 0;
  const used =
    typeof state.stopMessageUsed === 'number' && Number.isFinite(state.stopMessageUsed)
      ? Math.max(0, Math.floor(state.stopMessageUsed))
      : 0;
  const remaining = maxRepeats > 0 ? Math.max(0, maxRepeats - used) : -1;
  const active = mode !== 'off' && hasGoalText && maxRepeats > 0;
  const updatedAt =
    typeof state.stopMessageUpdatedAt === 'number' && Number.isFinite(state.stopMessageUpdatedAt)
      ? state.stopMessageUpdatedAt
      : undefined;
  const lastUsedAt =
    typeof state.stopMessageLastUsedAt === 'number' && Number.isFinite(state.stopMessageLastUsedAt)
      ? state.stopMessageLastUsedAt
      : undefined;
  const hasAny = hasGoalText || maxRepeats > 0 || used > 0;
  return {
    hasAny,
    ...(safeText ? { safeText } : {}),
    mode,
    maxRepeats,
    used,
    remaining,
    active,
    ...(updatedAt ? { updatedAt } : {}),
    ...(lastUsedAt ? { lastUsedAt } : {})
  };
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

function normalizeRoundedInteger(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.round(value));
}

export function createVirtualRouterHitRecord(input: {
  requestId?: string;
  sessionId?: string;
  routeName: string;
  poolId?: string;
  providerKey: string;
  modelId?: string;
  hitReason?: string;
  continuationScope?: string;
  routingState?: StopMessageRoutingStateView;
  requestTokens?: number;
  selectionPenalty?: number;
  timestampMs?: number;
}): VirtualRouterHitRecord {
  return {
    timestampMs:
      typeof input.timestampMs === 'number' && Number.isFinite(input.timestampMs)
        ? input.timestampMs
        : Date.now(),
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    routeName: input.routeName,
    ...(input.poolId ? { poolId: input.poolId } : {}),
    providerKey: input.providerKey,
    ...(input.modelId ? { modelId: input.modelId } : {}),
    ...(input.hitReason ? { hitReason: input.hitReason } : {}),
    ...(input.continuationScope ? { continuationScope: input.continuationScope } : {}),
    ...(typeof normalizeRoundedInteger(input.requestTokens) === 'number'
      ? { requestTokens: normalizeRoundedInteger(input.requestTokens) }
      : {}),
    ...(typeof normalizePositiveInteger(input.selectionPenalty) === 'number'
      ? { selectionPenalty: normalizePositiveInteger(input.selectionPenalty) }
      : {}),
    stopMessage: summarizeStopMessageRuntime(input.routingState)
  };
}

export function toVirtualRouterHitEvent(
  record: VirtualRouterHitRecord,
  meta: VirtualRouterHitEventMeta
): VirtualRouterHitEvent {
  return {
    requestId: meta.requestId,
    timestamp: record.timestampMs,
    entryEndpoint: meta.entryEndpoint || '/v1/chat/completions',
    routeName: record.routeName,
    pool: record.poolId || record.routeName,
    providerKey: record.providerKey,
    ...(record.modelId ? { modelId: record.modelId } : {}),
    ...(record.hitReason ? { reason: record.hitReason } : {}),
    ...(typeof record.requestTokens === 'number' ? { requestTokens: record.requestTokens } : {}),
    ...(typeof record.selectionPenalty === 'number' ? { selectionPenalty: record.selectionPenalty } : {}),
    stopMessageActive: record.stopMessage.active,
    ...(record.stopMessage.mode !== 'unset' ? { stopMessageMode: record.stopMessage.mode } : {}),
    ...(record.stopMessage.remaining >= 0 ? { stopMessageRemaining: record.stopMessage.remaining } : {})
  };
}

export function formatContinuationScope(scope?: string): string | undefined {
  if (!scope || scope.trim().length === 0) {
    return undefined;
  }
  const normalized = scope.trim();
  const maxLength = 20;
  if (normalized.length <= maxLength) {
    return normalized;
  }
  const delimiterIndex = normalized.indexOf(':');
  const prefix = delimiterIndex > 0 ? normalized.slice(0, delimiterIndex + 1) : '';
  const body = delimiterIndex > 0 ? normalized.slice(delimiterIndex + 1) : normalized;
  if (body.length <= 8) {
    return `${prefix}${body}`;
  }
  return `${prefix}${body.slice(0, 4)}…${body.slice(-4)}`;
}

export function parseProviderKey(
  providerKey: string
): { providerId: string; keyAlias?: string; modelId?: string } | null {
  const trimmed = typeof providerKey === 'string' ? providerKey.trim() : '';
  if (!trimmed) {
    return null;
  }
  const parts = trimmed.split('.');
  if (parts.length < 2) {
    return { providerId: trimmed };
  }
  if (parts.length === 2) {
    return { providerId: parts[0], modelId: parts[1] };
  }
  return {
    providerId: parts[0],
    keyAlias: parts[1],
    modelId: parts.slice(2).join('.')
  };
}

export function describeTargetProvider(
  providerKey: string,
  fallbackModelId?: string
): { providerLabel: string; resolvedModel?: string } {
  const parsed = parseProviderKey(providerKey);
  if (!parsed) {
    return { providerLabel: providerKey, resolvedModel: fallbackModelId };
  }
  const aliasLabel = parsed.keyAlias ? `${parsed.providerId}[${parsed.keyAlias}]` : parsed.providerId;
  const resolvedModel = parsed.modelId || fallbackModelId;
  return { providerLabel: aliasLabel, resolvedModel };
}

export function resolveRouteColor(routeName: string): string {
  const map: Record<string, string> = {
    multimodal: '\x1b[38;5;45m',
    tools: '\x1b[38;5;214m',
    thinking: '\x1b[34m',
    coding: '\x1b[35m',
    longcontext: '\x1b[38;5;141m',
    web_search: '\x1b[32m',
    search: '\x1b[38;5;34m',
    background: '\x1b[90m'
  };
  return map[routeName] ?? '\x1b[36m';
}

export const SESSION_LOG_COLOR_PALETTE = [
  '\x1b[32m',
  '\x1b[33m',
  '\x1b[34m',
  '\x1b[35m',
  '\x1b[36m',
  '\x1b[92m',
  '\x1b[93m',
  '\x1b[94m',
  '\x1b[95m',
  '\x1b[96m',
  '\x1b[38;5;202m',
  '\x1b[38;5;208m',
  '\x1b[38;5;214m',
  '\x1b[38;5;220m',
  '\x1b[38;5;45m',
  '\x1b[38;5;51m',
  '\x1b[38;5;39m',
  '\x1b[38;5;75m',
  '\x1b[38;5;141m',
  '\x1b[38;5;177m',
  '\x1b[38;5;171m',
  '\x1b[38;5;207m',
  '\x1b[38;5;27m',
  '\x1b[38;5;33m',
  '\x1b[38;5;57m',
  '\x1b[38;5;63m',
  '\x1b[38;5;69m',
  '\x1b[38;5;81m',
  '\x1b[38;5;82m',
  '\x1b[38;5;83m',
  '\x1b[38;5;84m',
  '\x1b[38;5;85m',
  '\x1b[38;5;86m',
  '\x1b[38;5;87m',
  '\x1b[38;5;99m',
  '\x1b[38;5;105m',
  '\x1b[38;5;111m',
  '\x1b[38;5;117m',
  '\x1b[38;5;118m',
  '\x1b[38;5;119m',
  '\x1b[38;5;120m',
  '\x1b[38;5;121m',
  '\x1b[38;5;122m',
  '\x1b[38;5;123m',
  '\x1b[38;5;129m',
  '\x1b[38;5;135m',
  '\x1b[38;5;147m',
  '\x1b[38;5;153m',
  '\x1b[38;5;154m',
  '\x1b[38;5;155m',
  '\x1b[38;5;156m',
  '\x1b[38;5;157m',
  '\x1b[38;5;158m',
  '\x1b[38;5;159m',
  '\x1b[38;5;165m',
  '\x1b[38;5;183m'
] as const;
const SESSION_LOG_COLOR_ASSIGNMENTS = new Map<string, string>();
const SESSION_LOG_COLOR_USAGE = new Map<string, string>();

export function hashSessionLogColorToken(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d) >>> 0;
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b) >>> 0;
  hash ^= hash >>> 16;
  return hash >>> 0;
}

export function resolveSessionLogColorKey(input?: Record<string, unknown> | null): string | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }
  const candidates = [
    input.logSessionColorKey,
    input.sessionId,
    input.session_id,
    input.conversationId,
    input.conversation_id,
    input.clientTmuxSessionId,
    input.client_tmux_session_id,
    input.tmuxSessionId,
    input.tmux_session_id,
    input.rccSessionClientTmuxSessionId,
    input.rcc_session_client_tmux_session_id
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function resolveSessionColor(sessionId?: string): string | undefined {
  const normalized = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!normalized) {
    return undefined;
  }
  const assigned = SESSION_LOG_COLOR_ASSIGNMENTS.get(normalized);
  if (assigned) {
    return assigned;
  }
  const hash = hashSessionLogColorToken(normalized);
  const startIndex = hash % SESSION_LOG_COLOR_PALETTE.length;
  for (let offset = 0; offset < SESSION_LOG_COLOR_PALETTE.length; offset += 1) {
    const color = SESSION_LOG_COLOR_PALETTE[(startIndex + offset) % SESSION_LOG_COLOR_PALETTE.length];
    if (!SESSION_LOG_COLOR_USAGE.has(color)) {
      SESSION_LOG_COLOR_ASSIGNMENTS.set(normalized, color);
      SESSION_LOG_COLOR_USAGE.set(color, normalized);
      return color;
    }
  }
  const color = SESSION_LOG_COLOR_PALETTE[startIndex];
  SESSION_LOG_COLOR_ASSIGNMENTS.set(normalized, color);
  return color;
}

function describeContextUsage(
  providerKey: string,
  estimatedTokens: number | undefined,
  deps: LoggingDeps
): string | undefined {
  if (typeof estimatedTokens !== 'number' || !Number.isFinite(estimatedTokens) || estimatedTokens <= 0) {
    return undefined;
  }
  let limit = DEFAULT_MODEL_CONTEXT_TOKENS;
  const profile = deps.providers[providerKey];
  if (profile?.maxContextTokens && Number.isFinite(profile.maxContextTokens)) {
    limit = profile.maxContextTokens;
  }
  if (!limit || limit <= 0) {
    return undefined;
  }
  const ratio = estimatedTokens / limit;
  const threshold = deps.contextRouting?.warnRatio ?? 0.9;
  if (ratio < threshold) {
    return undefined;
  }
  return `${ratio.toFixed(2)}/${Math.round(limit)}`;
}

function decorateWithDetail(baseLabel: string, primaryReason: string, detail?: string): string {
  const normalizedDetail = detail && detail.trim();
  if (!normalizedDetail) {
    return primaryReason || baseLabel;
  }
  if (primaryReason) {
    return `${primaryReason}(${normalizedDetail})`;
  }
  return `${baseLabel}(${normalizedDetail})`;
}

export function buildHitReason(
  routeUsed: string,
  providerKey: string,
  classification: ClassificationResult,
  features: RoutingFeatures,
  mode: RoutingInstructionMode | undefined,
  deps: LoggingDeps
): string {
  const reasoning = classification.reasoning || '';
  const primary = reasoning.split('|')[0] || '';
  const commandDetail = features.lastAssistantToolLabel;
  void mode;
  const base = (() => {
    if (routeUsed === 'tools') {
      const label = 'tools';
      return decorateWithDetail(primary || label, primary, commandDetail);
    }

    if (routeUsed === 'thinking') {
      const label = 'thinking';
      return decorateWithDetail(primary || label, primary, commandDetail);
    }

    if (routeUsed === 'coding') {
      const label = 'coding';
      return decorateWithDetail(primary || label, primary, commandDetail);
    }

    if (routeUsed === 'web_search' || routeUsed === 'search') {
      return decorateWithDetail(primary || routeUsed, primary, commandDetail);
    }

    if (routeUsed === DEFAULT_ROUTE && classification.routeChanged) {
      return primary || 'default:route-selected';
    }

    if (primary) {
      return primary;
    }

    return routeUsed ? `route:${routeUsed}` : 'route:unknown';
  })();

  const contextDetail = describeContextUsage(providerKey, features.estimatedTokens, deps);
  if (contextDetail) {
    return `${base}|context:${contextDetail}`;
  }
  return base;
}

export function formatVirtualRouterHit(record: VirtualRouterHitRecord, config?: VirtualRouterHitLogConfig): string {
  const omit = normalizeHitLogOmit(config);
  try {
    const now = new Date(record.timestampMs);
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const timestamp = `${hours}:${minutes}:${seconds}`;

    const reset = '\x1b[0m';
    const timeColor = '\x1b[90m';
    const continuationColor = '\x1b[33m';
    const stopColor = '\x1b[38;5;214m';
    const timeLabel = `${timeColor}${timestamp}${reset}`;
    const { providerLabel, resolvedModel } = describeTargetProvider(record.providerKey, record.modelId);
    const routeLabel = record.poolId ? `${record.routeName}/${record.poolId}` : record.routeName;
    const targetLabel = `${routeLabel} -> ${providerLabel}${resolvedModel && !omit.has('model') ? '.' + resolvedModel : ''}`;
    const requestId = typeof record.requestId === 'string' ? record.requestId : '';
    const requestLabel = !omit.has('requestId') && requestId && !requestId.includes('unknown') ? ` req=${requestId}` : '';
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : '';
    const sessionLabel = !omit.has('sessionId') && sessionId ? ` sid=${sessionId}` : '';
    const routeColor = resolveSessionColor(sessionId) || resolveRouteColor(record.routeName);
    const prefix = `${routeColor}[virtual-router-hit]${reset}`;
    const continuationText = formatContinuationScope(record.continuationScope);
    const continuationLabel = !omit.has('continuation') && continuationText ? ` ${continuationColor}[continuation:${continuationText}]${reset}` : '';
    const reasonLabel = !omit.has('reason') && record.hitReason ? ` reason=${record.hitReason}` : '';
    const requestTokenLabel =
      !omit.has('requestTokens') && typeof record.requestTokens === 'number' && Number.isFinite(record.requestTokens)
        ? ` reqTokens=${Math.max(0, Math.round(record.requestTokens))}`
        : '';
    const penaltyLabel =
      !omit.has('selectionPenalty') && typeof record.selectionPenalty === 'number' && Number.isFinite(record.selectionPenalty) && record.selectionPenalty > 0
        ? ` penalty=${Math.floor(record.selectionPenalty)}`
        : '';
    let stopLabel = '';
    const stop = record.stopMessage;
    if (!omit.has('stopMessage') && stop.hasAny) {
      const parts: string[] = [
        stop.safeText ? `"${stop.safeText}"` : '"(mode-only)"',
        `mode=${stop.mode}`,
        `round=${stop.maxRepeats > 0 ? `${stop.used}/${stop.maxRepeats}` : `${stop.used}/-`}`,
        `active=${stop.active ? 'yes' : 'no'}`,
        `left=${stop.remaining >= 0 ? stop.remaining : 'n/a'}`
      ];
      if (stop.updatedAt) {
        parts.push(`set=${new Date(stop.updatedAt).toLocaleString(undefined, { hour12: false })}`);
      }
      if (stop.lastUsedAt) {
        parts.push(`last=${new Date(stop.lastUsedAt).toLocaleString(undefined, { hour12: false })}`);
      }
      stopLabel = ` ${stopColor}[stopMessage:${parts.join(' ')}]${reset}`;
    }
    return `${prefix} ${timeLabel}${requestLabel}${sessionLabel} ${routeColor}${targetLabel}${continuationLabel}${reasonLabel}${requestTokenLabel}${penaltyLabel}${stopLabel}${reset}`;
  } catch {
    const now = new Date(record.timestampMs);
    const timestamp = now.toLocaleTimeString('zh-CN', { hour12: false });
    const routeLabel = record.poolId ? `${record.routeName}/${record.poolId}` : record.routeName;
    const continuationText = formatContinuationScope(record.continuationScope);
    const continuationLabel = !omit.has('continuation') && continuationText ? ` [continuation:${continuationText}]` : '';
    const requestId = typeof record.requestId === 'string' ? record.requestId : '';
    const requestLabel = !omit.has('requestId') && requestId && !requestId.includes('unknown') ? ` req=${requestId}` : '';
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : '';
    const sessionLabel = !omit.has('sessionId') && sessionId ? ` sid=${sessionId}` : '';
    const requestTokenLabel =
      !omit.has('requestTokens') && typeof record.requestTokens === 'number' && Number.isFinite(record.requestTokens)
        ? ` reqTokens=${Math.max(0, Math.round(record.requestTokens))}`
        : '';
    const penaltyLabel =
      !omit.has('selectionPenalty') && typeof record.selectionPenalty === 'number' && Number.isFinite(record.selectionPenalty) && record.selectionPenalty > 0
        ? ` penalty=${Math.floor(record.selectionPenalty)}`
        : '';
    let stopLabel = '';
    const stop = record.stopMessage;
    if (!omit.has('stopMessage') && stop.hasAny) {
      const safeText = stop.safeText ? `"${stop.safeText}"` : '"(mode-only)"';
      const rounds = stop.maxRepeats > 0 ? `${stop.used}/${stop.maxRepeats}` : `${stop.used}/-`;
      const left = stop.remaining >= 0 ? String(stop.remaining) : 'n/a';
      stopLabel = ` [stopMessage:${safeText} mode=${stop.mode} round=${rounds} active=${stop.active ? 'yes' : 'no'} left=${left}]`;
    }
    return `[virtual-router-hit] ${timestamp}${requestLabel}${sessionLabel} ${routeLabel} -> ${record.providerKey}${record.modelId && !omit.has('model') ? '.' + record.modelId : ''}${continuationLabel}${!omit.has('reason') && record.hitReason ? ` reason=${record.hitReason}` : ''}${requestTokenLabel}${penaltyLabel}${stopLabel}`;
  }
}
