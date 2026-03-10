import type { ProviderErrorEvent, ProviderSuccessEvent, ProviderQuotaView, ProviderQuotaViewEntry } from '../router/virtual-router/types.js';
import { computeNextDailyResetAtMs } from './apikey-reset.js';
import { applyErrorEvent, applySuccessEvent, createInitialQuotaState, tickQuotaStateTime } from './quota-state.js';
import type { ErrorEventForQuota, QuotaState, QuotaStore, StaticQuotaConfig, SuccessEventForQuota } from './types.js';

function safeTrim(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readEnvDurationMs(envKey: string, fallbackMs: number): number {
  const raw = String(process.env[envKey] ?? '').trim();
  if (!raw) return fallbackMs;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallbackMs;
  return Math.floor(n);
}

const ANTIGRAVITY_AUTH_VERIFY_BAN_MS = readEnvDurationMs('ROUTECODEX_ANTIGRAVITY_AUTH_VERIFY_BAN', 24 * 60 * 60_000);
const ANTIGRAVITY_THOUGHT_SIGNATURE_MISSING_COOLDOWN_MS = readEnvDurationMs(
  'ROUTECODEX_ANTIGRAVITY_THOUGHT_SIGNATURE_MISSING_COOLDOWN',
  5 * 60_000
);

function parseProviderKey(ev: { providerKey?: unknown } | null | undefined): string {
  const key = safeTrim(ev?.providerKey);
  return key;
}

function parseHttpStatus(ev: ProviderErrorEvent): number | null {
  const status = (ev as any)?.status;
  if (typeof status === 'number' && Number.isFinite(status)) {
    return status;
  }
  const runtime = (ev as any)?.runtime;
  const maybe = runtime && typeof runtime === 'object' ? (runtime as any).status : null;
  if (typeof maybe === 'number' && Number.isFinite(maybe)) {
    return maybe;
  }
  return null;
}

function extractResetAtIso(details: Record<string, unknown> | undefined): string | null {
  if (!details || typeof details !== 'object') {
    return null;
  }
  const v = (details as any).resetAt;
  const raw = typeof v === 'string' ? v.trim() : '';
  if (raw) {
    return raw;
  }
  const meta = (details as any).meta && typeof (details as any).meta === 'object' && !Array.isArray((details as any).meta)
    ? (details as any).meta
    : null;
  const metaResetAt = meta && typeof meta.resetAt === 'string' ? String(meta.resetAt).trim() : '';
  if (metaResetAt) {
    return metaResetAt;
  }
  return null;
}

function extractResetAtIsoFromText(text: string): string | null {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (!raw) {
    return null;
  }

  // Try to parse an embedded JSON payload (common in provider error messages).
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const jsonCandidate = raw.slice(firstBrace, lastBrace + 1);
    try {
      const parsed = JSON.parse(jsonCandidate) as any;
      const direct = parsed && typeof parsed.resetAt === 'string' ? String(parsed.resetAt).trim() : '';
      if (direct) {
        return direct;
      }
      const nested = parsed && parsed.error && typeof parsed.error === 'object' ? parsed.error : null;
      const nestedResetAt = nested && typeof (nested as any).resetAt === 'string' ? String((nested as any).resetAt).trim() : '';
      if (nestedResetAt) {
        return nestedResetAt;
      }
    } catch {
      // ignore JSON parse failures; fall back to regex matching
    }
  }

  const m =
    raw.match(/"resetAt"\s*:\s*"([^"]+)"/i) ||
    raw.match(/"reset_at"\s*:\s*"([^"]+)"/i) ||
    raw.match(/resetAt\s*[:=]\s*"?([0-9]{4}-[0-9]{2}-[0-9]{2}T[^"\s]+)"?/i) ||
    raw.match(/reset_at\s*[:=]\s*"?([0-9]{4}-[0-9]{2}-[0-9]{2}T[^"\s]+)"?/i);
  const captured = m && typeof m[1] === 'string' ? m[1].trim() : '';
  return captured ? captured : null;
}

