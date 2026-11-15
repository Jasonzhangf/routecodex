#!/usr/bin/env node
// V3 build version ledger: the single owner of build-version allocation.
//
// User requirement: every successful logical build advances the build version
// by exactly one, across concurrent worktrees, without duplicating or skipping
// a version, while CI stays source- and lockfile-read-only.
//
// Truth model:
//   - v3/package.json is the declared version truth
//     (docs/architecture/v3-resource-operation-map.yml, v3.build.version_truth).
//     It is the ledger's seed and is a release-maintenance input. Builds never
//     rewrite it, so concurrent worktrees cannot race on a tracked file and
//     never produce a merge conflict on a version bump.
//   - The ledger file lives in the repository's *common* git dir
//     (git rev-parse --git-common-dir). Every worktree of the repository shares
//     that directory and it is outside the working tree, so allocation is
//     global and atomic across worktrees without touching source.
//
// Lifecycle (reserve -> commit | release):
//   reserve()  atomically claims the next version and marks it reserved.
//   commit()   confirms the build succeeded; the next reserve advances past it.
//   release()  the build failed; the reservation is discarded, so the version is
//              neither duplicated nor skipped and a retry reuses it.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const v3Root = path.resolve(scriptDir, '..');
export const repoRoot = path.resolve(v3Root, '..');
export const packageJsonPath = path.join(v3Root, 'package.json');

const LEDGER_VERSION = 1;
// A reservation older than this is treated as abandoned (crashed build) and
// reclaimed, so a dead build cannot block every later build forever.
const RESERVATION_TTL_MS = 6 * 60 * 60 * 1000;
const LOCK_TIMEOUT_MS = 120 * 1000;
const LOCK_STALE_MS = 10 * 60 * 1000;

export function nextPatchVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version ?? '').trim());
  if (!match) {
    throw new Error(`V3 package version is not semver: ${version}`);
  }
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

export function compareVersions(left, right) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? '').trim());
    if (!match) throw new Error(`V3 package version is not semver: ${value}`);
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function readDeclaredVersion(filePath = packageJsonPath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const version = String(parsed.version ?? '').trim();
  if (!version) throw new Error(`source package version missing: ${filePath}`);
  return version;
}

// The common git dir is shared by every worktree of this repository. Resolution
// goes through git so linked worktrees (where .git is a file) resolve correctly.
export function resolveCommonGitDir(cwd = repoRoot) {
  const result = spawnSync('git', ['rev-parse', '--git-common-dir'], {
    cwd,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `cannot resolve git common dir: ${
        result.error?.message ?? String(result.stderr ?? '').trim()
      }`,
    );
  }
  const raw = String(result.stdout ?? '').trim();
  if (!raw) throw new Error('git rev-parse --git-common-dir returned no path');
  return path.resolve(cwd, raw);
}

// Returns an absolute ledger path, or null when the caller is not inside a git
// repository (for example an isolated release snapshot root). Callers then fall
// back to the declared package version.
export function tryResolveLedgerPath(cwd = repoRoot) {
  try {
    return ledgerPathFor(resolveCommonGitDir(cwd));
  } catch {
    return null;
  }
}

export function ledgerPathFor(commonGitDir = resolveCommonGitDir()) {
  return path.join(commonGitDir, 'routecodex-v3-build-version.json');
}

function sleepSync(ms) {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

function withLedgerLock(lockPath, action) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let held = false;
  while (!held) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, `${process.pid}\n`);
      fs.closeSync(fd);
      held = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let ageMs = 0;
      try {
        ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
      } catch {
        continue; // released between open and stat: retry immediately
      }
      if (ageMs > LOCK_STALE_MS) {
        try {
          fs.unlinkSync(lockPath);
        } catch {}
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`version ledger lock timeout after ${LOCK_TIMEOUT_MS}ms: ${lockPath}`);
      }
      sleepSync(25);
    }
  }
  try {
    return action();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {}
  }
}

