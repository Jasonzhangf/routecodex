/**
 * Antigravity OAuth helper utilities.
 * Mirrors the logic implemented in gcli2api for resolving project metadata.
 */

import type { UnknownObject } from '../../modules/pipeline/types/common-types.js';
import { logOAuthDebug } from './oauth-logger.js';

const DEFAULT_ANTIGRAVITY_API_BASE = 'https://daily-cloudcode-pa.sandbox.googleapis.com';
const DEFAULT_USER_AGENT = 'antigravity/1.11.3 windows/amd64';
const METADATA_PAYLOAD = {
  ideType: 'ANTIGRAVITY',
  platform: 'PLATFORM_UNSPECIFIED',
  pluginType: 'GEMINI'
};

type LoadResult = {
  projectId?: string;
  defaultTier?: string;
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const extractProjectId = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (value && typeof value === 'object') {
    const candidate = (value as { id?: unknown }).id;
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
};

const buildHeaders = (accessToken: string): Record<string, string> => ({
  'User-Agent': process.env.ROUTECODEX_ANTIGRAVITY_USER_AGENT?.trim() || DEFAULT_USER_AGENT,
  'Authorization': `Bearer ${accessToken}`,
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'Accept-Encoding': 'gzip, deflate, br'
});

const normalizedBase = (base?: string): string => {
  const envBase = process.env.ROUTECODEX_ANTIGRAVITY_API_BASE?.trim();
  const candidate = (base && base.trim()) || envBase || DEFAULT_ANTIGRAVITY_API_BASE;
  return candidate.replace(/\/+$/, '');
};

async function tryLoadCodeAssist(
  apiBase: string,
  headers: Record<string, string>
): Promise<LoadResult | undefined> {
  const requestUrl = `${apiBase}/v1internal:loadCodeAssist`;
  const response = await fetch(requestUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ metadata: METADATA_PAYLOAD })
  });

  if (!response.ok) {
    const preview = await response.text().catch(() => 'unknown error');
    throw new Error(`loadCodeAssist HTTP ${response.status} ${response.statusText} - ${preview.slice(0, 200)}`);
  }

  const data = (await response.json()) as UnknownObject;
  const projectNode = (data as { cloudaicompanionProject?: unknown }).cloudaicompanionProject;
  const projectId = extractProjectId(projectNode);
  if (projectId) {
    return { projectId };
  }

  const allowedTiers = Array.isArray((data as { allowedTiers?: unknown[] }).allowedTiers)
    ? ((data as { allowedTiers?: unknown[] }).allowedTiers as UnknownObject[])
    : [];
  let defaultTier: string | undefined;
  for (const tier of allowedTiers) {
    if (!tier || typeof tier !== 'object') {
      continue;
    }
    const tierId = typeof (tier as { id?: unknown }).id === 'string'
      ? String((tier as { id?: unknown }).id)
      : undefined;
    const isDefault = Boolean((tier as { isDefault?: boolean }).isDefault);
    if (!defaultTier && tierId) {
      defaultTier = tierId;
    }
    if (isDefault && tierId) {
      defaultTier = tierId;
      break;
    }
  }

  return { defaultTier };
}

async function tryOnboardUser(
  apiBase: string,
  headers: Record<string, string>,
  tierId: string
): Promise<string | undefined> {
  const requestUrl = `${apiBase}/v1internal:onboardUser`;
  const requestBody = {
    tierId,
    metadata: METADATA_PAYLOAD
  };

  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await fetch(requestUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const preview = await response.text().catch(() => 'unknown error');
      throw new Error(`onboardUser HTTP ${response.status} ${response.statusText} - ${preview.slice(0, 200)}`);
    }

    const data = (await response.json()) as UnknownObject;
    if (data?.done === true) {
      const responseNode = (data as { response?: UnknownObject }).response;
      const projectNode = responseNode
        ? (responseNode as { cloudaicompanionProject?: unknown }).cloudaicompanionProject
        : undefined;
      const projectId = extractProjectId(projectNode);
      return projectId;
    }

    await delay(2000);
  }

  return undefined;
}

export async function fetchAntigravityProjectId(
  accessToken: string,
  apiBase?: string
): Promise<string | undefined> {
  if (!accessToken?.trim()) {
    throw new Error('fetchAntigravityProjectId: access token is empty');
  }

  const base = normalizedBase(apiBase);
  const headers = buildHeaders(accessToken);
  logOAuthDebug(`[Antigravity] Resolving project_id via ${base}`);

  try {
    const loadResult = await tryLoadCodeAssist(base, headers);
    if (loadResult?.projectId) {
      logOAuthDebug(`[Antigravity] loadCodeAssist returned project_id=${loadResult.projectId}`);
      return loadResult.projectId;
    }

    const tier = loadResult?.defaultTier || 'LEGACY';
    logOAuthDebug(`[Antigravity] loadCodeAssist missing project_id, onboarding tier=${tier}`);
    const onboarded = await tryOnboardUser(base, headers, tier);
    if (onboarded) {
      logOAuthDebug(`[Antigravity] onboardUser returned project_id=${onboarded}`);
    }
    return onboarded;
  } catch (error) {
    logOAuthDebug(`[Antigravity] project_id resolution failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export function resolveAntigravityApiBase(explicit?: string): string {
  return normalizedBase(explicit);
}

export const ANTIGRAVITY_HELPER_DEFAULTS = {
  apiBase: DEFAULT_ANTIGRAVITY_API_BASE,
  userAgent: DEFAULT_USER_AGENT
};