function extractResetAtIsoFromSources(sources: string[]): string | null {
  for (const source of sources) {
    const candidate = extractResetAtIsoFromText(source);
    if (candidate) {
      return candidate;
    }
  }
  return null;
}

function collectUpstreamErrorSources(ev: ProviderErrorEvent): string[] {
  const sources: string[] = [];
  const msg = typeof ev.message === 'string' ? ev.message : '';
  if (msg) sources.push(msg);
  const details = ev.details && typeof ev.details === 'object' && !Array.isArray(ev.details) ? (ev.details as any) : null;
  if (details) {
    const upstreamMessage = typeof details.upstreamMessage === 'string' ? details.upstreamMessage : '';
    if (upstreamMessage && upstreamMessage.trim()) sources.push(upstreamMessage);
    const meta = details.meta && typeof details.meta === 'object' && !Array.isArray(details.meta) ? details.meta : null;
    if (meta) {
      const metaUpstream = typeof meta.upstreamMessage === 'string' ? meta.upstreamMessage : '';
      const metaMessage = typeof meta.message === 'string' ? meta.message : '';
      if (metaUpstream && metaUpstream.trim()) sources.push(metaUpstream);
      if (metaMessage && metaMessage.trim()) sources.push(metaMessage);
    }
  }
  return sources;
}

function isAntigravityProviderKey(providerKey: string): boolean {
  return providerKey.toLowerCase().startsWith('antigravity.');
}

function isGoogleAccountVerificationRequired(ev: ProviderErrorEvent, sources: string[]): boolean {
  if (!sources.length) {
    sources = collectUpstreamErrorSources(ev);
  }
  const lowered = sources.join(' | ').toLowerCase();
  return (
    lowered.includes('verify your account') ||
    lowered.includes('validation_required') ||
    lowered.includes('validation required') ||
    lowered.includes('validation_url') ||
    lowered.includes('validation url') ||
    lowered.includes('accounts.google.com/signin/continue') ||
    lowered.includes('support.google.com/accounts?p=al_alert')
  );
}

function isThoughtSignatureMissing(ev: ProviderErrorEvent, sources: string[]): boolean {
  const code = typeof ev.code === 'string' ? ev.code.trim().toLowerCase() : '';
  if (code.includes('thought') && code.includes('signature')) {
    return true;
  }
  if (!sources.length) {
    sources = collectUpstreamErrorSources(ev);
  }
  for (const source of sources) {
    const lowered = source.toLowerCase();
    const mentionsSignature =
      lowered.includes('thoughtsignature') ||
      lowered.includes('thought signature') ||
      lowered.includes('reasoning_signature') ||
      lowered.includes('reasoning signature');
    if (!mentionsSignature) continue;
    if (
      lowered.includes('missing') ||
      lowered.includes('required') ||
      lowered.includes('invalid') ||
      lowered.includes('not provided') ||
      lowered.includes('签名') ||
      lowered.includes('缺少') ||
      lowered.includes('无效')
    ) {
      return true;
    }
  }
  return false;
}

function extractFirstUrl(sources: string[]): string | null {
  for (const source of sources) {
    const m = String(source || '').match(/https?:\/\/\S+/);
    if (m && m[0]) {
      const url = m[0].replace(/[)\],.]+$/g, '');
      return url || null;
    }
  }
  return null;
}

export class QuotaManager {
  private readonly staticConfigs = new Map<string, StaticQuotaConfig>();
  private readonly states = new Map<string, QuotaState>();
  private readonly store: QuotaStore | null;
  private persistTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(options?: { store?: QuotaStore | null }) {
    this.store = options?.store ?? null;
  }

