import { ProviderHealthManager } from '../../health-manager.js';
import { ProviderRegistry } from '../../provider-registry.js';
import type {
  ProviderErrorEvent,
  ProviderFailureEvent,
  ProviderHealthConfig,
  TargetMetadata
} from '../../types.js';

const SERIES_COOLDOWN_DETAIL_KEY = 'virtualRouterSeriesCooldown' as const;
const QUOTA_RECOVERY_DETAIL_KEY = 'virtualRouterQuotaRecovery' as const;
const QUOTA_DEPLETED_DETAIL_KEY = 'virtualRouterQuotaDepleted' as const;
type ModelSeriesName = 'gemini-pro' | 'gemini-flash' | 'claude' | 'default';
type SeriesCooldownPayload = {
  providerId: string;
  providerKey?: string;
  series: Exclude<ModelSeriesName, 'default'>;
  cooldownMs: number;
};

type QuotaRecoveryPayload = {
  providerKey?: string;
  reason?: string;
};
type QuotaDepletedPayload = {
  providerKey?: string;
  reason?: string;
  cooldownMs?: number;
};

type DebugLike = { log?: (...args: unknown[]) => void } | Console | undefined;

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function logHealthNonBlockingError(
  stage: string,
  error: unknown,
  debug?: DebugLike,
  details?: Record<string, unknown>
): void {
  const payload = details && Object.keys(details).length > 0 ? details : undefined;
  try {
    if (typeof debug?.log === 'function') {
      debug.log('[virtual-router] health non-blocking failure', {
        stage,
        error: formatUnknownError(error),
        ...(payload ? { details: payload } : {})
      });
      return;
    }
    const suffix = payload ? ` details=${JSON.stringify(payload)}` : '';
    console.warn(`[virtual-router] ${stage} failed (non-blocking): ${formatUnknownError(error)}${suffix}`);
  } catch {
    // Never throw from non-blocking logging.
  }
}

function parseDurationToMs(value?: string): number | null {
  if (!value || typeof value !== 'string') {
    return null;
  }
  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h)/gi;
  let totalMs = 0;
  let matched = false;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    matched = true;
    const amount = Number.parseFloat(match[1]);
    if (!Number.isFinite(amount)) {
      continue;
    }
    const unit = match[2].toLowerCase();
    if (unit === 'ms') {
      totalMs += amount;
    } else if (unit === 'h') {
      totalMs += amount * 3_600_000;
    } else if (unit === 'm') {
      totalMs += amount * 60_000;
    } else if (unit === 's') {
      totalMs += amount * 1_000;
    }
  }
  if (!matched) {
    const seconds = Number.parseFloat(value);
    if (Number.isFinite(seconds)) {
      totalMs = seconds * 1_000;
      matched = true;
    }
  }
  if (!matched || totalMs <= 0) {
    return null;
  }
  return Math.round(totalMs);
}

function readEnvSchedule(name: string, fallback: number[]): number[] {
  const raw = (process.env[name] || '').trim();
  if (!raw) {
    return fallback;
  }
  const parts = raw.split(',').map((token) => token.trim()).filter(Boolean);
  const parsed: number[] = [];
  for (const part of parts) {
    const ms = parseDurationToMs(part);
    if (ms && ms > 0) {
      parsed.push(ms);
    }
  }
  return parsed.length ? parsed : fallback;
}

function readEnvDuration(name: string, fallbackMs: number): number {
  const raw = (process.env[name] || '').trim();
  if (!raw) {
    return fallbackMs;
  }
  const ms = parseDurationToMs(raw);
  return ms && ms > 0 ? ms : fallbackMs;
}

/**
 * 对没有 quotaResetDelay 的 429 错误，在 VirtualRouter 内部维护一个简单的阶梯退避策略：
 * - 默认：第 1 次 3 秒，第 2 次 10 秒，第 3 次 31 秒，第 4 次及以上 61 秒封顶；
 * - 可通过环境变量 ROUTECODEX_RL_SCHEDULE / RCC_RL_SCHEDULE 调整（例如 "3s,10s,31s,61s"）。
 *
 * 这里的“次数”针对 providerKey 计数，并带有简单的时间窗口：若距离上次 429 超过 24 小时，则重置计数。
 * 该状态仅用于路由决策，不反映在 healthConfig 上，使 Host 与 VirtualRouter 对 429 处理职责清晰分层。
 */