function readLedgerText(ledgerPath) {
  try {
    return fs.readFileSync(ledgerPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function writeLedgerAtomic(ledgerPath, ledger) {
  const tempPath = `${ledgerPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(ledger, null, 2)}\n`);
  fs.renameSync(tempPath, ledgerPath);
}

function loadLedger(ledgerPath, declaredVersion) {
  const text = readLedgerText(ledgerPath);
  if (text === null) {
    return {
      ledger_version: LEDGER_VERSION,
      committed_version: declaredVersion,
      reserved: null,
      allocations: [],
    };
  }
  let ledger;
  try {
    ledger = JSON.parse(text);
  } catch (error) {
    throw new Error(`version ledger is not valid JSON (${ledgerPath}): ${error.message}`);
  }
  if (ledger?.ledger_version !== LEDGER_VERSION) {
    throw new Error(
      `version ledger has unsupported ledger_version ${ledger?.ledger_version} (${ledgerPath})`,
    );
  }
  // The declared package version can move ahead of the ledger (a merged release
  // bump), so the committed floor follows the higher of the two.
  if (compareVersions(declaredVersion, ledger.committed_version) > 0) {
    ledger.committed_version = declaredVersion;
  }
  if (!Array.isArray(ledger.allocations)) ledger.allocations = [];
  return ledger;
}

function reservationIsLive(reservation) {
  if (!reservation) return false;
  const reservedAt = Number(reservation.reserved_at_ms);
  if (!Number.isFinite(reservedAt)) return false;
  return Date.now() - reservedAt < RESERVATION_TTL_MS;
}

export function reserveVersion(options = {}) {
  const declaredVersion = options.declaredVersion ?? readDeclaredVersion(options.packageJsonPath);
  const ledgerPath = options.ledgerPath ?? ledgerPathFor(options.commonGitDir ?? resolveCommonGitDir(options.cwd));
  const buildId = String(options.buildId ?? '').trim();
  if (!buildId) throw new Error('reserveVersion requires a buildId');
  const lockPath = `${ledgerPath}.lock`;

  return withLedgerLock(lockPath, () => {
    const ledger = loadLedger(ledgerPath, declaredVersion);
    const liveReservation = reservationIsLive(ledger.reserved) ? ledger.reserved : null;

    if (liveReservation && liveReservation.build_id === buildId) {
      return { version: liveReservation.version, buildId, ledgerPath, reused: true };
    }
    if (liveReservation) {
      const error = new Error(
        `version allocation busy: ${liveReservation.version} is reserved by build ${liveReservation.build_id} (worktree ${liveReservation.worktree ?? '<unknown>'})`,
      );
      error.code = 'VERSION_ALLOCATION_BUSY';
      throw error;
    }

    const version = nextPatchVersion(ledger.committed_version);
    const now = Date.now();
    ledger.reserved = {
      version,
      build_id: buildId,
      worktree: options.worktree ?? null,
      reserved_at_ms: now,
    };
    ledger.allocations.push({
      build_id: buildId,
      version,
      state: 'reserved',
      worktree: options.worktree ?? null,
      at_ms: now,
    });
    writeLedgerAtomic(ledgerPath, ledger);
    return { version, buildId, ledgerPath, reused: false };
  });
}

// Confirms a reservation. The reserved version becomes the committed floor.
export function commitVersion(reservation, options = {}) {
  const declaredVersion = options.declaredVersion ?? readDeclaredVersion(options.packageJsonPath);
  const ledgerPath = options.ledgerPath ?? reservation.ledgerPath ?? ledgerPathFor(options.commonGitDir ?? resolveCommonGitDir(options.cwd));
  const lockPath = `${ledgerPath}.lock`;
  const version = reservation.version;
  const buildId = reservation.buildId;

  return withLedgerLock(lockPath, () => {
    const ledger = loadLedger(ledgerPath, declaredVersion);
    const reserved = ledger.reserved;
    if (reserved && reserved.build_id !== buildId) {
      throw new Error(
        `cannot commit ${version}: build ${reserved.build_id} currently holds the reservation`,
      );
    }
    if (compareVersions(version, ledger.committed_version) <= 0) {
      // Already committed (retry after a partial success): keep the floor.
      ledger.reserved = null;
      writeLedgerAtomic(ledgerPath, ledger);
      return { version, committed: ledger.committed_version, alreadyCommitted: true };
    }
    ledger.committed_version = version;
    ledger.reserved = null;
    const entry = [...ledger.allocations]
      .reverse()
      .find((allocation) => allocation.build_id === buildId && allocation.version === version);
    if (entry) entry.state = 'committed';
    writeLedgerAtomic(ledgerPath, ledger);
    return { version, committed: version, alreadyCommitted: false };
  });
}

// Discards a reservation after a failed build. The version is reused by the next
// reserve, so a failure neither duplicates nor skips a version.
export function releaseVersion(reservation, options = {}) {
  const declaredVersion = options.declaredVersion ?? readDeclaredVersion(options.packageJsonPath);
  const ledgerPath = options.ledgerPath ?? reservation.ledgerPath ?? ledgerPathFor(options.commonGitDir ?? resolveCommonGitDir(options.cwd));
  const lockPath = `${ledgerPath}.lock`;
  const buildId = reservation.buildId;

  return withLedgerLock(lockPath, () => {
    const ledger = loadLedger(ledgerPath, declaredVersion);
    const reserved = ledger.reserved;
    const ownsReservation =
      reserved &&
      reserved.build_id === buildId &&
      reserved.version === reservation.version;
    const hasOwnedReservedAllocation = ledger.allocations.some(
      (allocation) =>
        allocation.build_id === buildId &&
        allocation.version === reservation.version &&
        allocation.state === 'reserved',
    );
    if (!ownsReservation || !hasOwnedReservedAllocation) {
      return { released: false };
    }
    ledger.reserved = null;
    const entry = [...ledger.allocations]
      .reverse()
      .find((allocation) => allocation.build_id === buildId && allocation.state === 'reserved');
    if (entry) entry.state = 'released';
    writeLedgerAtomic(ledgerPath, ledger);
    return { released: true, version: reserved.version };
  });
}

// The version a consumer (install, pack) must publish: the *committed* ledger
// version when the caller is inside a git repo, otherwise the declared version
// of the isolated snapshot root.
//
// A publication must never consume a live reservation. A reserved version is
// not yet owned by a successful build; if the reserving build later fails, the
// version is released and reused, so publishing it would duplicate a version
// that a retry still owns. Only a committed version is a finished allocation.
export function committedLedgerVersion(options = {}) {
  const declaredVersion = options.declaredVersion ?? readDeclaredVersion(options.packageJsonPath);
  const ledgerPath = options.ledgerPath ?? tryResolveLedgerPath(options.cwd);
  if (!ledgerPath) return declaredVersion;
  const ledger = loadLedger(ledgerPath, declaredVersion);
  return ledger.committed_version;
}

// The version currently active for the in-flight build (a live reservation) or
// the last committed build. This is a diagnostic view only; publication
// consumers must use committedLedgerVersion so they never emit an uncommitted
// or subsequently reused version.
export function currentLedgerVersion(options = {}) {
  const declaredVersion = options.declaredVersion ?? readDeclaredVersion(options.packageJsonPath);
  const ledgerPath = options.ledgerPath ?? tryResolveLedgerPath(options.cwd);
  if (!ledgerPath) return declaredVersion;
  const ledger = loadLedger(ledgerPath, declaredVersion);
  return reservationIsLive(ledger.reserved) ? ledger.reserved.version : ledger.committed_version;
}

export function describeLedger(options = {}) {
  const declaredVersion = options.declaredVersion ?? readDeclaredVersion(options.packageJsonPath);
  const ledgerPath = options.ledgerPath ?? ledgerPathFor(options.commonGitDir ?? resolveCommonGitDir(options.cwd));
  return { ledgerPath, ledger: loadLedger(ledgerPath, declaredVersion) };
}

function main(argv) {
  const [command, ...rest] = argv;
  const buildIdIndex = rest.indexOf('--build-id');
  const buildId = buildIdIndex >= 0 ? rest[buildIdIndex + 1] : '';
  const versionIndex = rest.indexOf('--version');
  const version = versionIndex >= 0 ? rest[versionIndex + 1] : '';
  const json = rest.includes('--json');
  switch (command) {
    case 'current': {
      const current = currentLedgerVersion();
      process.stdout.write(json ? `${JSON.stringify({ version: current })}\n` : `[v3 version-ledger] current=${current}\n`);
      return 0;
    }
    case 'show':
      process.stdout.write(`${JSON.stringify(describeLedger(), null, 2)}\n`);
      return 0;
    case 'reserve': {
      const reservation = reserveVersion({ buildId });
      process.stdout.write(json ? `${JSON.stringify(reservation)}\n` : `[v3 version-ledger] reserved ${reservation.version} for ${reservation.buildId}\n`);
      return 0;
    }
    case 'commit': {
      const outcome = commitVersion({ version, buildId });
      process.stdout.write(json ? `${JSON.stringify(outcome)}\n` : `[v3 version-ledger] committed ${outcome.committed}\n`);
      return 0;
    }
    case 'release': {
      const outcome = releaseVersion({ version, buildId });
      process.stdout.write(json ? `${JSON.stringify(outcome)}\n` : `[v3 version-ledger] released ${outcome.version ?? '<none>'}\n`);
      return 0;
    }
    default:
      process.stderr.write('[v3 version-ledger] usage: version-ledger.mjs <current|show|reserve|commit|release>\n');
      return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`[v3 version-ledger] ${error.message}\n`);
    process.exit(1);
  }
}