  async hydrateFromStore(): Promise<void> {
    if (!this.store) {
      return;
    }
    const snapshot = await this.store.load().catch(() => null);
    if (!snapshot || !snapshot.providers || typeof snapshot.providers !== 'object') {
      return;
    }
    const nowMs = Date.now();
    for (const [providerKey, raw] of Object.entries(snapshot.providers)) {
      if (!raw || typeof raw !== 'object') continue;
      const key = safeTrim(providerKey) || safeTrim((raw as any).providerKey);
      if (!key) continue;
      const state = raw as QuotaState;
      this.states.set(key, tickQuotaStateTime({ ...state, providerKey: key }, nowMs));
    }
  }

  registerProviderStaticConfig(providerKey: string, cfg: StaticQuotaConfig): void {
    const key = safeTrim(providerKey);
    if (!key) return;
    this.staticConfigs.set(key, { ...cfg });
    if (!this.states.has(key)) {
      this.states.set(key, createInitialQuotaState(key, cfg, Date.now()));
      this.markDirty();
    }
  }

  ensureProvider(providerKey: string): QuotaState {
    const key = safeTrim(providerKey);
    if (!key) {
      throw new Error('providerKey is required');
    }
    const existing = this.states.get(key);
    if (existing) {
      return existing;
    }
    const cfg = this.staticConfigs.get(key);
    const seeded = createInitialQuotaState(key, cfg, Date.now());
    this.states.set(key, seeded);
    this.markDirty();
    return seeded;
  }

  disableProvider(options: { providerKey: string; mode: 'cooldown' | 'blacklist'; durationMs: number; reason?: string }): void {
    const key = safeTrim(options.providerKey);
    if (!key) return;
    const nowMs = Date.now();
    const state = this.ensureProvider(key);
    const until = nowMs + Math.max(0, Math.floor(options.durationMs));
    const next: QuotaState =
      options.mode === 'blacklist'
        ? { ...state, blacklistUntil: Math.max(state.blacklistUntil ?? 0, until) || until, reason: 'blacklist', inPool: false }
        : { ...state, cooldownUntil: Math.max(state.cooldownUntil ?? 0, until) || until, reason: 'cooldown', inPool: false };
    this.states.set(key, tickQuotaStateTime(next, nowMs));
    this.markDirty();
  }

  recoverProvider(providerKey: string): void {
    const key = safeTrim(providerKey);
    if (!key) return;
    const nowMs = Date.now();
    const state = this.ensureProvider(key);
    const next: QuotaState = {
      ...state,
      cooldownUntil: null,
      blacklistUntil: null,
      authIssue: null,
      reason: 'ok',
      inPool: true
    };
    this.states.set(key, tickQuotaStateTime(next, nowMs));
    this.markDirty();
  }

  resetProvider(providerKey: string): void {
    const key = safeTrim(providerKey);
    if (!key) return;
    const nowMs = Date.now();
    const cfg = this.staticConfigs.get(key);
    this.states.set(key, createInitialQuotaState(key, cfg, nowMs));
    this.markDirty();
  }