const NO_QUOTA_RATE_LIMIT_SCHEDULE_MS = readEnvSchedule('ROUTECODEX_RL_SCHEDULE', [
  5_000,
  15_000,
  30_000,
  60_000
]);
type RateLimitBackoffState = {
  count: number;
  lastAt: number;
};
const rateLimitBackoffByProvider: Map<string, RateLimitBackoffState> = new Map();
const RATE_LIMIT_RESET_WINDOW_MS = readEnvDuration('ROUTECODEX_RL_RESET_WINDOW', 24 * 60 * 60_000);
const DAY_MS = 24 * 60 * 60_000;

function computeRateLimitCooldownMsForProvider(providerKey: string, now: number): number {
  const prev = rateLimitBackoffByProvider.get(providerKey);
  let nextCount = 1;
  if (prev) {
    const elapsed = now - prev.lastAt;
    if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < RATE_LIMIT_RESET_WINDOW_MS) {
      nextCount = prev.count + 1;
    }
  }
  const idx = Math.min(nextCount - 1, NO_QUOTA_RATE_LIMIT_SCHEDULE_MS.length - 1);
  const ttl = NO_QUOTA_RATE_LIMIT_SCHEDULE_MS[idx];
  rateLimitBackoffByProvider.set(providerKey, { count: nextCount, lastAt: now });
  return ttl;
}

function extractDailyLimitSignalCandidates(event: ProviderErrorEvent): string[] {
  const values: string[] = [];
  const pushString = (value: unknown): void => {
    if (typeof value !== 'string') {
      return;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    values.push(trimmed);
  };

  pushString(event.code);
  pushString(event.message);
  const details = (event as { details?: unknown }).details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return values;
  }
  const detailsRecord = details as Record<string, unknown>;
  pushString(detailsRecord.reason);
  pushString(detailsRecord.message);
  pushString(detailsRecord.code);
  pushString(detailsRecord.upstreamCode);
  pushString(detailsRecord.upstreamMessage);

  const meta = detailsRecord.meta;
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const metaRecord = meta as Record<string, unknown>;
    pushString(metaRecord.reason);
    pushString(metaRecord.message);
    pushString(metaRecord.code);
    pushString(metaRecord.upstreamCode);
    pushString(metaRecord.upstreamMessage);
  }

  return values;
}

function isDailyLimitExceededEvent(event: ProviderErrorEvent): boolean {
  const candidates = extractDailyLimitSignalCandidates(event);
  if (candidates.length === 0) {
    return false;
  }
  return candidates.some((candidate) => {
    const lowered = candidate.toLowerCase();
    return (
      lowered.includes('daily_limit_exceeded') ||
      lowered.includes('daily usage limit exceeded') ||
      lowered.includes('daily limit exceeded') ||
      /daily[\s_-]*(usage[\s_-]*)?limit[\s_-]*exceed/.test(lowered)
    );
  });
}

function computeCooldownUntilNextLocalMidnightMs(nowMs: number): number {
  if (!Number.isFinite(nowMs) || nowMs <= 0) {
    return DAY_MS;
  }
  const now = new Date(nowMs);
  const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0).getTime();
  const ttl = nextMidnight - nowMs;
  if (!Number.isFinite(ttl) || ttl <= 0) {
    return DAY_MS;
  }
  return ttl;
}

export function resetRateLimitBackoffForProvider(providerKey: string): void {
  if (!providerKey) {
    return;
  }
  rateLimitBackoffByProvider.delete(providerKey);
}

type AntigravityRiskState = { count: number; lastAt: number };
const antigravityRiskBySignature: Map<string, AntigravityRiskState> = new Map();
const ANTIGRAVITY_RISK_RESET_WINDOW_MS = readEnvDuration('ROUTECODEX_ANTIGRAVITY_RISK_RESET_WINDOW', 30 * 60_000);
const ANTIGRAVITY_RISK_COOLDOWN_MS = readEnvDuration('ROUTECODEX_ANTIGRAVITY_RISK_COOLDOWN', 5 * 60_000);
const ANTIGRAVITY_RISK_BAN_MS = readEnvDuration('ROUTECODEX_ANTIGRAVITY_RISK_BAN', 24 * 60 * 60_000);
const ANTIGRAVITY_AUTH_VERIFY_BAN_MS = readEnvDuration('ROUTECODEX_ANTIGRAVITY_AUTH_VERIFY_BAN', 24 * 60 * 60_000);
const ANTIGRAVITY_THOUGHT_SIGNATURE_MISSING_COOLDOWN_MS = readEnvDuration(
  'ROUTECODEX_ANTIGRAVITY_THOUGHT_SIGNATURE_MISSING_COOLDOWN',
  5 * 60_000
);

