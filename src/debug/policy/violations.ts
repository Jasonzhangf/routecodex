import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'os';

export interface PolicyViolationRecord {
  file: string;
  timestamp: string;
  violations: unknown[];
  removedTopLevelKeys: string[];
  flattenedWrappers: string[];
  summary?: Record<string, unknown>;
}

export function resolvePolicyViolationsRoot(customRoot?: string): string {
  if (customRoot && customRoot.trim()) {
    return path.resolve(customRoot);
  }
  return path.join(os.homedir(), '.routecodex', 'errorsamples', 'policy');
}

export async function listPolicyViolationFiles(rootDir?: string, sinceHours?: number): Promise<string[]> {
  const root = resolvePolicyViolationsRoot(rootDir);
  let entries: string[];
  try {
    entries = await fsp.readdir(root);
  } catch {
    return [];
  }
  const cutoff = sinceHours ? Date.now() - sinceHours * 3600_000 : 0;
  const files: string[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const fullPath = path.join(root, name);
    if (cutoff > 0) {
      const stat = await fsp.stat(fullPath);
      if (stat.mtimeMs < cutoff) continue;
    }
    files.push(fullPath);
  }
  return files.sort();
}

export async function readPolicyViolationRecord(filePath: string): Promise<PolicyViolationRecord | null> {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      file: filePath,
      timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : new Date().toISOString(),
      violations: Array.isArray(parsed.violations) ? parsed.violations : [],
      removedTopLevelKeys: Array.isArray(parsed.removedTopLevelKeys) ? parsed.removedTopLevelKeys : [],
      flattenedWrappers: Array.isArray(parsed.flattenedWrappers) ? parsed.flattenedWrappers : [],
      summary: typeof parsed.summary === 'object' && parsed.summary ? parsed.summary as Record<string, unknown> : undefined,
    };
  } catch {
    return null;
  }
}

export async function collectPolicyViolations(options: { rootDir?: string; sinceHours?: number; limit?: number } = {}): Promise<PolicyViolationRecord[]> {
  const files = await listPolicyViolationFiles(options.rootDir, options.sinceHours);
  const records: PolicyViolationRecord[] = [];
  for (const file of files) {
    const record = await readPolicyViolationRecord(file);
    if (record) records.push(record);
    if (options.limit && records.length >= options.limit) break;
  }
  return records;
}
