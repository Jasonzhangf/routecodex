import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

import type { QuotaRecord } from '../manager/modules/quota/index.js';

interface QuotaStateFile {
  [key: string]: QuotaRecord;
}

/**
 * Quota 状态文件采用全局单份，不再区分 serverId。
 * 为了兼容现有 CLI 选项，`serverId` 参数被忽略。
 */
function resolveQuotaStatePath(_serverId?: string): string {
  return path.join(homedir(), '.routecodex', 'state', 'quota', 'antigravity.json');
}

function loadQuotaSnapshot(filePath: string): QuotaStateFile | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const txt = fs.readFileSync(filePath, 'utf8');
    const parsed = txt.trim() ? JSON.parse(txt) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as QuotaStateFile;
  } catch {
    return null;
  }
}

export function createQuotaStatusCommand(): Command {
  const cmd = new Command('quota');

  cmd
    .description('Show current quota snapshot for antigravity tokens (daemon-managed)')
    .option('--server-id <id>', 'Server id used by daemon (default: host:port or "default")')
    .option('--json', 'Output raw JSON', false)
    .action((opts: { serverId?: string; json?: boolean }) => {
      const filePath = resolveQuotaStatePath(opts.serverId);
      const snapshot = loadQuotaSnapshot(filePath);
      if (opts.json) {
        const payload = snapshot ?? {};
        console.log(JSON.stringify({ file: filePath, quota: payload }, null, 2));
        return;
      }
      if (!snapshot || Object.keys(snapshot).length === 0) {
        console.log(`No quota snapshot found at ${filePath}`);
        return;
      }

      console.log(`Quota snapshot from ${filePath}:`);
      const now = Date.now();
      const entries = Object.entries(snapshot).sort(([a], [b]) => a.localeCompare(b));
      for (const [key, record] of entries) {
        const remaining = record.remainingFraction;
        const resetAt = typeof record.resetAt === 'number' ? record.resetAt : undefined;
        const fetchedAt = typeof record.fetchedAt === 'number' ? record.fetchedAt : undefined;
        const label = key.startsWith('antigravity://') ? key.slice('antigravity://'.length) : key;
        const statusParts: string[] = [];
        if (remaining === null || Number.isNaN(remaining)) {
          statusParts.push('remaining: unknown');
        } else {
          statusParts.push(`remaining: ${(remaining * 100).toFixed(1)}%`);
        }
        if (resetAt) {
          const delta = resetAt - now;
          const minutes = Math.round(delta / 60_000);
          const when =
            delta <= 0
              ? 'past'
              : minutes <= 0
                ? '<1m'
                : `${minutes}m`;
          statusParts.push(`resetAt: ${new Date(resetAt).toISOString()} (in ${when})`);
        }
        if (fetchedAt) {
          statusParts.push(`fetchedAt: ${new Date(fetchedAt).toISOString()}`);
        }
        console.log(`- ${label}`);
        console.log(`  ${statusParts.join(' | ')}`);
      }
    });

  return cmd;
}
