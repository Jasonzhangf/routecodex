#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function usage() {
  console.log(
    [
      'Usage:',
      '  node scripts/migrate-antigravity-session-signatures-alias.mjs [--file <path>] --from <aliasKey> --to <aliasKey> [--dry-run]',
      '',
      'Defaults:',
      '  --file ~/.routecodex/state/antigravity-session-signatures.json'
    ].join('\n')
  );
}

function parseArgs(argv) {
  const out = { file: '', from: '', to: '', dryRun: false, help: false };
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
    if (arg === '--from') {
      out.from = String(argv[i + 1] || '');
      i++;
      continue;
    }
    if (arg === '--to') {
      out.to = String(argv[i + 1] || '');
      i++;
      continue;
    }
    if (arg.startsWith('--file=')) {
      out.file = arg.slice('--file='.length);
      continue;
    }
    if (arg.startsWith('--from=')) {
      out.from = arg.slice('--from='.length);
      continue;
    }
    if (arg.startsWith('--to=')) {
      out.to = arg.slice('--to='.length);
      continue;
    }
  }
  return out;
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeAliasKey(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return raw;
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

  const fromKey = normalizeAliasKey(args.from);
  const toKey = normalizeAliasKey(args.to);
  if (!fromKey || !toKey) {
    console.error('[migrate-antigravity-signatures-alias] missing required flags: --from and --to');
    usage();
    process.exit(1);
  }

  const defaultFile = path.join(os.homedir(), '.routecodex', 'state', 'antigravity-session-signatures.json');
  const filePath = path.resolve(args.file && args.file.trim().length ? args.file : defaultFile);

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`[migrate-antigravity-signatures-alias] failed to read/parse: ${filePath}`);
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  }

  if (!isRecord(parsed)) {
    console.log(`[migrate-antigravity-signatures-alias] not an object; skip: ${filePath}`);
    process.exit(0);
  }

  const sessionsRaw = parsed.sessions;
  const sessions = isRecord(sessionsRaw) ? sessionsRaw : null;
  const latestByAliasRaw = parsed.latestByAlias;
  const latestByAlias = isRecord(latestByAliasRaw) ? latestByAliasRaw : null;

  let rewrittenSessions = 0;
  let rewrittenLatest = 0;

  const nextSessions = {};
  if (sessions) {
    for (const [k, v] of Object.entries(sessions)) {
      const key = typeof k === 'string' ? k.trim() : '';
      if (!key) continue;
      const parts = key.split('|');
      if (parts.length >= 2) {
        const alias = normalizeAliasKey(parts[0]);
        const sid = parts.slice(1).join('|');
        if (alias === fromKey) {
          nextSessions[`${toKey}|${sid}`] = v;
          rewrittenSessions++;
          continue;
        }
      }
      nextSessions[key] = v;
    }
  }

  const nextLatestByAlias = {};
  if (latestByAlias) {
    for (const [k, v] of Object.entries(latestByAlias)) {
      const alias = normalizeAliasKey(k);
      if (!alias) continue;
      if (alias === fromKey) {
        nextLatestByAlias[toKey] = v;
        rewrittenLatest++;
        continue;
      }
      nextLatestByAlias[alias] = v;
    }
  }

  const out = {
    ...parsed,
    ...(sessions ? { sessions: nextSessions } : {}),
    ...(latestByAlias ? { latestByAlias: nextLatestByAlias } : {}),
    updatedAt: Date.now()
  };

  console.log(`[migrate-antigravity-signatures-alias] file=${filePath}`);
  console.log(`[migrate-antigravity-signatures-alias] from=${fromKey} to=${toKey}`);
  console.log(`[migrate-antigravity-signatures-alias] rewritten sessions=${rewrittenSessions} latestByAlias=${rewrittenLatest}`);

  if (args.dryRun) {
    console.log('[migrate-antigravity-signatures-alias] dry-run: no files written');
    process.exit(0);
  }

  const backupPath = `${filePath}.bak.${nowStamp()}`;
  const tmpPath = `${filePath}.tmp.${process.pid}.${out.updatedAt}`;
  try {
    fs.copyFileSync(filePath, backupPath);
    fs.writeFileSync(tmpPath, JSON.stringify(out, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    console.error('[migrate-antigravity-signatures-alias] write failed');
    console.error(err && err.message ? err.message : err);
    console.error(`[migrate-antigravity-signatures-alias] backup may exist at: ${backupPath}`);
    process.exit(1);
  }

  console.log(`[migrate-antigravity-signatures-alias] backup: ${backupPath}`);
  console.log('[migrate-antigravity-signatures-alias] done');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