function isAntigravityEvent(event: ProviderErrorEvent): boolean {
  const runtime = event?.runtime;
  if (!runtime || typeof runtime !== 'object') {
    return false;
  }
  const providerId = typeof runtime.providerId === 'string' ? runtime.providerId.trim().toLowerCase() : '';
  if (providerId === 'antigravity') {
    return true;
  }
  const providerKey = typeof runtime.providerKey === 'string' ? runtime.providerKey.trim().toLowerCase() : '';
  return providerKey.startsWith('antigravity.');
}

function isGoogleAccountVerificationRequired(event: ProviderErrorEvent): boolean {
  const sources: string[] = [];
  const message = typeof event.message === 'string' ? event.message : '';
  if (message) sources.push(message);
  const details = (event as { details?: unknown }).details;
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    const upstreamMessage = (details as { upstreamMessage?: unknown }).upstreamMessage;
    if (typeof upstreamMessage === 'string' && upstreamMessage.trim()) {
      sources.push(upstreamMessage);
    }
    const meta = (details as { meta?: unknown }).meta;
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
      const metaUpstream = (meta as { upstreamMessage?: unknown }).upstreamMessage;
      if (typeof metaUpstream === 'string' && metaUpstream.trim()) {
        sources.push(metaUpstream);
      }
      const metaMessage = (meta as { message?: unknown }).message;
      if (typeof metaMessage === 'string' && metaMessage.trim()) {
        sources.push(metaMessage);
      }
    }
  }
  if (sources.length === 0) {
    return false;
  }
  const lowered = sources.join(' | ').toLowerCase();
  return (
    lowered.includes('verify your account') ||
    // Antigravity-Manager alignment: 403 validation gating keywords.
    lowered.includes('validation_required') ||
    lowered.includes('validation required') ||
    lowered.includes('validation_url') ||
    lowered.includes('validation url') ||
    lowered.includes('accounts.google.com/signin/continue') ||
    lowered.includes('support.google.com/accounts?p=al_alert')
  );
}

function resolveAntigravityRuntimeKey(event: ProviderErrorEvent): string | null {
  const runtime = event.runtime;
  if (!runtime || typeof runtime !== 'object') {
    return null;
  }
  const target = runtime.target && typeof runtime.target === 'object' ? (runtime.target as TargetMetadata) : null;
  const byTarget = target && typeof target.runtimeKey === 'string' && target.runtimeKey.trim() ? target.runtimeKey.trim() : '';
  if (byTarget) {
    return byTarget;
  }
  const providerKey =
    (typeof runtime.providerKey === 'string' && runtime.providerKey.trim() ? runtime.providerKey.trim() : '') ||
    (target && typeof (target as any).providerKey === 'string' && String((target as any).providerKey).trim()
      ? String((target as any).providerKey).trim()
      : '');
  if (!providerKey) {
    return null;
  }
  const parts = providerKey.split('.').filter(Boolean);
  if (parts.length < 2) {
    return null;
  }
  return `${parts[0]}.${parts[1]}`;
}

function shouldTriggerAntigravityRiskPolicy(event: ProviderErrorEvent): boolean {
  const status = typeof event.status === 'number' ? event.status : undefined;
  if (typeof status === 'number' && Number.isFinite(status)) {
    // Focus on "dirty request" / auth / permission class issues. Avoid 429 which already has backoff.
    return status >= 400 && status < 500 && status !== 429;
  }
  // If status is missing, fall back to known HTTP-ish error codes.
  return typeof event.code === 'string' && /^HTTP_4\d\d$/.test(event.code.trim());
}

function computeAntigravityRiskSignature(event: ProviderErrorEvent): string {
  const status = typeof event.status === 'number' && Number.isFinite(event.status) ? String(event.status) : '';
  const code = typeof event.code === 'string' && event.code.trim() ? event.code.trim() : '';
  const stage = typeof event.stage === 'string' && event.stage.trim() ? event.stage.trim() : '';
  const parts = [status, code, stage].filter((p) => p.length > 0);
  return parts.length ? parts.join(':') : 'unknown';
}

