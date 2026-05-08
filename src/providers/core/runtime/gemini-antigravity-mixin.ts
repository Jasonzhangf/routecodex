/**
 * Gemini Antigravity Mixin — 共享的 Antigravity 运行时兼容方法
 *
 * 真源：唯一 Antigravity 请求预处理/恢复逻辑。
 * 消费者：GeminiHttpProvider、GeminiCLIHttpProvider。
 */
import { randomUUID } from 'node:crypto';
import type { UnknownObject } from '../../../types/common-types.js';
import {
  extractAntigravityGeminiSessionId,
  getAntigravityLatestSignatureSessionIdForAlias,
  lookupAntigravitySessionSignatureEntry,
} from '../../../modules/llmswitch/bridge.js';
import { resolveAntigravityRequestTypeFromPayload } from './antigravity-request-type.js';

// The mixin host contract is satisfied by BaseProvider subclasses.
// Both oauthProviderId and getCurrentRuntimeMetadata are protected in BaseProvider,
// so we accept host as any to avoid protected-visibility conflicts.
type MixinHostLike = any;

export function isAntigravityRuntime(host: MixinHostLike): boolean {
  const fromConfig =
    typeof host.config?.config?.providerId === 'string' && host.config.config.providerId.trim()
      ? host.config.config.providerId.trim().toLowerCase()
      : '';
  const fromOAuth =
    typeof (host as any).oauthProviderId === 'string' ? String((host as any).oauthProviderId).trim().toLowerCase() : '';
  return fromConfig === 'antigravity' || fromOAuth === 'antigravity';
}

export function getAntigravityHeaderMode(): 'minimal' | 'standard' | 'default' {
  const raw = (
    process.env.ROUTECODEX_ANTIGRAVITY_HEADER_MODE ||
    process.env.RCC_ANTIGRAVITY_HEADER_MODE ||
    ''
  )
    .trim()
    .toLowerCase();
  if (raw === 'minimal' || raw === 'standard') {
    return raw as 'minimal' | 'standard';
  }
  return 'default';
}

export function extractAntigravityAliasFromRuntime(
  host: MixinHostLike
): string | undefined {
  const runtime = host.getCurrentRuntimeMetadata();
  const candidates: string[] = [];
  if (runtime && typeof runtime.runtimeKey === 'string') {
    candidates.push(runtime.runtimeKey);
  }
  if (runtime && typeof runtime.providerKey === 'string') {
    candidates.push(runtime.providerKey);
  }
  for (const value of candidates) {
    const trimmed = value.trim();
    if (!trimmed.toLowerCase().startsWith('antigravity.')) {
      continue;
    }
    const parts = trimmed.split('.');
    if (parts.length >= 2 && parts[1] && parts[1].trim()) {
      return parts[1].trim();
    }
  }
  return undefined;
}

export function resolveAntigravityStableSessionId(
  metadata: Record<string, unknown> | undefined
): string | undefined {
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }
  const userIdCandidateRaw =
    typeof (metadata as any)?.user_id === 'string'
      ? String((metadata as any).user_id)
      : typeof (metadata as any)?.metadata?.user_id === 'string'
        ? String((metadata as any).metadata.user_id)
        : '';
  const userIdCandidate = userIdCandidateRaw.trim();
  if (!userIdCandidate) {
    return undefined;
  }
  if (userIdCandidate.toLowerCase().includes('session-')) {
    return undefined;
  }
  return userIdCandidate;
}

export function swapAntigravityRuntimeSessionId(
  host: MixinHostLike,
  effectiveSessionId: string,
  originalSessionId: string
): void {
  if (!isAntigravityRuntime(host)) {
    return;
  }
  const runtime = host.getCurrentRuntimeMetadata();
  const meta = runtime?.metadata;
  if (!meta || typeof meta !== 'object') {
    return;
  }
  const record = meta as Record<string, unknown>;
  if (!('__antigravitySessionIdRestore' in record)) {
    record.__antigravitySessionIdRestore =
      typeof record.antigravitySessionId === 'string' ? record.antigravitySessionId : null;
    record.__antigravitySessionIdOriginalRestore =
      typeof record.antigravitySessionIdOriginal === 'string'
        ? record.antigravitySessionIdOriginal
        : null;
  }
  record.antigravitySessionId = effectiveSessionId;
  record.antigravitySessionIdOriginal = originalSessionId;
}

export function restoreAntigravityRuntimeSessionId(host: MixinHostLike): void {
  if (!isAntigravityRuntime(host)) {
    return;
  }
  const runtime = host.getCurrentRuntimeMetadata();
  const meta = runtime?.metadata;
  if (!meta || typeof meta !== 'object') {
    return;
  }
  const record = meta as Record<string, unknown>;
  if (!('__antigravitySessionIdRestore' in record)) {
    return;
  }
  const restore = record.__antigravitySessionIdRestore;
  const restoreOriginal = record.__antigravitySessionIdOriginalRestore;
  delete record.__antigravitySessionIdRestore;
  delete record.__antigravitySessionIdOriginalRestore;
  if (typeof restore === 'string' && restore.trim().length) {
    record.antigravitySessionId = restore;
  } else {
    delete record.antigravitySessionId;
  }
  if (typeof restoreOriginal === 'string' && restoreOriginal.trim().length) {
    record.antigravitySessionIdOriginal = restoreOriginal;
  } else {
    delete record.antigravitySessionIdOriginal;
  }
}

export function wrapAntigravityHttpErrorAsResponse(
  error: unknown
): UnknownObject | null {
  const err = error as {
    statusCode?: unknown;
    status?: unknown;
    response?: { data?: unknown; raw?: unknown; status?: unknown };
    headers?: unknown;
    message?: unknown;
  };
  const status =
    typeof err?.statusCode === 'number'
      ? err.statusCode
      : typeof err?.status === 'number'
        ? err.status
        : typeof err?.response?.status === 'number'
          ? err.response.status
          : undefined;
  if (typeof status !== 'number' || !Number.isFinite(status)) {
    return null;
  }

  const message = typeof err?.message === 'string' ? err.message : String(err?.message ?? '');
  const looksLikeSignatureError =
    status === 429 ||
    (status === 400 && /signature/i.test(message));
  if (!looksLikeSignatureError) {
    return null;
  }

  const data =
    err?.response && typeof err.response === 'object' && 'data' in err.response
      ? (err.response as { data?: unknown }).data
      : undefined;
  const errorBody =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {
          error: {
            code: status,
            message: message || `HTTP ${status}`,
            status
          }
        };
  const headers =
    err?.headers && typeof err.headers === 'object' && !Array.isArray(err.headers)
      ? (err.headers as Record<string, unknown>)
      : undefined;

  return {
    status,
    ...(headers ? { headers } : {}),
    data: errorBody
  } as UnknownObject;
}
