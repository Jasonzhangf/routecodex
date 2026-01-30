/**
 * Antigravity OAuth helper utilities.
 * Resolves Antigravity project metadata via the Cloud Code Assist internal endpoints.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { UnknownObject } from '../../modules/pipeline/types/common-types.js';
import { logOAuthDebug } from './oauth-logger.js';

// Antigravity-Manager alignment: prefer Sandbox → Daily → Prod for Cloud Code Assist v1internal APIs.
const DEFAULT_ANTIGRAVITY_API_BASE_SANDBOX = 'https://daily-cloudcode-pa.sandbox.googleapis.com';
const DEFAULT_ANTIGRAVITY_API_BASE_DAILY = 'https://daily-cloudcode-pa.googleapis.com';
const DEFAULT_ANTIGRAVITY_API_BASE_AUTOPUSH = 'https://autopush-cloudcode-pa.sandbox.googleapis.com';
const DEFAULT_ANTIGRAVITY_API_BASE_PROD = 'https://cloudcode-pa.googleapis.com';
const DEFAULT_ANTIGRAVITY_API_BASE = DEFAULT_ANTIGRAVITY_API_BASE_SANDBOX;
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

const expandHome = (p: string): string => {
  if (!p || typeof p !== 'string') {
    return p;
  }
  if (p.startsWith('~/')) {
    const home = process.env.HOME || os.homedir() || '';
    return path.join(home, p.slice(2));
  }
  return p;
};

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = raw.trim() ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

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

function normalizeApiBase(value: string): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return '';
  }
  const noSlash = trimmed.replace(/\/+$/, '');
  return noSlash.replace(/\/v1internal$/i, '');
}

const normalizedBase = (base?: string): string => {
  const envBase =
    (process.env.ROUTECODEX_ANTIGRAVITY_API_BASE || process.env.RCC_ANTIGRAVITY_API_BASE || '').trim();
  const candidate = (base && base.trim()) || envBase || DEFAULT_ANTIGRAVITY_API_BASE;
  return normalizeApiBase(candidate);
};

export function resolveAntigravityApiBaseCandidates(explicit?: string): string[] {
  const envBase = normalizeApiBase(
    (process.env.ROUTECODEX_ANTIGRAVITY_API_BASE || process.env.RCC_ANTIGRAVITY_API_BASE || '').trim()
  );
  const explicitBase = normalizeApiBase(explicit || '');

  const isLocalHttp = (base: string): boolean => {
    const normalized = String(base || '').trim().toLowerCase();
    if (!normalized) return false;
    if (!normalized.startsWith('http://')) return false;
    return (
      normalized.includes('127.0.0.1') ||
      normalized.includes('localhost') ||
      normalized.includes('0.0.0.0')
    );
  };

  // Test/dev safety: when operator pins Antigravity base to a local HTTP endpoint,
  // never fall back to public Cloud Code Assist hosts (avoids accidental real calls).
  if (isLocalHttp(envBase) || isLocalHttp(explicitBase)) {
    const orderedLocal = [
      ...(envBase ? [envBase] : []),
      ...(explicitBase ? [explicitBase] : [])
    ]
      .map((base) => normalizeApiBase(base))
      .filter((base) => base.length);
    return Array.from(new Set(orderedLocal));
  }

  // Default order mirrors Antigravity-Manager: Sandbox → Daily → (Autopush) → Prod.
  // - We do NOT promote the caller's explicit base to the front because our config.v1/v2
  //   often pins `baseURL` to prod; promoting it would defeat the intent of this function.
  // - Env override is treated as an explicit operator choice and is placed first.
  const ordered = [
    ...(envBase ? [envBase] : []),
    DEFAULT_ANTIGRAVITY_API_BASE_SANDBOX,
    DEFAULT_ANTIGRAVITY_API_BASE_DAILY,
    DEFAULT_ANTIGRAVITY_API_BASE_AUTOPUSH,
    DEFAULT_ANTIGRAVITY_API_BASE_PROD,
    ...(explicitBase ? [explicitBase] : [])
  ]
    .map((base) => normalizeApiBase(base))
    .filter((base) => base.length);
  return Array.from(new Set(ordered));
}

function extractAccessTokenFromSnapshot(snapshot: Record<string, unknown>): string | undefined {
  const lower = (snapshot as { access_token?: unknown }).access_token;
  const upper = (snapshot as { AccessToken?: unknown }).AccessToken;
  const value =
    typeof lower === 'string'
      ? lower
      : typeof upper === 'string'
        ? upper
        : undefined;
  if (value && value.trim()) {
    return value.trim();
  }
  return undefined;
}

function hasProjectMetadata(snapshot: Record<string, unknown>): boolean {
  if (typeof (snapshot as { project_id?: unknown }).project_id === 'string' && (snapshot as { project_id?: string }).project_id) {
    return true;
  }
  if (typeof (snapshot as { projectId?: unknown }).projectId === 'string' && (snapshot as { projectId?: string }).projectId) {
    return true;
  }
  const projects = (snapshot as { projects?: unknown }).projects;
  if (Array.isArray(projects) && projects.length > 0) {
    const hasProject = projects.some((proj) => proj && typeof proj === 'object' && typeof (proj as { projectId?: unknown }).projectId === 'string');
    if (hasProject) {
      return true;
    }
  }
  return false;
}

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

export function buildAntigravityHeaders(accessToken: string): Record<string, string> {
  return buildHeaders(accessToken);
}

export function resolveAntigravityApiBase(explicit?: string): string {
  return normalizedBase(explicit);
}

export const ANTIGRAVITY_HELPER_DEFAULTS = {
  apiBase: DEFAULT_ANTIGRAVITY_API_BASE,
  userAgent: DEFAULT_USER_AGENT
};

export async function ensureAntigravityTokenProjectMetadata(
  tokenFilePath: string,
  apiBaseHint?: string
): Promise<boolean> {
  const resolved = expandHome(tokenFilePath);
  if (!resolved) {
    return false;
  }
  const snapshot = await readJsonFile(resolved);
  if (!snapshot) {
    return false;
  }
  if (hasProjectMetadata(snapshot)) {
    return true;
  }
  const accessToken = extractAccessTokenFromSnapshot(snapshot);
  if (!accessToken) {
    return false;
  }
  const projectId = await fetchAntigravityProjectId(accessToken, apiBaseHint);
  if (!projectId) {
    return false;
  }
  (snapshot as { project_id?: string }).project_id = projectId;
  (snapshot as { projectId?: string }).projectId = projectId;
  const projectsNode = (snapshot as { projects?: UnknownObject[] }).projects;
  if (!Array.isArray(projectsNode) || projectsNode.length === 0) {
    (snapshot as { projects?: { projectId: string }[] }).projects = [{ projectId }];
  } else {
    const exists = projectsNode.some(
      (proj) => proj && typeof proj === 'object' && typeof (proj as { projectId?: unknown }).projectId === 'string'
        ? (proj as { projectId?: string }).projectId === projectId
        : false
    );
    if (!exists) {
      projectsNode.push({ projectId });
    }
  }
  try {
    await fs.writeFile(resolved, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8');
    logOAuthDebug(`[OAuth] Antigravity: ensured project_id=${projectId} for ${resolved}`);
    return true;
  } catch (error) {
    logOAuthDebug(
      `[OAuth] Antigravity: failed to persist project_id for ${resolved} - ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return false;
  }
}