function isAntigravityThoughtSignatureMissing(event: ProviderErrorEvent): boolean {
  const code = typeof event.code === 'string' ? event.code.trim().toLowerCase() : '';
  if (code.includes('thought') && code.includes('signature')) {
    return true;
  }
  const sources: string[] = [];
  const message = typeof event.message === 'string' ? event.message : '';
  if (message) sources.push(message);
  const details = (event as { details?: unknown }).details;
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    const upstreamMessage = (details as { upstreamMessage?: unknown }).upstreamMessage;
    if (typeof upstreamMessage === 'string' && upstreamMessage.trim()) {
      sources.push(upstreamMessage);
    }
    const meta = (details as { meta?: unknown }).meta;
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
      const metaUpstream = (meta as { upstreamMessage?: unknown }).upstreamMessage;
      if (typeof metaUpstream === 'string' && metaUpstream.trim()) {
        sources.push(metaUpstream);
      }
      const metaMessage = (meta as { message?: unknown }).message;
      if (typeof metaMessage === 'string' && metaMessage.trim()) {
        sources.push(metaMessage);
      }
    }
  }

  if (sources.length === 0) {
    return false;
  }

  for (const source of sources) {
    const lowered = source.toLowerCase();
    // Match both "thoughtSignature" and "thought signature" variants, as well as "reasoning signature".
    const mentionsSignature =
      lowered.includes('thoughtsignature') ||
      lowered.includes('thought signature') ||
      lowered.includes('reasoning_signature') ||
      lowered.includes('reasoning signature');
    if (!mentionsSignature) {
      continue;
    }
    // Match common failure patterns in upstream error messages.
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

function shouldApplyGeminiSeriesSignatureFreeze(event: ProviderErrorEvent): boolean {
  const status = typeof event.status === 'number' ? event.status : undefined;
  // Signature missing is a request-shape contract failure; treat as 4xx.
  if (status !== undefined && status >= 400 && status < 500) {
    return true;
  }
  const code = typeof event.code === 'string' ? event.code.trim().toUpperCase() : '';
  return /^HTTP_4\d\d$/.test(code) || code.includes('INVALID_ARGUMENT') || code.includes('FAILED_PRECONDITION');
}

export function applyAntigravityRiskPolicyImpl(
  event: ProviderErrorEvent,
  providerRegistry: ProviderRegistry,
  healthManager: ProviderHealthManager,
  markProviderCooldown: (providerKey: string, cooldownMs: number | undefined) => void,
  debug?: DebugLike
): void {
  if (!event) {
    return;
  }
  if (!isAntigravityEvent(event)) {
    return;
  }
  if (!shouldTriggerAntigravityRiskPolicy(event)) {
    return;
  }

  const runtimeKey = resolveAntigravityRuntimeKey(event);
  const verificationRequired = Boolean(runtimeKey) && isGoogleAccountVerificationRequired(event);

  // Account verification errors are per-account and must be handled immediately:
  // - blacklist only the affected runtimeKey (do NOT penalize other Antigravity accounts)
  // - require user to complete OAuth verification to recover
  if (verificationRequired && runtimeKey) {
    const providerKeys = providerRegistry
      .listProviderKeys('antigravity')
      .filter((key) => typeof key === 'string' && key.startsWith(`${runtimeKey}.`));
    if (providerKeys.length === 0) {
      return;
    }
    for (const key of providerKeys) {
      try {
        if (!healthManager.isAvailable(key)) {
          continue;
        }
        healthManager.tripProvider(key, 'auth_verify', ANTIGRAVITY_AUTH_VERIFY_BAN_MS);
        markProviderCooldown(key, ANTIGRAVITY_AUTH_VERIFY_BAN_MS);
      } catch (tripError) {
        logHealthNonBlockingError('applyAntigravityRiskPolicy.authVerify.tripProvider', tripError, debug, {
          providerKey: key,
          runtimeKey
        });
      }
    }
    debug?.log?.('[virtual-router] antigravity auth verify blacklist', {
      runtimeKey,
      cooldownMs: ANTIGRAVITY_AUTH_VERIFY_BAN_MS,
      affected: providerKeys
    });
    return;
  }

  // Thought signature missing is a deterministic incompatibility for Gemini-family flows that require it.
  // If we keep routing into Antigravity Gemini models without a signature, we create a request storm.
  // Freeze the *Gemini* series (pro/flash) immediately so the router falls back to non-Antigravity providers.
  if (isAntigravityThoughtSignatureMissing(event) && shouldApplyGeminiSeriesSignatureFreeze(event)) {
    const allProviderKeys = providerRegistry.listProviderKeys('antigravity');
    const providerKeys = runtimeKey
      ? allProviderKeys.filter((key) => typeof key === 'string' && key.startsWith(`${runtimeKey}.`))
      : allProviderKeys;
    const affected: string[] = [];
    for (const key of providerKeys) {
      try {
        if (!healthManager.isAvailable(key)) {
          continue;
        }
        const profile = providerRegistry.get(key);
        const modelSeries = resolveModelSeries(profile.modelId);
        if (modelSeries !== 'gemini-pro' && modelSeries !== 'gemini-flash') {
          continue;
        }
        healthManager.tripProvider(key, 'signature_missing', ANTIGRAVITY_THOUGHT_SIGNATURE_MISSING_COOLDOWN_MS);
        markProviderCooldown(key, ANTIGRAVITY_THOUGHT_SIGNATURE_MISSING_COOLDOWN_MS);
        affected.push(key);
      } catch (tripError) {
        logHealthNonBlockingError('applyAntigravityRiskPolicy.signatureMissing.tripProvider', tripError, debug, {
          providerKey: key,
          runtimeKey
        });
      }
    }
    if (affected.length) {
      debug?.log?.('[virtual-router] antigravity thoughtSignature missing: freeze gemini series', {
        ...(runtimeKey ? { runtimeKey } : {}),
        cooldownMs: ANTIGRAVITY_THOUGHT_SIGNATURE_MISSING_COOLDOWN_MS,
        affected
      });
    }
    return;
  }

  const signature = computeAntigravityRiskSignature(event);
  if (!signature || signature === 'unknown') {
    return;
  }

  // Antigravity-Manager alignment: account verification errors are per-account (runtimeKey) and should not
  // penalize all other Antigravity accounts. Request-shape/auth policy failures are still treated globally.
  const runtimeScoped = Boolean(runtimeKey) && isGoogleAccountVerificationRequired(event);
  const riskKey = runtimeScoped ? `${signature}|${runtimeKey}` : signature;

  const now = Date.now();
  const prev = antigravityRiskBySignature.get(riskKey);
  let count = 1;
  if (prev) {
    const elapsed = now - prev.lastAt;
    if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < ANTIGRAVITY_RISK_RESET_WINDOW_MS) {
      count = prev.count + 1;
    }
  }
  antigravityRiskBySignature.set(riskKey, { count, lastAt: now });

  // Escalation ladder (Antigravity account safety):
  // 1) First/second occurrence: normal retry/fallback logic handles per-request behavior.
  // 2) Third occurrence: cooldown Antigravity providerKeys for 5 minutes (scoped for account verification errors).
  // 3) Fourth+ occurrence: effectively remove Antigravity from routing (long ban window; scoped for account verification errors).
  const allProviderKeys = providerRegistry.listProviderKeys('antigravity');
  const providerKeys = runtimeScoped
    ? allProviderKeys.filter((key) => {
      return typeof key === 'string' && runtimeKey ? key.startsWith(`${runtimeKey}.`) : false;
    })
    : allProviderKeys;
  if (providerKeys.length === 0) {
    return;
  }

  if (count === 3) {
    for (const key of providerKeys) {
      try {
        healthManager.tripProvider(key, 'risk_cooldown', ANTIGRAVITY_RISK_COOLDOWN_MS);
        markProviderCooldown(key, ANTIGRAVITY_RISK_COOLDOWN_MS);
      } catch (tripError) {
        logHealthNonBlockingError('applyAntigravityRiskPolicy.riskCooldown.tripProvider', tripError, debug, {
          providerKey: key,
          runtimeKey
        });
      }
    }
    debug?.log?.('[virtual-router] antigravity risk cooldown', {
      signature,
      ...(runtimeScoped ? { runtimeKey } : {}),
      count,
      cooldownMs: ANTIGRAVITY_RISK_COOLDOWN_MS,
      affected: providerKeys
    });
  } else if (count >= 4) {
    const ttl = Math.max(ANTIGRAVITY_RISK_BAN_MS, ANTIGRAVITY_RISK_COOLDOWN_MS);
    for (const key of providerKeys) {
      try {
        healthManager.tripProvider(key, 'risk_blacklist', ttl);
        markProviderCooldown(key, ttl);
      } catch (tripError) {
        logHealthNonBlockingError('applyAntigravityRiskPolicy.riskBlacklist.tripProvider', tripError, debug, {
          providerKey: key,
          runtimeKey
        });
      }
    }
    debug?.log?.('[virtual-router] antigravity risk blacklist', {
      signature,
      ...(runtimeScoped ? { runtimeKey } : {}),
      count,
      cooldownMs: ttl,
      affected: providerKeys
    });
  }
}

