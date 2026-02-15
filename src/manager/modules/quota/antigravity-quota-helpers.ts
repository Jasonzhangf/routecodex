import fsAsync from 'node:fs/promises';

export type ParsedAntigravityProviderKey = {
  alias: string;
  modelId: string;
};

export function buildAntigravitySnapshotKey(alias: string, modelId: string): string {
  return `antigravity://${alias}/${modelId}`;
}

export function parseAntigravitySnapshotKey(key: string): { alias: string; modelId: string } | null {
  const raw = typeof key === 'string' ? key.trim() : '';
  if (!raw.toLowerCase().startsWith('antigravity://')) {
    return null;
  }
  const rest = raw.slice('antigravity://'.length);
  const idx = rest.indexOf('/');
  if (idx <= 0) {
    return null;
  }
  const alias = rest.slice(0, idx).trim();
  const modelId = rest.slice(idx + 1).trim();
  if (!alias || !modelId) {
    return null;
  }
  return { alias, modelId };
}

export function parseAntigravityProviderKey(providerKey?: string): ParsedAntigravityProviderKey | null {
  if (!providerKey || typeof providerKey !== 'string') {
    return null;
  }
  const trimmed = providerKey.trim();
  if (!trimmed.toLowerCase().startsWith('antigravity.')) {
    return null;
  }
  const segments = trimmed.split('.');
  if (segments.length < 3) {
    return null;
  }
  const alias = String(segments[1] || '').trim();
  const modelId = String(segments.slice(2).join('.') || '').trim();
  if (!alias || !modelId) {
    return null;
  }
  return { alias, modelId };
}

export function extractAntigravityAlias(providerKey?: string): string | null {
  if (!providerKey || typeof providerKey !== 'string') {
    return null;
  }
  const trimmed = providerKey.trim();
  if (!trimmed.toLowerCase().startsWith('antigravity.')) {
    return null;
  }
  const segments = trimmed.split('.');
  if (segments.length < 2) {
    return null;
  }
  return segments[1];
}

export function computeResetAt(raw?: string): number | undefined {
  if (!raw || typeof raw !== 'string' || !raw.trim()) {
    return undefined;
  }
  const value = raw.trim();
  try {
    const normalized = value.endsWith('Z') ? value.replace(/Z$/, '+00:00') : value;
    const parsed = Date.parse(normalized);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function normalizeProtectedModelFlag(raw: string): string[] {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return [];
  }
  if (normalized.startsWith('gemini-3-pro-image') || normalized.includes('pro-image')) {
    return ['gemini-3-pro-image'];
  }
  if (normalized === 'gemini-pro' || normalized === 'gemini-3-pro-high') {
    return ['gemini-pro', 'gemini-3-pro-high'];
  }
  if (normalized === 'gemini-flash' || normalized === 'gemini-3-flash') {
    return ['gemini-flash', 'gemini-3-flash'];
  }
  if (
    normalized === 'claude' ||
    normalized.includes('claude') ||
    normalized.includes('sonnet') ||
    normalized.includes('opus') ||
    normalized.includes('haiku')
  ) {
    return ['claude'];
  }
  return [normalized];
}

export function resolveProtectedModelCandidates(modelId: string): Set<string> {
  const normalized = String(modelId || '').trim().toLowerCase();
  const candidates = new Set<string>();
  if (!normalized) {
    return candidates;
  }
  candidates.add(normalized);
  if (normalized.startsWith('gemini-3-pro-image') || normalized.includes('pro-image')) {
    candidates.add('gemini-3-pro-image');
  }
  if (normalized.includes('flash')) {
    candidates.add('gemini-flash');
    candidates.add('gemini-3-flash');
  }
  if (normalized.includes('pro') && !normalized.includes('image')) {
    candidates.add('gemini-pro');
    candidates.add('gemini-3-pro-high');
  }
  if (
    normalized.includes('claude') ||
    normalized.includes('sonnet') ||
    normalized.includes('opus') ||
    normalized.includes('haiku')
  ) {
    candidates.add('claude');
  }
  return candidates;
}

export async function readProtectedModelsFromTokenFile(tokenFile: string): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const raw = await fsAsync.readFile(tokenFile, 'utf8');
    const parsed = JSON.parse(String(raw || '').trim() || 'null') as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return out;
    }
    const nodes: Array<Record<string, unknown>> = [parsed];
    if (parsed.token && typeof parsed.token === 'object' && !Array.isArray(parsed.token)) {
      nodes.push(parsed.token as Record<string, unknown>);
    }
    for (const node of nodes) {
      const rawModels =
        Array.isArray(node.protected_models)
          ? node.protected_models
          : Array.isArray(node.protectedModels)
            ? node.protectedModels
            : [];
      for (const item of rawModels) {
        if (typeof item !== 'string') {
          continue;
        }
        for (const normalized of normalizeProtectedModelFlag(item)) {
          out.add(normalized);
        }
      }
    }
    return out;
  } catch {
    return out;
  }
}

export function isAntigravityModelProtected(
  protectedModelsByAlias: Map<string, Set<string>>,
  alias: string,
  modelId: string
): boolean {
  const protectedModels = protectedModelsByAlias.get(alias);
  if (!protectedModels || protectedModels.size === 0) {
    return false;
  }
  const candidates = resolveProtectedModelCandidates(modelId);
  for (const candidate of candidates) {
    if (protectedModels.has(candidate)) {
      return true;
    }
  }
  return false;
}
