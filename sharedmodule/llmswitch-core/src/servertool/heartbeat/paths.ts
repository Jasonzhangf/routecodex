import path from "node:path";

import { readSessionDirEnv } from "../clock/paths.js";

function sanitizeSegment(value: string): string {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function resolveHeartbeatDir(sessionDir: string): string {
  return path.join(sessionDir, "heartbeat");
}

export function resolveHeartbeatStateFile(
  sessionDir: string,
  tmuxSessionId: string,
): string | null {
  const safe = sanitizeSegment(tmuxSessionId);
  if (!safe) {
    return null;
  }
  return path.join(resolveHeartbeatDir(sessionDir), `${safe}.json`);
}

export { readSessionDirEnv };