export function handleProviderFailureImpl(
  event: ProviderFailureEvent,
  healthManager: ProviderHealthManager,
  healthConfig: Required<ProviderHealthConfig>,
  markProviderCooldown: (providerKey: string, cooldownMs: number | undefined) => void
): void {
  if (!event || !event.providerKey) {
    return;
  }
  if (event.affectsHealth === false) {
    return;
  }
 if (event.fatal) {
   healthManager.tripProvider(event.providerKey, event.reason, event.cooldownOverrideMs);
 } else if (event.reason === 'rate_limit' && event.statusCode === 429) {
   // 对非致命的 429 错误：
   // - 若 ProviderErrorEvent 已携带显式 cooldownOverrideMs（例如来自 quotaResetDelay），则直接使用；
   // - 否则针对该 providerKey 启用阶梯退避策略（5min → 1h → 6h → 24h），
   //   在冷却期内从路由池中移除该 alias，避免持续命中上游。
   const providerKey = event.providerKey;
   let ttl = event.cooldownOverrideMs;
   if (!ttl || !Number.isFinite(ttl) || ttl <= 0) {
     ttl = computeRateLimitCooldownMsForProvider(providerKey, Date.now());
   }
   healthManager.cooldownProvider(providerKey, event.reason, ttl);
   markProviderCooldown(providerKey, ttl);
 } else {
    // 所有非致命错误都触发 cooldown，让虚拟路由切换到其他候选
    const ttl = event.cooldownOverrideMs ?? healthConfig.cooldownMs ?? 60_000;
    healthManager.cooldownProvider(event.providerKey, event.reason, ttl);
    markProviderCooldown(event.providerKey, ttl);
 }
}

