#!/usr/bin/env node
// V3 public build entry.
//
// This is the single boundary where a successful logical build advances the V3
// build version (see v3/scripts/version-ledger.mjs). Every public build entry
// (`npm run build`, `build:min`, root/v3 `build:v3-cli`) routes through here so
// root and v3 builds share identical advancing semantics:
//
//   reserve -> build with the reserved version embedded -> commit
//                       \-> on failure: release (retry reuses the version)
//
// Modes:
//   (default)   full workspace debug build + CLI release copy into v3/dist/bin
//   --cli       CLI-only debug build (matches `build:v3-cli`)
//
// CI runs the same entry. The ledger lives in the git common dir (never a
// tracked file) and builds never rewrite v3/package.json, so CI stays source-
// and lockfile-read-only while the embedded version still advances.

import { readFileSync } from 'node:fs';
import path, { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, v3Root } from './_common.mjs';
import { commitVersion, releaseVersion, reserveVersion } from './version-ledger.mjs';

// Reserve the next version, waiting while another concurrent build of the same
// repository holds the allocation. A loser does not fail: it waits (with a
// bounded, generous ceiling) and then receives the next monotonic version.
const RESERVE_WAIT_CEILING_MS = 30 * 60 * 1000;
const RESERVE_POLL_MS = 200;

async function reserveWithWait(options) {
  const deadline = Date.now() + RESERVE_WAIT_CEILING_MS;
  for (;;) {
    try {
      return reserveVersion(options);
    } catch (error) {
      if (error?.code !== 'VERSION_ALLOCATION_BUSY') throw error;
      if (Date.now() >= deadline) {
        process.stderr.write(
          `[v3 build] timed out waiting for the version reservation (ceiling ${RESERVE_WAIT_CEILING_MS}ms): ${error.message}\n`,
        );
        process.exit(1);
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, RESERVE_POLL_MS));
    }
  }
}

// Any build-stage or commit failure releases this build's reservation. The
// original failure is thrown unchanged; release diagnostics are attached so a
// failed cleanup never hides the real cause.
function releaseReservationOnFailure(reservation, options, failure) {
  try {
    const releaseOutcome = releaseVersion(reservation, options);
    failure.released = releaseOutcome.released === true;
  } catch (releaseError) {
    failure.released = false;
    failure.releaseError = releaseError;
  }
  return failure;
}

export async function commitBuild(reservation, options = {}, build = null) {
  try {
    if (build) await build();
    return await commitVersion(reservation, options);
  } catch (error) {
    throw releaseReservationOnFailure(reservation, options, error);
  }
}

export async function runBuild(options = {}) {
  const args = options.args ?? process.argv.slice(2);
  const cliOnly = args.includes('--cli');
  const unknown = args.filter((arg) => arg !== '--cli');
  if (unknown.length > 0) {
    process.stderr.write(`[v3 build] unknown arguments: ${unknown.join(' ')}\n`);
    process.exit(2);
  }

  const buildId = [
    process.env.ROUTECODEX_BUILD_ID,
    `pid-${process.pid}`,
    `wt-${process.cwd()}`,
  ]
    .filter(Boolean)
    .join(':');

  const packageVersion = JSON.parse(readFileSync(resolve(v3Root, 'package.json'), 'utf8')).version;

  // Reserve the next version before any compilation so the reserved value is the
  // one embedded in every artifact this logical build produces. A concurrent
  // build of the same repository holds the reservation while it compiles, so a
  // loser waits for that holder instead of failing: each concurrent worktree
  // still receives its own distinct, monotonically advancing version.
  const reservation = await reserveWithWait({
    buildId,
    worktree: process.cwd(),
    ...(options.ledgerPath ? { ledgerPath: options.ledgerPath } : {}),
  });
  const buildVersion = reservation.version;

  const env = {
    ...process.env,
    CARGO_NET_OFFLINE: process.env.CARGO_NET_OFFLINE ?? 'true',
    // build.rs re-runs on ROUTECODEX_BUILD_VERSION change (rerun-if-env-changed),
    // so both the workspace build and the CLI copy embed this same version.
    ROUTECODEX_BUILD_VERSION: buildVersion,
  };

  try {
    await commitBuild(reservation, { worktree: process.cwd() }, async () => {
      await run('node', ['scripts/verify-isolation.mjs'], { env });
      if (cliOnly) {
        // CLI-only debug build: identical to the historical build:v3-cli compile
        // step, but with the reserved version embedded.
        await run('cargo', ['build', '--locked', '-p', 'routecodex-v3-cli'], { env });
      } else {
        await run('cargo', ['build', '--locked', '--workspace'], { env });
        await run('node', ['scripts/copy-cli-bin.mjs'], { env });
      }
    });
  } catch (error) {
    const releaseDetail = error.releaseError
      ? `, release failed: ${error.releaseError.message}`
      : '';
    process.stderr.write(
      `[v3 build] FAILED build_id=${buildId} reserved=${buildVersion}${releaseDetail} (released; retry reuses it): ${error.message}\n`,
    );
    process.exit(1);
  }

  process.stdout.write(
    `[v3 build] PASS mode=${cliOnly ? 'cli' : 'workspace'} version=${buildVersion} (declared was ${packageVersion})\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runBuild();
}
