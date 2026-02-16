import crypto from 'node:crypto';

interface RequestIdMeta {
  entryEndpoint?: string;
  providerId?: string;
  model?: string;
}

interface RequestIdentifiers {
  clientRequestId: string;
  providerRequestId: string;
}

type RequestIdComponents = {
  entry: string;
  providerId: string;
  model: string;
  timestamp: string;
  sequence: string;
};

type TimedValue<T> = {
  value: T;
  expiresAtMs: number;
};

// const CLIENT_SEQ_MAP = new Map<string, number>();
const PROVIDER_SEQ_MAP = new Map<string, number>();
const REQUEST_COMPONENTS = new Map<string, TimedValue<RequestIdComponents>>();
const REQUEST_ALIAS = new Map<string, TimedValue<string>>();
const COMPONENT_TTL_MS = 5 * 60 * 1000;
const COMPONENT_SWEEP_INTERVAL_MS = 30 * 1000;
const PROVIDER_SEQ_MAX_KEYS = resolvePositiveIntFromEnv(
  process.env.ROUTECODEX_REQUEST_ID_SEQ_MAX_KEYS,
  process.env.RCC_REQUEST_ID_SEQ_MAX_KEYS,
  2048
);
let cleanupTimer: NodeJS.Timeout | null = null;

export function generateRequestIdentifiers(candidate?: unknown, meta?: RequestIdMeta): RequestIdentifiers {
  const clientRequestId = normalizeClientRequestId(candidate);
  const providerRequestId = buildProviderRequestId(meta);
  return { clientRequestId, providerRequestId };
}

function normalizeClientRequestId(candidate?: unknown): string {
  if (typeof candidate === 'string' && candidate.trim()) {
    return candidate.trim();
  }
  if (Array.isArray(candidate) && candidate[0]) {
    return String(candidate[0]);
  }
  return `req_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function buildProviderRequestId(meta?: RequestIdMeta): string {
  const entry = sanitizeEntry(meta?.entryEndpoint);
  const providerId = sanitizeToken(meta?.providerId);
  const model = sanitizeToken(meta?.model);
  const ts = buildTimestamp();
  const seqKey = `${entry}-${providerId}-${model}`;
  const seq = nextSequence(seqKey, PROVIDER_SEQ_MAP);
  const requestId = `${entry}-${providerId}-${model}-${ts}-${seq}`;
  storeRequestComponents(requestId, { entry, providerId, model, timestamp: ts, sequence: seq });
  return requestId;
}

export function enhanceProviderRequestId(
  currentId: string,
  meta?: { providerId?: string; model?: string; entryEndpoint?: string }
): string {
  if (!currentId || !meta) {
    return currentId;
  }
  const { baseId, suffix } = splitRequestId(currentId);
  const components = getRequestComponents(baseId);
  if (!components) {
    return currentId;
  }
  const providerId = meta.providerId ? sanitizeToken(meta.providerId) : components.providerId;
  const model = meta.model ? sanitizeToken(meta.model) : components.model;
  if (providerId === components.providerId && model === components.model) {
    return currentId;
  }
  const nextBaseId = `${components.entry}-${providerId}-${model}-${components.timestamp}-${components.sequence}`;
  storeRequestComponents(nextBaseId, {
    entry: components.entry,
    providerId,
    model,
    timestamp: components.timestamp,
    sequence: components.sequence
  });
  const nextId = suffix ? `${nextBaseId}${suffix}` : nextBaseId;
  registerAlias(currentId, nextId);
  if (baseId !== nextBaseId) {
    registerAlias(baseId, nextBaseId);
  }
  return nextId;
}

export function resolveEffectiveRequestId(requestId?: string): string {
  let current = typeof requestId === 'string' && requestId.trim() ? requestId.trim() : 'unknown';
  const visited = new Set<string>();
  while (!visited.has(current)) {
    visited.add(current);
    const alias = getAlias(current);
    if (!alias) {
      break;
    }
    current = alias;
  }
  return current;
}

function sanitizeEntry(endpoint?: string): string {
  const raw = typeof endpoint === 'string' ? endpoint.toLowerCase() : '';
  if (raw.includes('/v1/responses')) {return 'openai-responses';}
  if (raw.includes('/v1/messages') || raw.includes('/anthropic')) {return 'anthropic-messages';}
  return 'openai-chat';
}

function sanitizeToken(value?: string): string {
  if (!value || typeof value !== 'string') {return 'unknown';}
  const trimmed = value.trim();
  if (!trimmed) {return 'unknown';}
  const sanitized = trimmed.replace(/[^a-zA-Z0-9_.-]/g, '').replace(/^[^a-zA-Z]/, '');
  return sanitized || 'unknown';
}

function buildTimestamp(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${yyyy}${mm}${dd}T${hh}${mi}${ss}${ms}`;
}