  onProviderError(ev: ProviderErrorEvent): void {
    const providerKey = parseProviderKey(ev.runtime as any) || safeTrim((ev as any)?.runtime?.providerKey) || safeTrim((ev as any)?.providerKey);
    if (!providerKey) return;
    const nowMs = typeof ev.timestamp === 'number' && Number.isFinite(ev.timestamp) ? ev.timestamp : Date.now();
    const status = parseHttpStatus(ev);
    const code = safeTrim(ev.code) || safeTrim((ev as any)?.runtime?.errorCode);
    const details = ev.details && typeof ev.details === 'object' ? (ev.details as Record<string, unknown>) : undefined;

    const state = this.ensureProvider(providerKey);

    // Antigravity account-scope auth verification required: isolate to current providerKey only.
    if (isAntigravityProviderKey(providerKey)) {
      const sources = collectUpstreamErrorSources(ev);
      if (isGoogleAccountVerificationRequired(ev, sources)) {
        const url = extractFirstUrl(sources);
        const banUntil = nowMs + ANTIGRAVITY_AUTH_VERIFY_BAN_MS;
        const next: QuotaState = {
          ...state,
          inPool: false,
          reason: 'authVerify',
          authIssue: {
            kind: 'google_account_verification',
            ...(url ? { url } : {}),
            message: 'account verification required'
          },
          blacklistUntil: Math.max(state.blacklistUntil ?? 0, banUntil) || banUntil,
          cooldownUntil: null,
          lastErrorAtMs: nowMs,
          lastErrorCode: code || 'AUTH_VERIFY',
          lastErrorSeries: 'EFATAL',
          consecutiveErrorCount: 0
        };
        this.states.set(providerKey, tickQuotaStateTime(next, nowMs));
        this.markDirty();
        return;
      }
      // Thought signature missing: cooldown current providerKey only.
      if (isThoughtSignatureMissing(ev, sources)) {
        const freezeUntil = nowMs + ANTIGRAVITY_THOUGHT_SIGNATURE_MISSING_COOLDOWN_MS;
        const next: QuotaState = {
          ...state,
          inPool: false,
          reason: 'cooldown',
          cooldownUntil: Math.max(state.cooldownUntil ?? 0, freezeUntil) || freezeUntil,
          lastErrorAtMs: nowMs,
          lastErrorCode: code || 'SIGNATURE_MISSING',
          lastErrorSeries: 'EOTHER',
          consecutiveErrorCount: 0
        };
        this.states.set(providerKey, tickQuotaStateTime(next, nowMs));
        this.markDirty();
        return;
      }
    }

    // HTTP 402: treat as quota depleted -> blacklist until reset.
    if (status === 402 || code.toUpperCase() === 'HTTP_402') {
      const resetAtIso =
        extractResetAtIso(details) ??
        extractResetAtIsoFromSources(collectUpstreamErrorSources(ev));
      let resetAtMs: number | null = null;
      if (resetAtIso) {
        const parsed = Date.parse(resetAtIso);
        if (Number.isFinite(parsed) && parsed > nowMs) {
          resetAtMs = parsed;
        }
      }
      if (resetAtMs === null) {
        const staticCfg = this.staticConfigs.get(providerKey) as { apikeyDailyResetTime?: unknown } | undefined;
        const configuredResetTime =
          staticCfg && typeof (staticCfg as any).apikeyDailyResetTime === 'string'
            ? String((staticCfg as any).apikeyDailyResetTime).trim()
            : null;
        resetAtMs = computeNextDailyResetAtMs({ nowMs, resetTime: configuredResetTime }).resetAtMs;
      }
      const next: QuotaState = {
        ...state,
        inPool: false,
        reason: 'blacklist',
        blacklistUntil: Math.max(state.blacklistUntil ?? 0, resetAtMs) || resetAtMs,
        lastErrorAtMs: nowMs,
        lastErrorCode: code || 'HTTP_402',
        lastErrorSeries: 'EOTHER',
        consecutiveErrorCount: 0
      };
      this.states.set(providerKey, tickQuotaStateTime(next, nowMs));
      this.markDirty();
      return;
    }

    const authIssue = (details as any)?.authIssue && typeof (details as any).authIssue === 'object'
      ? ((details as any).authIssue as any)
      : null;

    const mapped: ErrorEventForQuota = {
      providerKey,
      code: code || null,
      httpStatus: typeof status === 'number' ? status : null,
      fatal: Boolean(ev.recoverable === false || ev.affectsHealth === false ? false : (ev as any)?.fatal) || null,
      timestampMs: nowMs,
      resetAt: extractResetAtIso(details),
      authIssue: authIssue || null
    };

    const next = applyErrorEvent(state, mapped, nowMs);
    this.states.set(providerKey, tickQuotaStateTime(next, nowMs));
    this.markDirty();
  }

