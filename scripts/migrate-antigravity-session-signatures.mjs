#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function usage() {
  console.log(
    [
      'Usage:',
      '  node scripts/migrate-antigravity-session-signatures.mjs [--file <path>] [--alias <aliasKey>] [--dry-run]',
      '',
      'Defaults:',
      '  --file  ~/.routecodex/state/antigravity-session-signatures.json',
      '  --alias antigravity.unknown'
    ].join('\n')
  );
}

function parseArgs(argv) {
  const out = { file: '', alias: 'antigravity.unknown', dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      continue;
    }
    if (arg === '--dry-run') {
      out.dryRun = true;
      continue;
    }
    if (arg === '--file') {
      out.file = String(argv[i + 1] || '');
      i++;
      continue;
    }
    if (arg === '--alias') {
      out.alias = String(argv[i + 1] || '');
      i++;
      continue;
    }
    if (arg.startsWith('--file=')) {
      out.file = arg.slice('--file='.length);
      continue;
    }
    if (arg.startsWith('--alias=')) {
      out.alias = arg.slice('--alias='.length);
      continue;
    }
  }
  return out;
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeAliasKey(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw.length ? raw.toLowerCase() : 'antigravity.unknown';
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(
    d.getSeconds()
  )}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }

  const defaultFile = path.join(os.homedir(), '.routecodex', 'state', 'antigravity-session-signatures.json');
  const filePath = path.resolve(args.file && args.file.trim().length ? args.file : defaultFile);
  const aliasKey = normalizeAliasKey(args.alias);

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`[migrate-antigravity-signatures] failed to read/parse: ${filePath}`);
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  }

  const sessionsRaw = isRecord(parsed) ? parsed.sessions : undefined;
  const sessions = isRecord(sessionsRaw) ? sessionsRaw : null;
  if (!sessions) {
    console.log(`[migrate-antigravity-signatures] no sessions found; skip: ${filePath}`);
    process.exit(0);
  }

  const migratedSessions = {};
  let migrated = 0;
  let kept = 0;
  for (const [key, entry] of Object.entries(sessions)) {
    if (!key || typeof key !== 'string') continue;
    const trimmed = key.trim();
    if (!trimmed) continue;
    const newKey = trimmed.includes('|') ? trimmed : `${aliasKey}|${trimmed}`;
    if (newKey !== trimmed) migrated++;
    else kept++;
    migratedSessions[newKey] = entry;
  }

  const latestByAlias = {};
  const latestByAliasRaw = isRecord(parsed) ? parsed.latestByAlias : undefined;
  if (isRecord(latestByAliasRaw)) {
    for (const [k, v] of Object.entries(latestByAliasRaw)) {
      const ak = normalizeAliasKey(k);
      latestByAlias[ak] = v;
    }
  } else if (isRecord(parsed) && isRecord(parsed.latest)) {
    latestByAlias[aliasKey] = parsed.latest;
  }

  const updatedAt = Date.now();
  const output = {
    version: 2,
    migratedAt: updatedAt,
    updatedAt,
    sessions: migratedSessions,
    ...(Object.keys(latestByAlias).length ? { latestByAlias } : {})
  };

  const backupPath = `${filePath}.bak.${nowStamp()}`;
  const tmpPath = `${filePath}.tmp.${process.pid}.${updatedAt}`;

  console.log(`[migrate-antigravity-signatures] file=${filePath}`);
  console.log(`[migrate-antigravity-signatures] alias=${aliasKey}`);
  console.log(`[migrate-antigravity-signatures] sessions: migrated=${migrated} kept=${kept} total=${migrated + kept}`);

  if (args.dryRun) {
    console.log('[migrate-antigravity-signatures] dry-run: no files written');
    process.exit(0);
  }

  try {
    fs.copyFileSync(filePath, backupPath);
    fs.writeFileSync(tmpPath, JSON.stringify(output, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    console.error('[migrate-antigravity-signatures] write failed');
    console.error(err && err.message ? err.message : err);
    console.error(`[migrate-antigravity-signatures] backup may exist at: ${backupPath}`);
    process.exit(1);
  }

  console.log(`[migrate-antigravity-signatures] backup: ${backupPath}`);
  console.log('[migrate-antigravity-signatures] done');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