function nextSequence(key: string, map: Map<string, number>): string {
  const current = map.get(key) || 0;
  const next = current + 1;
  map.set(key, next);
  pruneOldestEntries(map, PROVIDER_SEQ_MAX_KEYS);
  return String(next).padStart(3, '0');
}

function storeRequestComponents(id: string, components: RequestIdComponents): void {
  REQUEST_COMPONENTS.set(id, {
    value: components,
    expiresAtMs: Date.now() + COMPONENT_TTL_MS
  });
  ensureCleanupTimer();
}

function registerAlias(originalId: string, aliasId: string): void {
  if (!originalId || originalId === aliasId) {
    return;
  }
  REQUEST_ALIAS.set(originalId, {
    value: aliasId,
    expiresAtMs: Date.now() + COMPONENT_TTL_MS
  });
  ensureCleanupTimer();
}

function splitRequestId(requestId: string): { baseId: string; suffix: string } {
  if (typeof requestId !== 'string' || !requestId) {
    return { baseId: '', suffix: '' };
  }
  const delimiterIndex = requestId.indexOf(':');
  if (delimiterIndex === -1) {
    return { baseId: requestId, suffix: '' };
  }
  return {
    baseId: requestId.slice(0, delimiterIndex),
    suffix: requestId.slice(delimiterIndex)
  };
}

function resolvePositiveIntFromEnv(primary: string | undefined, secondary: string | undefined, fallback: number): number {
  const values = [primary, secondary];
  for (const candidate of values) {
    const parsed = Number(String(candidate || '').trim());
    if (Number.isFinite(parsed) && parsed >= 1) {
      return Math.floor(parsed);
    }
  }
  return fallback;
}

function pruneOldestEntries<T>(map: Map<string, T>, maxSize: number): void {
  if (!Number.isFinite(maxSize) || maxSize < 1) {
    return;
  }
  while (map.size > maxSize) {
    const oldestKey = map.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    map.delete(oldestKey);
  }
}

function getRequestComponents(id: string): RequestIdComponents | undefined {
  const record = REQUEST_COMPONENTS.get(id);
  if (!record) {
    return undefined;
  }
  if (record.expiresAtMs <= Date.now()) {
    REQUEST_COMPONENTS.delete(id);
    maybeStopCleanupTimer();
    return undefined;
  }
  return record.value;
}

function getAlias(id: string): string | undefined {
  const record = REQUEST_ALIAS.get(id);
  if (!record) {
    return undefined;
  }
  if (record.expiresAtMs <= Date.now()) {
    REQUEST_ALIAS.delete(id);
    maybeStopCleanupTimer();
    return undefined;
  }
  return record.value;
}

function sweepExpiredEntries(nowMs = Date.now()): void {
  for (const [key, value] of REQUEST_COMPONENTS.entries()) {
    if (value.expiresAtMs <= nowMs) {
      REQUEST_COMPONENTS.delete(key);
    }
  }
  for (const [key, value] of REQUEST_ALIAS.entries()) {
    if (value.expiresAtMs <= nowMs) {
      REQUEST_ALIAS.delete(key);
    }
  }
  maybeStopCleanupTimer();
}

function ensureCleanupTimer(): void {
  if (cleanupTimer) {
    return;
  }
  cleanupTimer = setInterval(() => {
    sweepExpiredEntries();
  }, COMPONENT_SWEEP_INTERVAL_MS);
  cleanupTimer.unref?.();
}

function maybeStopCleanupTimer(): void {
  if (!cleanupTimer) {
    return;
  }
  if (REQUEST_COMPONENTS.size || REQUEST_ALIAS.size) {
    return;
  }
  clearInterval(cleanupTimer);
  cleanupTimer = null;
}

export function __unsafeSweepRequestIdCaches(nowMs = Date.now()): void {
  sweepExpiredEntries(nowMs);
}

export function __unsafeRequestIdCacheSize(): { components: number; aliases: number; seqKeys: number } {
  return {
    components: REQUEST_COMPONENTS.size,
    aliases: REQUEST_ALIAS.size,
    seqKeys: PROVIDER_SEQ_MAP.size
  };
}