  onProviderSuccess(ev: ProviderSuccessEvent): void {
    const providerKey = safeTrim(ev.runtime?.providerKey);
    if (!providerKey) return;
    const nowMs = typeof ev.timestamp === 'number' && Number.isFinite(ev.timestamp) ? ev.timestamp : Date.now();
    const state = this.ensureProvider(providerKey);
    const mapped: SuccessEventForQuota = { providerKey, timestampMs: nowMs };
    const next = applySuccessEvent(state, mapped, nowMs);
    this.states.set(providerKey, next);
    this.markDirty();
  }

  /**
   * External quota snapshot ingestion hook (host-driven).
   * This API is intentionally small: the host adapter translates provider-specific
   * quota responses into a normalized per-providerKey inPool/cooldown/blacklist update.
   */
  updateProviderPoolState(options: {
    providerKey: string;
    inPool: boolean;
    reason?: string | null;
    cooldownUntil?: number | null;
    blacklistUntil?: number | null;
  }): void {
    const key = safeTrim(options.providerKey);
    if (!key) return;
    const nowMs = Date.now();
    const state = this.ensureProvider(key);
    const next: QuotaState = {
      ...state,
      inPool: Boolean(options.inPool),
      reason: options.inPool ? 'ok' : state.reason,
      cooldownUntil: typeof options.cooldownUntil === 'number' ? options.cooldownUntil : state.cooldownUntil,
      blacklistUntil: typeof options.blacklistUntil === 'number' ? options.blacklistUntil : state.blacklistUntil,
      ...(typeof options.reason === 'string' && options.reason.trim()
        ? { reason: options.reason.trim() as any }
        : {})
    };
    this.states.set(key, tickQuotaStateTime(next, nowMs));
    this.markDirty();
  }

  getQuotaView(): ProviderQuotaView {
    return (providerKey: string): ProviderQuotaViewEntry | null => {
      const key = safeTrim(providerKey);
      if (!key) return null;
      const nowMs = Date.now();
      const state = this.states.get(key);
      if (!state) {
        return null;
      }
      const normalized = tickQuotaStateTime(state, nowMs);
      if (normalized !== state) {
        this.states.set(key, normalized);
      }
      const withinBlacklist =
        typeof normalized.blacklistUntil === 'number' && normalized.blacklistUntil > nowMs;
      const withinCooldown =
        typeof normalized.cooldownUntil === 'number' && normalized.cooldownUntil > nowMs;
      const inPool = normalized.inPool && !withinBlacklist && !withinCooldown;

      const hasRecentError =
        typeof normalized.lastErrorAtMs === 'number' &&
        Number.isFinite(normalized.lastErrorAtMs) &&
        nowMs - normalized.lastErrorAtMs >= 0 &&
        nowMs - normalized.lastErrorAtMs <= 30_000;
      const selectionPenalty =
        hasRecentError && typeof normalized.consecutiveErrorCount === 'number' && normalized.consecutiveErrorCount > 0
          ? Math.max(0, Math.floor(normalized.consecutiveErrorCount))
          : 0;

      return {
        providerKey: key,
        inPool,
        reason: normalized.reason,
        priorityTier: normalized.priorityTier,
        selectionPenalty,
        lastErrorAtMs: normalized.lastErrorAtMs,
        consecutiveErrorCount: normalized.consecutiveErrorCount,
        cooldownUntil: normalized.cooldownUntil,
        blacklistUntil: normalized.blacklistUntil
      };
    };
  }

  getSnapshot(): { updatedAtMs: number; providers: Record<string, QuotaState> } {
    return {
      updatedAtMs: Date.now(),
      providers: Object.fromEntries(this.states.entries())
    };
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.persistTimer) {
      return;
    }
    // best-effort debounce
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (!this.dirty) return;
      this.dirty = false;
      void this.persistNow();
    }, 800);
  }

  async persistNow(): Promise<void> {
    if (!this.store) return;
    const snapshot = this.getSnapshot();
    const payload = { savedAtMs: snapshot.updatedAtMs, providers: snapshot.providers };
    await this.store.save(payload).catch(() => {
      // persistence must never block routing
    });
  }
}
