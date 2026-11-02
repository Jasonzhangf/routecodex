import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  commitVersion,
  compareVersions,
  describeLedger,
  ledgerPathFor,
  nextPatchVersion,
  releaseVersion,
  reserveVersion,
  resolveCommonGitDir,
  tryResolveLedgerPath,
} from '../../scripts/version-ledger.mjs';

const v3Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ledgerScript = path.join(v3Root, 'scripts', 'version-ledger.mjs');

function tempLedger(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-ledger-spec-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'routecodex-v3-build-version.json');
}

function options(ledgerPath, buildId, overrides = {}) {
  return { ledgerPath, declaredVersion: '0.90.5000', buildId, ...overrides };
}

test('patch versions advance by exactly one and compare numerically', () => {
  assert.equal(nextPatchVersion('0.90.5000'), '0.90.5001');
  assert.equal(nextPatchVersion('1.99.9'), '1.99.10');
  assert.equal(compareVersions('0.90.9', '0.90.10'), -1);
  assert.equal(compareVersions('0.90.10', '0.90.9'), 1);
  assert.equal(compareVersions('0.90.10', '0.90.10'), 0);
  assert.throws(() => nextPatchVersion('not-a-version'), /not semver/);
});

test('a successful build reserves then commits exactly one advancing version', (t) => {
  const ledgerPath = tempLedger(t);
  const reservation = reserveVersion(options(ledgerPath, 'build-a'));
  assert.equal(reservation.version, '0.90.5001');
  assert.equal(reservation.reused, false);

  const outcome = commitVersion(reservation, options(ledgerPath, 'build-a'));
  assert.equal(outcome.committed, '0.90.5001');
  assert.equal(outcome.alreadyCommitted, false);

  const { ledger } = describeLedger({ ledgerPath, declaredVersion: '0.90.5000' });
  assert.equal(ledger.committed_version, '0.90.5001');
  assert.equal(ledger.reserved, null);
});

test('a failed build releases its reservation so a retry reuses the version (no skip, no duplicate)', (t) => {
  const ledgerPath = tempLedger(t);
  const first = reserveVersion(options(ledgerPath, 'build-fail'));
  assert.equal(first.version, '0.90.5001');

  const released = releaseVersion(first, options(ledgerPath, 'build-fail'));
  assert.deepEqual(released, { released: true, version: '0.90.5001' });

  // A different build retries: it must receive the same version, never 0.90.5002.
  const retry = reserveVersion(options(ledgerPath, 'build-retry'));
  assert.equal(retry.version, '0.90.5001');
  commitVersion(retry, options(ledgerPath, 'build-retry'));

  const { ledger } = describeLedger({ ledgerPath, declaredVersion: '0.90.5000' });
  assert.equal(ledger.committed_version, '0.90.5001');
  const states = ledger.allocations.map((entry) => [entry.build_id, entry.version, entry.state]);
  assert.deepEqual(states, [
    ['build-fail', '0.90.5001', 'released'],
    ['build-retry', '0.90.5001', 'committed'],
  ]);
});

test('repeated reserve for the same build reuses the live reservation instead of advancing again', (t) => {
  const ledgerPath = tempLedger(t);
  const first = reserveVersion(options(ledgerPath, 'build-same'));
  const second = reserveVersion(options(ledgerPath, 'build-same'));
  assert.equal(second.version, first.version);
  assert.equal(second.reused, true);
});

test('two concurrent builds cannot hold the same reservation', (t) => {
  const ledgerPath = tempLedger(t);
  reserveVersion(options(ledgerPath, 'worktree-a'));
  assert.throws(
    () => reserveVersion(options(ledgerPath, 'worktree-b')),
    (error) => error.code === 'VERSION_ALLOCATION_BUSY' && /worktree-a/.test(error.message),
  );
});

test('concurrent independent worktrees receive distinct monotonically increasing versions', async (t) => {
  const ledgerPath = tempLedger(t);
  const concurrency = 6;
  const results = await Promise.all(
    Array.from({ length: concurrency }, (unused, index) =>
      new Promise((resolve, reject) => {
        // Each child races to reserve, commit, and report. Failures are retried
        // because a concurrent holder legitimately returns VERSION_ALLOCATION_BUSY.
        const child = spawn(
          process.execPath,
          [
            '-e',
            `import(${JSON.stringify(ledgerScript)}).then(async (L) => {
               const ledgerPath = process.env.LEDGER;
               const buildId = process.env.BUILD;
               const opts = { ledgerPath, declaredVersion: '0.90.5000', buildId };
               for (let attempt = 0; attempt < 400; attempt += 1) {
                 try {
                   const reservation = L.reserveVersion(opts);
                   L.commitVersion(reservation, opts);
                   process.stdout.write(reservation.version);
                   return;
                 } catch (error) {
                   if (error.code !== 'VERSION_ALLOCATION_BUSY') throw error;
                   await new Promise((r) => setTimeout(r, 10));
                 }
               }
               throw new Error('concurrent reservation never succeeded');
             }).catch((error) => { process.stderr.write(error.stack); process.exit(1); })`,
          ],
          { env: { ...process.env, LEDGER: ledgerPath, BUILD: `wt-${index}` } },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.once('close', (code) => {
          if (code !== 0) reject(new Error(stderr || `child exited ${code}`));
          else resolve(stdout.trim());
        });
      }),
    ),
  );

  assert.equal(results.length, concurrency);
  assert.equal(new Set(results).size, concurrency, `duplicate versions: ${results.join(',')}`);

  const sorted = [...results].sort(compareVersions);
  const { ledger } = describeLedger({ ledgerPath, declaredVersion: '0.90.5000' });
  assert.equal(ledger.committed_version, sorted[sorted.length - 1]);
  for (let index = 0; index < sorted.length; index += 1) {
    assert.equal(sorted[index], nextPatchVersion(index === 0 ? '0.90.5000' : sorted[index - 1]));
  }
});

test('the ledger is repo-global in the shared git common dir, outside the working tree', () => {
  const resolved = tryResolveLedgerPath(v3Root);
  assert.ok(resolved, 'worktree must resolve a shared ledger path');
  assert.ok(
    resolved.endsWith(path.join('.git', 'routecodex-v3-build-version.json')),
    `ledger must live under the shared git dir, got ${resolved}`,
  );
  assert.ok(!resolved.startsWith(v3Root + path.sep), 'ledger must not live inside the v3 working tree');
  assert.equal(resolved, ledgerPathFor(resolveCommonGitDir(v3Root)));
});
