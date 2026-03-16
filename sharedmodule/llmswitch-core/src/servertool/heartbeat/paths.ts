import path from "node:path";

import { readSessionDirEnv } from "../clock/paths.js";

function sanitizeSegment(value: string): string {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function looksLikePortScopedSessionDir(dirpath: string): boolean {
  const basename = path.basename(dirpath);
  return /^[^/\\]+_\d+$/.test(basename);
}

export function resolveHeartbeatStoreBaseDir(sessionDir: string): string {
  const normalized = path.resolve(String(sessionDir || "").trim());
  if (!normalized) {
    return normalized;
  }
  if (!looksLikePortScopedSessionDir(normalized)) {
    return normalized;
  }
  const parent = path.dirname(normalized);
  return parent && parent !== normalized ? parent : normalized;
}

export function resolveHeartbeatDir(sessionDir: string): string {
  return path.join(resolveHeartbeatStoreBaseDir(sessionDir), "heartbeat");
}

export function resolveLegacyHeartbeatDir(sessionDir: string): string | null {
  const normalized = path.resolve(String(sessionDir || "").trim());
  if (!normalized) {
    return null;
  }
  const legacyDir = path.join(normalized, "heartbeat");
  return legacyDir === resolveHeartbeatDir(normalized) ? null : legacyDir;
}

export function resolveHeartbeatStateFileInDir(
  dirpath: string,
  tmuxSessionId: string,
): string | null {
  const safe = sanitizeSegment(tmuxSessionId);
  if (!safe) {
    return null;
  }
  return path.join(dirpath, `${safe}.json`);
}

export function resolveHeartbeatStateFile(
  sessionDir: string,
  tmuxSessionId: string,
): string | null {
  return resolveHeartbeatStateFileInDir(resolveHeartbeatDir(sessionDir), tmuxSessionId);
}

export { readSessionDirEnv };
