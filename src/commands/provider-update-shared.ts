import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import { resolveRccProviderDir } from '../config/user-data-paths.js';
import type { UnknownRecord } from '../config/virtual-router-types.js';

export type ProviderUpdateAuth = {
  type: 'apikey' | 'oauth';
  apiKey?: string;
  headerName?: string;
  prefix?: string;
  tokenFile?: string;
  clientId?: string;
  clientSecret?: string;
  tokenUrl?: string;
  deviceCodeUrl?: string;
  scopes?: string[];
};

export type ProviderUpdateInput = {
  providerId: string;
  type: string;
  baseUrl?: string;
  baseURL?: string;
  auth?: ProviderUpdateAuth;
};

export function resolveProviderRoot(customRoot?: string): string {
  const trimmed = typeof customRoot === 'string' ? customRoot.trim() : '';
  if (trimmed) {
    return path.resolve(trimmed);
  }
  return resolveRccProviderDir();
}

export async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export function ask(question: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = defaultValue && defaultValue.trim().length
    ? `${question} [${defaultValue}]: `
    : `${question}: `;
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      const raw = String(answer || '').trim();
      resolve(raw || (defaultValue ?? ''));
    });
  });
}

export function askYesNo(question: string, defaultYes = true): Promise<boolean> {
  const suffix = defaultYes ? ' [Y/n]: ' : ' [y/N]: ';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}`, (answer) => {
      rl.close();
      const raw = String(answer || '').trim().toLowerCase();
      if (!raw) {
        resolve(defaultYes);
        return;
      }
      resolve(raw === 'y' || raw === 'yes');
    });
  });
}

export function splitCsv(raw?: unknown): string[] {
  return typeof raw === 'string' && raw.trim()
    ? raw.split(',').map((item) => item.trim()).filter(Boolean)
    : [];
}

export function splitTokenThresholds(raw?: unknown): number[] {
  const parts = splitCsv(raw);
  const out: number[] = [];
  for (const part of parts) {
    const n = Math.floor(Number(part));
    if (Number.isFinite(n) && n > 0) {
      out.push(n);
    }
  }
  return out;
}

export function parseUniqueModelIds(raw: string, fallback?: string): string[] {
  const parts = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const unique = Array.from(new Set(parts));
  if (unique.length > 0) {
    return unique;
  }
  const fallbackModel = typeof fallback === 'string' ? fallback.trim() : '';
  return fallbackModel ? [fallbackModel] : [];
}

export function normalizeEnvVarName(providerId: string): string {
  const normalized = providerId
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return normalized ? `${normalized}_API_KEY` : 'PROVIDER_API_KEY';
}

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: string[] = [];
  for (const entry of value) {
    const item = readString(entry);
    if (item) {
      out.push(item);
    }
  }
  return out.length ? out : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function extractApiKeyFromAuthNode(authNode: Record<string, unknown>): string | undefined {
  const direct = readString(authNode.apiKey);
  if (direct) {
    return direct;
  }
  const keys = authNode.keys;
  if (!isRecord(keys)) {
    return undefined;
  }
  for (const entry of Object.values(keys)) {
    if (!isRecord(entry)) {
      continue;
    }
    const value = readString(entry.value);
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function normalizeAuthForProviderUpdate(authNodeValue: unknown): ProviderUpdateAuth | undefined {
  if (!isRecord(authNodeValue)) {
    return undefined;
  }
  const authTypeRaw = readString(authNodeValue.type) ?? '';
  const authType = authTypeRaw.toLowerCase();

  if (authType.includes('oauth')) {
    return {
      type: 'oauth',
      tokenFile: readString(authNodeValue.tokenFile),
      clientId: readString(authNodeValue.clientId),
      clientSecret: readString(authNodeValue.clientSecret),
      tokenUrl: readString(authNodeValue.tokenUrl),
      deviceCodeUrl: readString(authNodeValue.deviceCodeUrl),
      scopes: readStringArray(authNodeValue.scopes)
    };
  }

  if (authType.includes('apikey') || authType === 'api_key' || authType === 'apikey') {
    return {
      type: 'apikey',
      apiKey: extractApiKeyFromAuthNode(authNodeValue),
      headerName: readString(authNodeValue.headerName),
      prefix: readString(authNodeValue.prefix)
    };
  }

  return undefined;
}

export function buildProviderUpdateInputFromV2(providerId: string, provider: UnknownRecord): ProviderUpdateInput {
  const type = readString((provider as { type?: unknown }).type) ?? providerId;
  const baseURL = readString((provider as { baseURL?: unknown }).baseURL) ?? readString((provider as { baseUrl?: unknown }).baseUrl);
  const baseUrl = readString((provider as { baseUrl?: unknown }).baseUrl) ?? readString((provider as { baseURL?: unknown }).baseURL);
  const auth = normalizeAuthForProviderUpdate((provider as { auth?: unknown }).auth);
  return { providerId, type, baseURL, baseUrl, auth };
}

export function authTypeUsesCredentialFile(authTypeRaw: string): boolean {
  const authType = authTypeRaw.trim().toLowerCase();
  return authType.includes('oauth') || authType.includes('cookie') || authType.includes('account');
}

export function readCredentialFileFromAuthNode(authNode: UnknownRecord): string {
  return readString(authNode.tokenFile) || readString(authNode.cookieFile) || (Array.isArray(authNode.entries) && isRecord(authNode.entries[0]) ? readString((authNode.entries[0] as UnknownRecord).tokenFile) || '' : '') || '';
}

export function normalizeModelsNode(node: unknown): Record<string, UnknownRecord> {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return {};
  }
  return node as Record<string, UnknownRecord>;
}

export function countRouteTargets(routeNode: unknown): number {
  if (!Array.isArray(routeNode) || routeNode.length === 0) {
    return 0;
  }
  const targets = new Set<string>();
  for (const pool of routeNode) {
    if (!isRecord(pool)) {
      continue;
    }
    const poolTargets = Array.isArray(pool.targets) ? pool.targets : [];
    for (const target of poolTargets) {
      if (typeof target === 'string' && target.trim()) {
        targets.add(target.trim());
      }
    }
  }
  return targets.size;
}

export const __providerUpdateTestables = {
  splitCsv,
  splitTokenThresholds,
  parseUniqueModelIds,
  normalizeEnvVarName,
  readString,
  readStringArray,
  isRecord,
  extractApiKeyFromAuthNode,
  normalizeAuthForProviderUpdate,
  buildProviderUpdateInputFromV2,
  authTypeUsesCredentialFile,
  readCredentialFileFromAuthNode,
  normalizeModelsNode
};
