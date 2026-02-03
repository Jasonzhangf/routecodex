#!/usr/bin/env node
/**
 * Virtual Router dry-run / playback helper.
 *
 * Usage:
 *   node scripts/virtual-router-dryrun.mjs --sampleDir <~/.routecodex/codex-samples/.../req_...> [options]
 *
 * Options:
 *   --config <path>                 RouteCodex user config (default: ~/.routecodex/config.json)
 *   --serverId <host:port>          Router state serverId (default: 0.0.0.0:5520)
 *   --repeat <n>                    Repeat route() N times (default: 8)
 *   --mode <base|actual|both>       Run modes (default: both)
 *   --health <on|off>               Include health snapshot in actual mode (default: on)
 *   --quota <on|off>                Include quota snapshot in actual mode (default: on)
 *   --sessionDir <path>             Override ROUTECODEX_SESSION_DIR (actual mode)
 *   --serverToolRequired <on|off>   Force metadata.serverToolRequired (default: on)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Keep script output machine-readable.
// Must be set before importing llmswitch-core modules.
process.env.ROUTECODEX_STATS = '0';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '1';
    out[key] = val;
  }
  return out;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function ensureDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch {
    // ignore
  }
}

function sanitizeSegment(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function resolveServerScopedSessionDir(serverId) {
  const home = os.homedir();
  if (!home) return null;
  const safe = sanitizeSegment(serverId);
  if (!safe) return null;
  return path.join(home, '.routecodex', 'sessions', safe);
}

function boolFlag(val, defaultValue) {
  if (val === undefined) return defaultValue;
  const s = String(val).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return defaultValue;
}

function loadLatestJsonlSnapshot(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return null;
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed && parsed.kind === 'snapshot') {
          return parsed.snapshot ?? null;
        }
      } catch {
        // ignore line parse errors
      }
    }
    return null;
  } catch {
    return null;
  }
}

function stripAnsi(input) {
  return String(input || '').replace(/\x1b\[[0-9;]*m/g, '');
}

function summarizeHealth(snapshot, keys) {
  const providers = Array.isArray(snapshot?.providers) ? snapshot.providers : [];
  const cooldowns = Array.isArray(snapshot?.cooldowns) ? snapshot.cooldowns : [];
  const byProvider = new Map(providers.map((p) => [p.providerKey, p]));
  const byCooldown = new Map(cooldowns.map((c) => [c.providerKey, c]));
  const now = Date.now();
  return keys.map((key) => {
    const p = byProvider.get(key) ?? null;
    const cd = byCooldown.get(key) ?? null;
    const cooldownExpiresAt = cd?.cooldownExpiresAt ?? p?.cooldownExpiresAt ?? null;
    const activeCooldown = typeof cooldownExpiresAt === 'number' && cooldownExpiresAt > now;
    return {
      providerKey: key,
      state: p?.state ?? null,
      failureCount: p?.failureCount ?? null,
      cooldownExpiresAt,
      activeCooldown
    };
  });
}

function summarizeQuota(quotaDoc, keys) {
  const providers = (quotaDoc && typeof quotaDoc === 'object' && quotaDoc.providers && typeof quotaDoc.providers === 'object')
    ? quotaDoc.providers
    : {};
  const now = Date.now();
  return keys.map((key) => {
    const e = providers[key] ?? null;
    const cooldownUntil = e?.cooldownUntil ?? null;
    const blacklistUntil = e?.blacklistUntil ?? null;
    return {
      providerKey: key,
      inPool: e?.inPool ?? null,
      priorityTier: e?.priorityTier ?? null,
      selectionPenalty: e?.selectionPenalty ?? null,
      cooldownUntil,
      activeCooldown: typeof cooldownUntil === 'number' && cooldownUntil > now,
      blacklistUntil,
      activeBlacklist: typeof blacklistUntil === 'number' && blacklistUntil > now,
      lastErrorCode: e?.lastErrorCode ?? null,
      consecutiveErrorCount: e?.consecutiveErrorCount ?? null
    };
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const sampleDir = args.sampleDir || args.sample || args._[0];
  if (!sampleDir) {
    console.error('Missing --sampleDir <.../req_...>');
    process.exit(1);
  }

  const configPath = args.config || path.join(os.homedir(), '.routecodex', 'config.json');
  const serverId = args.serverId || '0.0.0.0:5520';
  const repeat = Math.max(1, Number.parseInt(String(args.repeat || '8'), 10) || 8);
  const mode = String(args.mode || 'both').trim().toLowerCase();
  const includeHealth = boolFlag(args.health, true);
  const includeQuota = boolFlag(args.quota, true);
  const serverToolRequired = boolFlag(args.serverToolRequired, true);

  const stage2Path = path.join(sampleDir, 'chat_process.req.stage2.semantic_map.json');
  if (!fs.existsSync(stage2Path)) {
    console.error(`Sample missing: ${stage2Path}`);
    process.exit(1);
  }

  const coreDist = path.join(process.cwd(), 'sharedmodule', 'llmswitch-core', 'dist');
  const engineUrl = pathToFileURL(path.join(coreDist, 'router', 'virtual-router', 'engine.js')).href;
  const bootstrapUrl = pathToFileURL(path.join(coreDist, 'router', 'virtual-router', 'bootstrap.js')).href;
  const { VirtualRouterEngine } = await import(engineUrl);
  const { bootstrapVirtualRouterConfig } = await import(bootstrapUrl);

  const userConfig = readJson(configPath);
  const vrInput = userConfig.virtualrouter || userConfig.virtualRouter || userConfig;
  const { config: vrConfig } = bootstrapVirtualRouterConfig(vrInput);

  const stage2 = readJson(stage2Path);
  const meta = stage2?.meta?.context || {};
  const request = { model: stage2.model, messages: stage2.messages, tools: stage2.tools };

  const baseMetadata = {
    requestId: meta.requestId || `dryrun_${Date.now()}`,
    entryEndpoint: meta.entryEndpoint || '/v1/responses',
    providerProtocol: meta.providerProtocol || 'openai-responses',
    sessionId: meta.sessionId,
    conversationId: meta.conversationId,
    serverToolRequired
  };

  const sessionDirActual = args.sessionDir
    ? String(args.sessionDir).trim()
    : (resolveServerScopedSessionDir(serverId) || '');

  const healthPath = path.join(os.homedir(), '.routecodex', 'state', 'router', serverId, 'health.jsonl');
  const healthSnapshot = includeHealth ? loadLatestJsonlSnapshot(healthPath) : null;

  const quotaPath = path.join(os.homedir(), '.routecodex', 'quota', 'provider-quota.json');
  const quotaDoc = includeQuota && fs.existsSync(quotaPath) ? readJson(quotaPath) : null;
  const quotaProviders = quotaDoc?.providers && typeof quotaDoc.providers === 'object' ? quotaDoc.providers : {};

  const quotaView =
    includeQuota && quotaDoc
      ? (providerKey) => {
          const entry = quotaProviders[providerKey];
          return entry && typeof entry === 'object' ? { ...entry } : null;
        }
      : undefined;

  const healthStore =
    includeHealth && healthSnapshot
      ? { loadInitialSnapshot: () => healthSnapshot }
      : undefined;

  const suppressNoisyConsole = (fn) => {
    const originalLog = console.log;
    try {
      console.log = (...items) => {
        const first = stripAnsi(items[0]);
        if (first.includes('[virtual-router-hit]') || first.startsWith('[stats]')) {
          return;
        }
        originalLog(...items);
      };
      return fn();
    } finally {
      console.log = originalLog;
    }
  };

  const runOnce = (label, setup) => {
    const savedSessionDir = process.env.ROUTECODEX_SESSION_DIR;
    try {
      setup?.();
      const engine = new VirtualRouterEngine({
        ...(healthStore ? { healthStore } : {}),
        ...(quotaView ? { quotaView } : {})
      });
      engine.initialize(vrConfig);

      const { sequence, firstDecision } = suppressNoisyConsole(() => {
        const sequence = [];
        let firstDecision = null;
        for (let i = 0; i < repeat; i += 1) {
          const result = engine.route(request, baseMetadata);
          if (!firstDecision) {
            firstDecision = result?.decision ?? null;
          }
          sequence.push(result?.decision?.providerKey || null);
        }
        return { sequence, firstDecision };
      });

      const pool = Array.isArray(firstDecision?.pool) ? firstDecision.pool : [];
      return { label, decision: firstDecision, pool, sequence };
    } finally {
      if (savedSessionDir === undefined) {
        delete process.env.ROUTECODEX_SESSION_DIR;
      } else {
        process.env.ROUTECODEX_SESSION_DIR = savedSessionDir;
      }
    }
  };

  const results = [];
  if (mode === 'base' || mode === 'both') {
    const tmp = path.join(os.tmpdir(), `routecodex-vr-dryrun-${process.pid}-${Date.now()}`);
    ensureDir(tmp);
    results.push(
      runOnce('base(no health/quota)', () => {
        process.env.ROUTECODEX_SESSION_DIR = tmp;
      })
    );
  }
  if (mode === 'actual' || mode === 'both') {
    results.push(
      runOnce(`actual(health=${includeHealth ? 'on' : 'off'}, quota=${includeQuota ? 'on' : 'off'})`, () => {
        if (sessionDirActual) {
          process.env.ROUTECODEX_SESSION_DIR = sessionDirActual;
        }
      })
    );
  }

  const baselinePool = results[0]?.pool || [];
  const poolKeys = new Set();
  for (const r of results) {
    for (const key of r.pool || []) {
      if (typeof key === 'string' && key.trim()) {
        poolKeys.add(key.trim());
      }
    }
  }
  const keys = Array.from(poolKeys);

  const out = {
    sampleDir,
    stage2Path,
    configPath,
    serverId,
    sessionDirActual: sessionDirActual || null,
    healthPath: includeHealth ? healthPath : null,
    quotaPath: includeQuota ? quotaPath : null,
    request: {
      model: request.model,
      messageCount: Array.isArray(request.messages) ? request.messages.length : null,
      toolCount: Array.isArray(request.tools) ? request.tools.length : null
    },
    metadata: baseMetadata,
    results: results.map((r) => ({
      label: r.label,
      routeName: r.decision?.routeName ?? null,
      poolId: r.decision?.poolId ?? null,
      selected: r.decision?.providerKey ?? null,
      pool: r.pool,
      sequence: r.sequence,
      poolSize: r.pool.length
    })),
    pool: keys,
    health: includeHealth && healthSnapshot ? summarizeHealth(healthSnapshot, keys) : null,
    quota: includeQuota && quotaDoc ? summarizeQuota(quotaDoc, keys) : null
  };

  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

main().catch((err) => {
  console.error('[virtual-router-dryrun] failed:', err?.stack || err?.message || String(err));
  process.exit(1);
});
