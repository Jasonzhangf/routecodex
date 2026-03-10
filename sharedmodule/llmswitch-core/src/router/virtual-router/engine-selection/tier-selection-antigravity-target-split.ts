import { splitAntigravityTargets } from './native-router-hotpath.js';

export function shouldAvoidAllAntigravityOnRetry(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') {
    return false;
  }
  const rtRaw = (metadata as Record<string, unknown>).__rt;
  if (!rtRaw || typeof rtRaw !== 'object' || Array.isArray(rtRaw)) {
    return false;
  }
  const rt = rtRaw as Record<string, unknown>;
  return rt.antigravityAvoidAllOnRetry === true;
}

export function shouldAvoidAntigravityAfterRepeatedError(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') {
    return false;
  }
  const rtRaw = (metadata as Record<string, unknown>).__rt;
  if (!rtRaw || typeof rtRaw !== 'object' || Array.isArray(rtRaw)) {
    return false;
  }
  const rt = rtRaw as Record<string, unknown>;
  if (rt.antigravityAvoidAllOnRetry === true) {
    return true;
  }
  const signature =
    typeof rt.antigravityRetryErrorSignature === 'string' ? rt.antigravityRetryErrorSignature.trim() : '';
  const consecutive =
    typeof rt.antigravityRetryErrorConsecutive === 'number' && Number.isFinite(rt.antigravityRetryErrorConsecutive)
      ? Math.max(0, Math.floor(rt.antigravityRetryErrorConsecutive))
      : 0;
  return signature.length > 0 && signature !== 'unknown' && consecutive >= 2;
}

export function preferNonAntigravityWhenPossible(candidates: string[]): string[] {
  if (!Array.isArray(candidates) || candidates.length < 2) {
    return candidates;
  }
  const nonAntigravity = splitAntigravityTargets(candidates).nonAntigravity;
  return nonAntigravity.length > 0 ? nonAntigravity : candidates;
}

export function extractNonAntigravityTargets(targets: string[]): string[] {
  if (!Array.isArray(targets) || targets.length === 0) {
    return [];
  }
  return splitAntigravityTargets(targets).nonAntigravity;
}
