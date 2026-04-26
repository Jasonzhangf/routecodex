/**
 * Antigravity Session Signature Bridge
 *
 * Antigravity session signature extraction and caching.
 */

import { importCoreDist, requireCoreDist } from './module-loader.js';

type AntigravitySessionSignatureModule = {
  extractAntigravityGeminiSessionId?: (payload: unknown) => string;
  cacheAntigravitySessionSignature?: (...args: unknown[]) => void;
  getAntigravityLatestSignatureSessionIdForAlias?: (aliasKey: string, options?: { hydrate?: boolean }) => string | undefined;
  lookupAntigravitySessionSignatureEntry?: (aliasKey: string, sessionId: string, options?: { hydrate?: boolean }) => unknown;
  invalidateAntigravitySessionSignature?: (aliasKey: string, sessionId: string) => void;
  clearAntigravitySessionAliasPins?: (options?: { hydrate?: boolean }) => { clearedBySession: number; clearedByAlias: number };
  resetAntigravitySessionSignatureCachesForTests?: () => void;
  configureAntigravitySessionSignaturePersistence?: (input: { stateDir: string; fileName?: string } | null) => void;
  flushAntigravitySessionSignaturePersistenceSync?: () => void;
};

let cachedAntigravitySignatureModule: AntigravitySessionSignatureModule | null = null;
let antigravitySignatureModuleWarmupPromise: Promise<AntigravitySessionSignatureModule | null> | null = null;

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

function logAntigravitySignatureNonBlocking(
  stage: string,
  error: unknown,
  details?: Record<string, unknown>
): void {
  try {
    const suffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(`[antigravity-signature] ${stage} failed (non-blocking): ${formatUnknownError(error)}${suffix}`);
  } catch {
    void 0;
  }
}

function loadAntigravitySignatureModule(): AntigravitySessionSignatureModule | null {
  if (cachedAntigravitySignatureModule) {
    return cachedAntigravitySignatureModule;
  }
  try {
    cachedAntigravitySignatureModule = requireCoreDist<AntigravitySessionSignatureModule>(
      'conversion/compat/antigravity-session-signature'
    );
  } catch (requireError) {
    logAntigravitySignatureNonBlocking('loadAntigravitySignatureModule.requireCoreDist', requireError);
    // Do NOT cache null here — a transient require failure must not permanently
    // disable the module for the lifetime of the process.  Next call will retry.
  }
  return cachedAntigravitySignatureModule;
}

export async function warmupAntigravitySessionSignatureModule(): Promise<void> {
  if (cachedAntigravitySignatureModule) {
    return;
  }
  if (!antigravitySignatureModuleWarmupPromise) {
    antigravitySignatureModuleWarmupPromise = (async () => {
      try {
        return await importCoreDist<AntigravitySessionSignatureModule>('conversion/compat/antigravity-session-signature');
      } catch (importError) {
        logAntigravitySignatureNonBlocking('warmupAntigravitySessionSignatureModule.importCoreDist', importError);
        return null;
      }
    })();
  }
  try {
    cachedAntigravitySignatureModule = await antigravitySignatureModuleWarmupPromise;
  } finally {
    antigravitySignatureModuleWarmupPromise = null;
  }
}

export function extractAntigravityGeminiSessionId(payload: unknown): string | undefined {
  const mod = loadAntigravitySignatureModule();
  const fn = mod?.extractAntigravityGeminiSessionId;
  if (typeof fn !== 'function') {
    return undefined;
  }
  try {
    return fn(payload);
  } catch (extractError) {
    logAntigravitySignatureNonBlocking('extractAntigravityGeminiSessionId', extractError);
    throw extractError;
  }
}

export function cacheAntigravitySessionSignature(aliasKey: string, sessionId: string, signature: string, messageCount?: number): void;
export function cacheAntigravitySessionSignature(sessionId: string, signature: string, messageCount?: number): void;
export function cacheAntigravitySessionSignature(a: string, b: string, c?: string | number, d = 1): void {
  const mod = loadAntigravitySignatureModule();
  const fn = mod?.cacheAntigravitySessionSignature;
  if (typeof fn !== 'function') {
    return;
  }
  const supportsAliasKey =
    typeof (mod as any)?.getAntigravitySessionSignature === 'function' &&
    ((mod as any).getAntigravitySessionSignature as (...args: unknown[]) => unknown).length >= 2;
  const isNewSignature = typeof c === 'string';
  const aliasKey = isNewSignature ? a : 'antigravity.unknown';
  const sessionId = isNewSignature ? b : a;
  const signature = isNewSignature ? (c as string) : b;
  const messageCount = typeof c === 'number' ? c : typeof d === 'number' ? d : 1;
  try {
    if (isNewSignature && supportsAliasKey) {
      fn(aliasKey, sessionId, signature, messageCount);
    } else {
      fn(sessionId, signature, messageCount);
    }
  } catch (cacheError) {
    logAntigravitySignatureNonBlocking('cacheAntigravitySessionSignature', cacheError, {
      aliasKey,
      sessionId
    });
  }
}

