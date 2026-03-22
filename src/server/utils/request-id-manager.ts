import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveRccStateDir } from '../../config/user-data-paths.js';
import { rebindRequestTimingTimeline } from './stage-logger.js';

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

type RequestCounterState = {
  version: 1;
  totalCount: number;
  windowCount: number;
  windowKey: string;
  updatedAt: string;
};

const REQUEST_COMPONENTS = new Map<string, TimedValue<RequestIdComponents>>();
const REQUEST_ALIAS = new Map<string, TimedValue<string>>();
const COMPONENT_TTL_MS = 5 * 60 * 1000;
const COMPONENT_SWEEP_INTERVAL_MS = 30 * 1000;
const REQUEST_COUNTER_STATE_FILE = resolveRequestCounterStateFilePath();
let cleanupTimer: NodeJS.Timeout | null = null;
let requestCounterStateLoaded = false;
let requestCounterState: RequestCounterState = {
  version: 1,
  totalCount: 0,
  windowCount: 0,
  windowKey: resolveNoonWindowKey(),
  updatedAt: new Date(0).toISOString()
};

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
  const seq = nextPersistentSequence();
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

function nextPersistentSequence(now: Date = new Date()): string {
  ensureRequestCounterStateLoaded();
  rolloverDailyWindowIfNeeded(now);
  requestCounterState.totalCount += 1;
  requestCounterState.windowCount += 1;
  requestCounterState.updatedAt = now.toISOString();
  persistRequestCounterState();
  return `${requestCounterState.totalCount}-${requestCounterState.windowCount}`;
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
  rebindRequestTimingTimeline(originalId, aliasId);
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

function resolveRequestCounterStateFilePath(): string {
  const override = String(
    process.env.ROUTECODEX_REQUEST_ID_COUNTER_FILE ||
      process.env.RCC_REQUEST_ID_COUNTER_FILE ||
      ''
  ).trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.resolve(process.cwd(), override);
  }
  if (String(process.env.NODE_ENV || '').trim().toLowerCase() === 'test') {
    return path.join(process.cwd(), 'tmp', 'jest-request-id-counter.json');
  }
  return path.join(resolveRccStateDir(), 'request-id-counter.json');
}

function resolveNoonWindowKey(now: Date = new Date()): string {
  const local = new Date(now.getTime());
  if (local.getHours() < 12) {
    local.setDate(local.getDate() - 1);
  }
  const yyyy = local.getFullYear();
  const mm = String(local.getMonth() + 1).padStart(2, '0');
  const dd = String(local.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

function toSafeNonNegativeInt(value: unknown, fallback = 0): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    return fallback;
  }
  return Math.floor(n);
}

function ensureRequestCounterStateLoaded(): void {
  if (requestCounterStateLoaded) {
    return;
  }
  requestCounterStateLoaded = true;
  try {
    const raw = fs.readFileSync(REQUEST_COUNTER_STATE_FILE, 'utf8').trim();
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw) as Partial<RequestCounterState> | null;
    if (!parsed || typeof parsed !== 'object') {
      return;
    }
    requestCounterState = {
      version: 1,
      totalCount: toSafeNonNegativeInt(parsed.totalCount, 0),
      windowCount: toSafeNonNegativeInt(parsed.windowCount, 0),
      windowKey:
        typeof parsed.windowKey === 'string' && parsed.windowKey.trim()
          ? parsed.windowKey.trim()
          : resolveNoonWindowKey(),
      updatedAt:
        typeof parsed.updatedAt === 'string' && parsed.updatedAt.trim()
          ? parsed.updatedAt
          : new Date(0).toISOString()
    };
  } catch {
    // non-blocking: fall back to fresh in-memory counters
  }
  rolloverDailyWindowIfNeeded(new Date());
}

function rolloverDailyWindowIfNeeded(now: Date): void {
  const currentKey = resolveNoonWindowKey(now);
  if (requestCounterState.windowKey === currentKey) {
    return;
  }
  requestCounterState.windowKey = currentKey;
  requestCounterState.windowCount = 0;
}

function persistRequestCounterState(): void {
  try {
    const dir = path.dirname(REQUEST_COUNTER_STATE_FILE);
    fs.mkdirSync(dir, { recursive: true });
    const tmpFile = `${REQUEST_COUNTER_STATE_FILE}.${process.pid}.tmp`;
    const text = `${JSON.stringify(requestCounterState, null, 2)}\n`;
    fs.writeFileSync(tmpFile, text, 'utf8');
    fs.renameSync(tmpFile, REQUEST_COUNTER_STATE_FILE);
  } catch {
    // non-blocking: request id generation must not fail due to persistence errors
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
  ensureRequestCounterStateLoaded();
  return {
    components: REQUEST_COMPONENTS.size,
    aliases: REQUEST_ALIAS.size,
    // Backward compatible field name: now indicates whether persistent counter state is initialized.
    seqKeys: requestCounterStateLoaded ? 1 : 0
  };
}

export function __unsafeResetRequestIdCounterForTests(
  next?: Partial<Pick<RequestCounterState, 'totalCount' | 'windowCount' | 'windowKey'>>
): void {
  requestCounterStateLoaded = true;
  requestCounterState = {
    version: 1,
    totalCount: toSafeNonNegativeInt(next?.totalCount, 0),
    windowCount: toSafeNonNegativeInt(next?.windowCount, 0),
    windowKey:
      typeof next?.windowKey === 'string' && next.windowKey.trim()
        ? next.windowKey.trim()
        : resolveNoonWindowKey(),
    updatedAt: new Date().toISOString()
  };
  try {
    fs.rmSync(REQUEST_COUNTER_STATE_FILE, { force: true });
  } catch {
    // non-blocking
  }
}
