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
  resetAntigravitySessionSignatureCachesForTests?: () => void;
  configureAntigravitySessionSignaturePersistence?: (input: { stateDir: string; fileName?: string } | null) => void;
  flushAntigravitySessionSignaturePersistenceSync?: () => void;
};

let cachedAntigravitySignatureModule: AntigravitySessionSignatureModule | null = null;
let antigravitySignatureModuleWarmupPromise: Promise<AntigravitySessionSignatureModule | null> | null = null;

function loadAntigravitySignatureModule(): AntigravitySessionSignatureModule | null {
  if (cachedAntigravitySignatureModule) {
    return cachedAntigravitySignatureModule;
  }
  try {
    cachedAntigravitySignatureModule = requireCoreDist<AntigravitySessionSignatureModule>(
      'conversion/compat/antigravity-session-signature'
    );
  } catch {
    cachedAntigravitySignatureModule = null;
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
      } catch {
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
  } catch {
    return undefined;
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
  } catch {
    // best-effort only
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
  } catch {
    return undefined;
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
  } catch {
    return undefined;
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
  } catch {
    // best-effort only
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
  } catch {
    // best-effort only
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
  } catch {
    // best-effort only
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
  } catch {
    // best-effort only
  }
}