export function mapProviderErrorImpl(
  event: ProviderErrorEvent,
  healthConfig: Required<ProviderHealthConfig>
): ProviderFailureEvent | null {
  if (!event || !event.runtime) {
    return null;
  }
  const runtime = event.runtime;
  const providerKey =
    runtime.providerKey ||
    (runtime.target && typeof runtime.target === 'object'
      ? (runtime.target as TargetMetadata).providerKey
      : undefined);
  if (!providerKey) {
    return null;
  }

  const routeName = runtime.routeName;
  const statusCode = event.status;
  const code = event.code?.toUpperCase() ?? 'ERR_UNKNOWN';
  const stage = event.stage?.toLowerCase() ?? 'unknown';
  const recoverable = event.recoverable === true;
  const providerFamily =
    (runtime as { providerFamily?: string | undefined }).providerFamily &&
    typeof (runtime as { providerFamily?: string | undefined }).providerFamily === 'string'
      ? ((runtime as { providerFamily?: string | undefined }).providerFamily as string)
      : undefined;
  const providerId =
    (runtime as { providerId?: string | undefined }).providerId &&
    typeof (runtime as { providerId?: string | undefined }).providerId === 'string'
      ? ((runtime as { providerId?: string | undefined }).providerId as string)
      : undefined;
  const providerTag = (providerFamily || providerId || '').toLowerCase();
  const isOAuthAuth406 = statusCode === 406 && (providerTag === 'qwen');

  let fatal = !recoverable;
  let reason = deriveReason(code, stage, statusCode);
  let cooldownOverrideMs: number | undefined;

 if (statusCode === 401 || statusCode === 402 || statusCode === 403 || code.includes('AUTH') || isOAuthAuth406) {
   // auth 错误也先尝试切换 provider，而不是直接中断对话
   fatal = false;
    cooldownOverrideMs = Math.max(60_000, healthConfig.cooldownMs ?? 60_000);
   reason = 'auth';
 } else if (statusCode === 413) {
   // Deterministic payload-size rejection for this provider/model.
   // Keep it recoverable so request executor can fail over to other candidates.
   fatal = false;
   cooldownOverrideMs = Math.max(120_000, healthConfig.cooldownMs ?? 60_000);
   reason = 'payload_too_large';
 } else if (statusCode === 429) {
   fatal = false;
   reason = 'rate_limit';
   if (isDailyLimitExceededEvent(event)) {
     cooldownOverrideMs = computeCooldownUntilNextLocalMidnightMs(Date.now());
   } else if (!recoverable) {
     cooldownOverrideMs = Math.max(60_000, healthConfig.cooldownMs ?? 60_000);
   }
 } else if (statusCode && statusCode >= 500) {
   fatal = false;
    cooldownOverrideMs = Math.max(60_000, healthConfig.cooldownMs ?? 60_000);
   reason = 'upstream_error';
 } else if (stage.includes('compat')) {
   fatal = false;
    cooldownOverrideMs = Math.max(60_000, healthConfig.cooldownMs ?? 60_000);
   reason = 'compatibility';
 }

  return {
    providerKey,
    routeName,
    reason,
    fatal,
    statusCode,
    errorCode: code,
    retryable: recoverable,
    affectsHealth: event.affectsHealth !== false,
    cooldownOverrideMs,
    metadata: {
      ...event.runtime,
      stage,
      eventCode: code,
      originalMessage: event.message,
      statusCode
    }
  };
}

