import { Command } from 'commander';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

import { applyErrorEvent, createInitialQuotaState, tickQuotaStateTime, type QuotaState } from '../manager/quota/provider-quota-center.js';
import { loadProviderQuotaSnapshot, saveProviderQuotaSnapshot } from '../manager/quota/provider-quota-store.js';
import { x7eGate } from '../server/runtime/http-server/daemon-admin/routecodex-x7e-gate.js';

type ReplayRecord = {
  ts?: string;
  providerKey?: string;
  code?: string;
  httpStatus?: number;
};

function resolveDefaultErrorLogPath(): string {
  return path.join(homedir(), '.routecodex', 'quota', 'provider-errors.ndjson');
}

export function createQuotaDaemonCommand(): Command {
  const cmd = new Command('quota-daemon');

  cmd
    .description('Run provider quota daemon maintenance / replay once (offline; no server required)')
    .option('--once', 'Run a single maintenance tick and exit', false)
    .option('--replay-errors [file]', 'Replay provider-errors.ndjson into provider-quota.json (default: ~/.routecodex/quota/provider-errors.ndjson)')
    .option('--dry-run', 'Do not write provider-quota.json', false)
    .option('--json', 'Print resulting snapshot JSON to stdout', false)
    .action(async (opts: { once?: boolean; replayErrors?: string | boolean; dryRun?: boolean; json?: boolean }) => {
      if (!opts.once && !opts.replayErrors) {
        cmd.help({ error: true });
        return;
      }

      // X7E Phase 1: legacy quota daemon command becomes no-op in unified quota mode.
      if (x7eGate.phase1UnifiedQuota) {
        const msg = '[quota-daemon] skipped: unified quota mode is enabled (ROUTECODEX_X7E_PHASE_1_UNIFIED_QUOTA=true)';
        if (opts.json) {
          console.log(JSON.stringify({ skipped: true, reason: 'unified_quota_mode', message: msg }, null, 2));
        } else {
          console.log(msg);
        }
        return;
      }

      const nowMs = Date.now();
      const snapshot = await loadProviderQuotaSnapshot();
      const states = new Map<string, QuotaState>();
      if (snapshot?.providers && typeof snapshot.providers === 'object') {
        for (const [providerKey, state] of Object.entries(snapshot.providers)) {
          if (state && typeof state === 'object') {
            states.set(providerKey, state as QuotaState);
          }
        }
      }

      const replayPath =
        typeof opts.replayErrors === 'string'
          ? path.resolve(process.cwd(), opts.replayErrors)
          : opts.replayErrors
            ? resolveDefaultErrorLogPath()
            : null;

      if (replayPath && fsSync.existsSync(replayPath)) {
        const raw = await fs.readFile(replayPath, 'utf8');
        const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
        for (const line of lines) {
          let rec: ReplayRecord | null = null;
          try {
            rec = JSON.parse(line) as ReplayRecord;
          } catch {
            continue;
          }
          const providerKey = typeof rec.providerKey === 'string' ? rec.providerKey.trim() : '';
          if (!providerKey) {
            continue;
          }
          const state = states.get(providerKey) ?? createInitialQuotaState(providerKey, undefined, nowMs);
          const next = applyErrorEvent(
            state,
            {
              providerKey,
              code: typeof rec.code === 'string' ? rec.code : undefined,
              httpStatus: typeof rec.httpStatus === 'number' ? rec.httpStatus : undefined,
              timestampMs: nowMs
            },
            nowMs
          );
          states.set(providerKey, next);
        }
      }

      if (opts.once) {
        const next = new Map<string, QuotaState>();
        for (const [providerKey, state] of states.entries()) {
          next.set(providerKey, tickQuotaStateTime(state, nowMs));
        }
        states.clear();
        for (const [key, value] of next.entries()) {
          states.set(key, value);
        }
      }

      const providers = Object.fromEntries(states.entries());

      if (!opts.dryRun) {
        await saveProviderQuotaSnapshot(providers, new Date(nowMs));
      }

      if (opts.json) {
        console.log(JSON.stringify({ updatedAt: new Date(nowMs).toISOString(), providers }, null, 2));
        return;
      }

      const total = Object.keys(providers).length;
      const inPool = Object.values(providers).filter((p) => p && p.inPool).length;
      const replaySuffix = replayPath ? ` replay=${replayPath}` : '';
      console.log(`[quota-daemon] ${opts.dryRun ? 'dry-run ' : ''}completed: providers=${total} inPool=${inPool}${replaySuffix}`);
    });

  return cmd;
}
