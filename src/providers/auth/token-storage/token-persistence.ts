/**
 * Token Persistence
 *
 * Handles reading, writing, and backup of token files.
 */

import fs from 'fs/promises';
import type { UnknownObject } from '../../../modules/pipeline/types/common-types.js';
import { sanitizeToken, type StoredOAuthToken } from '../oauth-token-utils.js';
import { logOAuthDebug } from '../oauth-logger.js';

/**
 * Read and parse token from file
 */
export async function readTokenFromFile(file: string): Promise<StoredOAuthToken | null> {
  try {
    const txt = await fs.readFile(file, 'utf-8');
    return sanitizeToken(JSON.parse(txt) as UnknownObject);
  } catch {
    return null;
  }
}

/**
 * Backup token file before modification
 */
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

/**
 * Restore token from backup
 */
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

/**
 * Discard backup file
 */
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