export function getAntigravityLatestSignatureSessionIdForAlias(
  aliasKey: string,
  options?: { hydrate?: boolean }
): string | undefined {
  const mod = loadAntigravitySignatureModule();
  const fn = mod?.getAntigravityLatestSignatureSessionIdForAlias;
  if (typeof fn !== 'function') {
    return undefined;
  }
  try {
    const out = fn(aliasKey, options);
    return typeof out === 'string' && out.trim().length ? out.trim() : undefined;
  } catch (lookupLatestError) {
    logAntigravitySignatureNonBlocking('getAntigravityLatestSignatureSessionIdForAlias', lookupLatestError, {
      aliasKey
    });
    throw lookupLatestError;
  }
}

export function lookupAntigravitySessionSignatureEntry(
  aliasKey: string,
  sessionId: string,
  options?: { hydrate?: boolean }
): Record<string, unknown> | undefined {
  const mod = loadAntigravitySignatureModule();
  const fn = mod?.lookupAntigravitySessionSignatureEntry;
  if (typeof fn !== 'function') {
    return undefined;
  }
  try {
    const out = fn(aliasKey, sessionId, options);
    return out && typeof out === 'object' ? (out as Record<string, unknown>) : undefined;
  } catch (lookupEntryError) {
    logAntigravitySignatureNonBlocking('lookupAntigravitySessionSignatureEntry', lookupEntryError, {
      aliasKey,
      sessionId
    });
    throw lookupEntryError;
  }
}

export function invalidateAntigravitySessionSignature(aliasKey: string, sessionId: string): void {
  const mod = loadAntigravitySignatureModule();
  const fn = mod?.invalidateAntigravitySessionSignature;
  if (typeof fn !== 'function') {
    return;
  }
  try {
    fn(aliasKey, sessionId);
  } catch (invalidateError) {
    logAntigravitySignatureNonBlocking('invalidateAntigravitySessionSignature', invalidateError, {
      aliasKey,
      sessionId
    });
  }
}

export function clearAntigravitySessionAliasPins(options?: { hydrate?: boolean }): {
  clearedBySession: number;
  clearedByAlias: number;
} {
  const mod = loadAntigravitySignatureModule();
  const fn = mod?.clearAntigravitySessionAliasPins;
  if (typeof fn !== 'function') {
    return { clearedBySession: 0, clearedByAlias: 0 };
  }
  try {
    const out = fn(options);
    const clearedBySession = typeof out?.clearedBySession === 'number' && Number.isFinite(out.clearedBySession)
      ? Math.max(0, Math.floor(out.clearedBySession))
      : 0;
    const clearedByAlias = typeof out?.clearedByAlias === 'number' && Number.isFinite(out.clearedByAlias)
      ? Math.max(0, Math.floor(out.clearedByAlias))
      : 0;
    return { clearedBySession, clearedByAlias };
  } catch (clearPinsError) {
    logAntigravitySignatureNonBlocking('clearAntigravitySessionAliasPins', clearPinsError);
    return { clearedBySession: 0, clearedByAlias: 0 };
  }
}

export function resetAntigravitySessionSignatureCachesForTests(): void {
  const mod = loadAntigravitySignatureModule();
  const fn = mod?.resetAntigravitySessionSignatureCachesForTests;
  if (typeof fn !== 'function') {
    return;
  }
  try {
    fn();
  } catch (resetError) {
    logAntigravitySignatureNonBlocking('resetAntigravitySessionSignatureCachesForTests', resetError);
  }
}

export function configureAntigravitySessionSignaturePersistence(input: { stateDir: string; fileName?: string } | null): void {
  const mod = loadAntigravitySignatureModule();
  const fn = mod?.configureAntigravitySessionSignaturePersistence;
  if (typeof fn !== 'function') {
    return;
  }
  try {
    fn(input);
  } catch (configureError) {
    logAntigravitySignatureNonBlocking('configureAntigravitySessionSignaturePersistence', configureError);
  }
}

export function flushAntigravitySessionSignaturePersistenceSync(): void {
  const mod = loadAntigravitySignatureModule();
  const fn = mod?.flushAntigravitySessionSignaturePersistenceSync;
  if (typeof fn !== 'function') {
    return;
  }
  try {
    fn();
  } catch (flushError) {
    logAntigravitySignatureNonBlocking('flushAntigravitySessionSignaturePersistenceSync', flushError);
  }
}
