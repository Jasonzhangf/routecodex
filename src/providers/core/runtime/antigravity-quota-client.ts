import fs from 'node:fs/promises';
import os from 'node:os';
import axios from 'axios';

import type { UnknownObject } from '../../../types/common-types.js';
import { buildAntigravityHeaders } from '../../auth/antigravity-userinfo-helper.js';

export interface AntigravityModelQuotaInfo {
  remainingFraction: number;
  resetTimeRaw?: string;
}

export interface AntigravityQuotaSnapshot {
  models: Record<string, AntigravityModelQuotaInfo>;
  fetchedAt: number;
}

function expandHome(p: string): string {
  if (!p || typeof p !== 'string') {
    return p;
  }
  if (p.startsWith('~/')) {
    return p.replace(/^~\//, `${os.homedir()}/`);
  }
  return p;
}

async function readJsonFile(filePath: string): Promise<UnknownObject | null> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const parsed = content.trim() ? JSON.parse(content) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as UnknownObject) : {};
  } catch {
    return null;
  }
}

function extractAccessToken(snapshot: UnknownObject | null): string | undefined {
  if (!snapshot) {
    return undefined;
  }
  const lower = (snapshot as { access_token?: unknown }).access_token;
  const upper = (snapshot as { AccessToken?: unknown }).AccessToken;
  const raw =
    (typeof lower === 'string' && lower.trim()) ||
    (typeof upper === 'string' && upper.trim()) ||
    '';
  return raw || undefined;
}

export async function loadAntigravityAccessToken(tokenFile: string): Promise<string | undefined> {
  const resolved = expandHome(tokenFile);
  const snapshot = await readJsonFile(resolved);
  return extractAccessToken(snapshot);
}

export async function fetchAntigravityQuotaSnapshot(
  apiBase: string,
  accessToken: string
): Promise<AntigravityQuotaSnapshot | null> {
  const base = apiBase.replace(/\/+$/, '');
  const url = `${base}/v1internal:fetchAvailableModels`;
  try {
    const headers = buildAntigravityHeaders(accessToken);
    const resp = await axios.post(
      url,
      {},
      {
        headers,
        timeout: 30_000
      }
    );
    const data = resp.data as UnknownObject;
    const modelsNode = (data as { models?: unknown }).models;
    const models: Record<string, AntigravityModelQuotaInfo> = {};
    if (modelsNode && typeof modelsNode === 'object' && !Array.isArray(modelsNode)) {
      for (const [modelId, raw] of Object.entries(modelsNode as Record<string, unknown>)) {
        if (!raw || typeof raw !== 'object') {
          continue;
        }
        const quota = (raw as { quotaInfo?: unknown }).quotaInfo;
        if (!quota || typeof quota !== 'object') {
          continue;
        }
        const q = quota as { remainingFraction?: unknown; resetTime?: unknown };
        const resetTimeRaw =
          typeof q.resetTime === 'string' && q.resetTime.trim().length ? q.resetTime.trim() : undefined;
        const remainingRaw = q.remainingFraction;
        const remaining =
          typeof remainingRaw === 'number'
            ? remainingRaw
            : typeof remainingRaw === 'string'
              ? Number.parseFloat(remainingRaw)
              : // Some Antigravity credentials omit remainingFraction when exhausted but still provide resetTime.
                // Treat it as 0 so quota manager can gate routing correctly.
                resetTimeRaw
                ? 0
                : NaN;
        if (Number.isNaN(remaining)) {
          continue;
        }
        models[modelId] = {
          remainingFraction: remaining,
          resetTimeRaw
        };
      }
    }
    return {
      models,
      fetchedAt: Date.now()
    };
  } catch {
    return null;
  }
}
