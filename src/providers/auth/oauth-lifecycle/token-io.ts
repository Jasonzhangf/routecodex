/**
 * Token IO
 *
 * Token file read/write operations.
 */

import fs from 'fs/promises';
import type { UnknownObject } from '../../../modules/pipeline/types/common-types.js';
import { logOAuthDebug } from '../oauth-logger.js';
import {
  type StoredOAuthToken,
  hasNonEmptyString
} from './token-helpers.js';

export function normalizeGeminiCliAccountToken(token: UnknownObject): StoredOAuthToken | null {
  const raw = token as { token?: UnknownObject };
  const tokenNode = raw.token;
  if (!tokenNode || typeof tokenNode !== 'object') {
    return null;
  }
  const tokenObj = tokenNode as UnknownObject;
  const access = tokenObj.access_token;
  if (!hasNonEmptyString(access)) {
    return null;
  }

  const out = { ...(tokenObj as StoredOAuthToken) };
  const root = token as UnknownObject;

  if (typeof root.disabled === 'boolean') out.disabled = root.disabled;
  if (typeof root.disabled_reason === 'string') out.disabled_reason = root.disabled_reason;
  if (typeof root.disabled_at === 'number' || typeof root.disabled_at === 'string') out.disabled_at = root.disabled_at;

  if (typeof root.proxy_disabled === 'boolean') out.proxy_disabled = root.proxy_disabled;
  if (typeof root.proxyDisabled === 'boolean') out.proxyDisabled = root.proxyDisabled;
  if (typeof root.proxy_disabled_reason === 'string') out.proxy_disabled_reason = root.proxy_disabled_reason;
  if (typeof root.proxy_disabled_at === 'number' || typeof root.proxy_disabled_at === 'string') {
    out.proxy_disabled_at = root.proxy_disabled_at;
  }

  if (Array.isArray(root.protected_models)) out.protected_models = root.protected_models;
  if (Array.isArray(root.protectedModels)) out.protectedModels = root.protectedModels;

  if (!hasNonEmptyString(out.project_id) && hasNonEmptyString(root.project_id)) {
    out.project_id = String(root.project_id);
  }
  if (!hasNonEmptyString(out.projectId) && hasNonEmptyString(root.projectId)) {
    out.projectId = String(root.projectId);
  }
  if (!Array.isArray(out.projects) && Array.isArray(root.projects)) {
    out.projects = root.projects;
  }
  if (!hasNonEmptyString(out.email) && hasNonEmptyString(root.email)) {
    out.email = String(root.email);
  }

  const expiryTimestamp = (tokenObj as { expiry_timestamp?: unknown }).expiry_timestamp;
  if (!hasNonEmptyString(out.expires_at) && typeof expiryTimestamp === 'number') {
    out.expires_at = expiryTimestamp > 10_000_000_000 ? expiryTimestamp : expiryTimestamp * 1000;
  }

  return out;
}

export function sanitizeToken(token: UnknownObject | null): StoredOAuthToken | null {
  if (!token || typeof token !== 'object') {
    return null;
  }
  const normalized = normalizeGeminiCliAccountToken(token);
  if (normalized) {
    return normalized;
  }
  const copy = { ...token } as StoredOAuthToken;
  if (!hasNonEmptyString(copy.apiKey) && hasNonEmptyString(copy.api_key)) {
    copy.apiKey = copy.api_key;
  }
  return copy;
}

export async function readTokenFromFile(file: string): Promise<StoredOAuthToken | null> {
  try {
    const txt = await fs.readFile(file, 'utf-8');
    return sanitizeToken(JSON.parse(txt) as UnknownObject);
  } catch {
    return null;
  }
}

export async function backupTokenFile(file: string): Promise<string | null> {
  if (!file) {
    return null;
  }
  try {
    await fs.access(file);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  const backup = `${file}.${Date.now()}.bak`;
  try {
    await fs.copyFile(file, backup);
    logOAuthDebug(`[OAuth] token.backup: ${backup}`);
    return backup;
  } catch (error) {
    logOAuthDebug(
      `[OAuth] token.backup failed (${file}): ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

export async function restoreTokenFileFromBackup(backupFile: string | null, target: string): Promise<void> {
  if (!backupFile) {
    return;
  }
  try {
    await fs.copyFile(backupFile, target);
    logOAuthDebug(`[OAuth] token.restore: ${target}`);
  } catch (error) {
    logOAuthDebug(
      `[OAuth] token.restore failed (${target}): ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    try {
      await fs.unlink(backupFile);
    } catch {
      // ignore cleanup failure
    }
  }
}

export async function discardBackupFile(backupFile: string | null): Promise<void> {
  if (!backupFile) {
    return;
  }
  try {
    await fs.unlink(backupFile);
  } catch {
    // ignore
  }
}

export async function readRawTokenFile(file: string): Promise<UnknownObject | null> {
  if (!file) {
    return null;
  }
  try {
    const txt = await fs.readFile(file, 'utf-8');
    const parsed = JSON.parse(txt) as UnknownObject;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