export function applySeriesCooldownImpl(
  event: ProviderErrorEvent,
  providerRegistry: ProviderRegistry,
  healthManager: ProviderHealthManager,
  markProviderCooldown: (providerKey: string, cooldownMs: number | undefined) => void,
  debug?: DebugLike
): void {
  const seriesDetail = extractSeriesCooldownDetail(event);
  if (!seriesDetail) {
    return;
  }
  const targetKeys = resolveSeriesCooldownTargets(seriesDetail, event, providerRegistry);
  if (targetKeys.length === 0) {
    debug?.log?.('[virtual-router] series cooldown skipped: no targets', {
      providerId: seriesDetail.providerId,
      providerKey: seriesDetail.providerKey,
      series: seriesDetail.series
    });
    return;
  }
  const affected: string[] = [];
  for (const providerKey of targetKeys) {
    try {
      const profile = providerRegistry.get(providerKey);
      const modelSeries = resolveModelSeries(profile.modelId);
      if (modelSeries !== seriesDetail.series) {
        continue;
      }
      healthManager.tripProvider(providerKey, 'rate_limit', seriesDetail.cooldownMs);
      markProviderCooldown(providerKey, seriesDetail.cooldownMs);
      affected.push(providerKey);
    } catch (tripError) {
      logHealthNonBlockingError('applySeriesCooldown.tripProvider', tripError, debug, {
        providerKey,
        series: seriesDetail.series
      });
    }
  }
  if (affected.length) {
    debug?.log?.('[virtual-router] series cooldown', {
      providerId: seriesDetail.providerId,
      providerKey: seriesDetail.providerKey,
      series: seriesDetail.series,
      cooldownMs: seriesDetail.cooldownMs,
      affected
    });
  }
}

function extractQuotaRecoveryDetail(event: ProviderErrorEvent): { providerKey: string; reason?: string } | null {
  if (!event || !event.details || typeof event.details !== 'object') {
    return null;
  }
  const raw = (event.details as Record<string, unknown>)[QUOTA_RECOVERY_DETAIL_KEY];
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const record = raw as QuotaRecoveryPayload;
  const providerKeyRaw = record.providerKey;
  if (typeof providerKeyRaw !== 'string' || !providerKeyRaw.trim()) {
    return null;
  }
  const reason =
    typeof record.reason === 'string' && record.reason.trim()
      ? record.reason.trim()
      : undefined;
  return {
    providerKey: providerKeyRaw.trim(),
    reason
  };
}

/**
 * 处理来自 Host 侧的配额恢复事件：
 * - 清除指定 providerKey 在健康管理器中的熔断/冷却状态；
 * - 清理对应的速率退避计数；
 * - 调用调用方提供的 clearProviderCooldown 回调移除显式 cooldown TTL。
 *
 * 返回值表示是否已处理（true=已处理且后续应跳过常规错误映射逻辑）。
 */
export function applyQuotaRecoveryImpl(
  event: ProviderErrorEvent,
  healthManager: ProviderHealthManager,
  clearProviderCooldown: (providerKey: string) => void,
  debug?: DebugLike
): boolean {
  const detail = extractQuotaRecoveryDetail(event);
  if (!detail) {
    return false;
  }
  const providerKey = detail.providerKey;
  try {
    healthManager.recordSuccess(providerKey);
    resetRateLimitBackoffForProvider(providerKey);
    clearProviderCooldown(providerKey);
  } catch (recoveryError) {
    logHealthNonBlockingError('applyQuotaRecovery', recoveryError, debug, {
      providerKey,
      reason: detail.reason
    });
  }
  return true;
}

function extractQuotaDepletedDetail(
  event: ProviderErrorEvent
): { providerKey: string; reason?: string; cooldownMs?: number } | null {
  if (!event || !event.details || typeof event.details !== 'object') {
    return null;
  }
  const raw = (event.details as Record<string, unknown>)[QUOTA_DEPLETED_DETAIL_KEY];
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const record = raw as QuotaDepletedPayload;
  const providerKeyRaw = record.providerKey;
  if (typeof providerKeyRaw !== 'string' || !providerKeyRaw.trim()) {
    return null;
  }
  const cooldownMs =
    typeof record.cooldownMs === 'number' && Number.isFinite(record.cooldownMs) && record.cooldownMs > 0
      ? record.cooldownMs
      : undefined;
  const reason =
    typeof record.reason === 'string' && record.reason.trim()
      ? record.reason.trim()
      : undefined;
  return {
    providerKey: providerKeyRaw.trim(),
    cooldownMs,
    reason
  };
}

export function applyQuotaDepletedImpl(
  event: ProviderErrorEvent,
  healthManager: ProviderHealthManager,
  markProviderCooldown: (providerKey: string, cooldownMs: number | undefined) => void,
  debug?: DebugLike
): boolean {
  const detail = extractQuotaDepletedDetail(event);
  if (!detail) {
    return false;
  }
  const ttl = detail.cooldownMs;
  try {
    healthManager.cooldownProvider(detail.providerKey, 'rate_limit', ttl);
    markProviderCooldown(detail.providerKey, ttl);
    debug?.log?.('[virtual-router] quota depleted', {
      providerKey: detail.providerKey,
      cooldownMs: ttl,
      reason: detail.reason
    });
  } catch (depletedError) {
    logHealthNonBlockingError('applyQuotaDepleted', depletedError, debug, {
      providerKey: detail.providerKey,
      cooldownMs: ttl,
      reason: detail.reason
    });
  }
  return true;
}

function resolveSeriesCooldownTargets(
  detail: SeriesCooldownPayload,
  event: ProviderErrorEvent,
  providerRegistry: ProviderRegistry
): string[] {
  const candidates = new Set<string>();
  const push = (key?: string) => {
    if (typeof key !== 'string') {
      return;
    }
    const trimmed = key.trim();
    if (!trimmed) {
      return;
    }
    if (providerRegistry.has(trimmed)) {
      candidates.add(trimmed);
    }
  };
  push(detail.providerKey);
  const runtimeKey =
    (event.runtime?.target && typeof event.runtime.target === 'object'
      ? (event.runtime.target as TargetMetadata).providerKey
      : undefined) || event.runtime?.providerKey;
  push(runtimeKey);
  return Array.from(candidates);
}

function extractSeriesCooldownDetail(event: ProviderErrorEvent): SeriesCooldownPayload | null {
  if (!event || !event.details || typeof event.details !== 'object') {
    return null;
  }
  const raw = (event.details as Record<string, unknown>)[SERIES_COOLDOWN_DETAIL_KEY];
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const providerIdRaw = record.providerId;
  const seriesRaw = record.series;
  const providerKeyRaw = record.providerKey;
  const cooldownRaw = record.cooldownMs;
  if (typeof providerIdRaw !== 'string' || !providerIdRaw.trim()) {
    return null;
  }
  const normalizedSeries = typeof seriesRaw === 'string' ? seriesRaw.trim().toLowerCase() : '';
  if (normalizedSeries !== 'gemini-pro' && normalizedSeries !== 'gemini-flash' && normalizedSeries !== 'claude') {
    return null;
  }
  const cooldownMs =
    typeof cooldownRaw === 'number'
      ? cooldownRaw
      : typeof cooldownRaw === 'string'
        ? Number.parseFloat(cooldownRaw)
        : Number.NaN;
  if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) {
    return null;
  }
  return {
    providerId: providerIdRaw.trim(),
    ...(typeof providerKeyRaw === 'string' && providerKeyRaw.trim().length
      ? { providerKey: providerKeyRaw.trim() }
      : {}),
    series: normalizedSeries as Exclude<ModelSeriesName, 'default'>,
    cooldownMs: Math.round(cooldownMs)
  };
}

export function deriveReason(code: string, stage: string, statusCode?: number): string {
  if (code.includes('RATE') || code.includes('429')) return 'rate_limit';
  if (code.includes('AUTH') || statusCode === 401 || statusCode === 403) return 'auth';
  if (stage.includes('compat')) return 'compatibility';
  if (code.includes('SSE')) return 'sse';
  if (code.includes('TIMEOUT') || statusCode === 408 || statusCode === 504) return 'timeout';
  if (statusCode && statusCode >= 500) return 'upstream_error';
  if (statusCode && statusCode >= 400) return 'client_error';
  return 'unknown';
}

function resolveModelSeries(modelId?: string): ModelSeriesName {
  if (!modelId) {
    return 'default';
  }
  const lower = modelId.toLowerCase();
  if (lower.includes('claude') || lower.includes('opus')) {
    return 'claude';
  }
  if (lower.includes('flash')) {
    return 'gemini-flash';
  }
  if (lower.includes('gemini') || lower.includes('pro')) {
    return 'gemini-pro';
  }
  return 'default';
}
