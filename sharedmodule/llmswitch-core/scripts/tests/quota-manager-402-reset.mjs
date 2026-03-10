#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

async function main() {
  const { QuotaManager } = await import(path.resolve(repoRoot, 'dist/quota/index.js'));

  const mgr = new QuotaManager();
  mgr.registerProviderStaticConfig('crs.key1.gpt-5.2', { authType: 'apikey', apikeyDailyResetTime: '16:00Z' });

  // Case 1: 402 with explicit resetAt should be respected.
  const now1 = Date.now();
  const resetAt1 = new Date(now1 + 60 * 60_000).toISOString();
  mgr.onProviderError({
    code: 'HTTP_402',
    message: 'HTTP 402',
    stage: 'provider.http',
    status: 402,
    recoverable: false,
    runtime: { requestId: 'req1', providerKey: 'crs.key1.gpt-5.2' },
    timestamp: now1,
    details: { resetAt: resetAt1 }
  });
  const s1 = mgr.getSnapshot().providers['crs.key1.gpt-5.2'];
  assert.ok(s1, 'quota state must exist');
  assert.equal(s1.inPool, false, '402 must remove key from pool');
  assert.equal(s1.blacklistUntil, Date.parse(resetAt1), 'resetAt must be used');

  // Case 1b: 402 with resetAt embedded in message JSON must be respected (even if details.resetAt is missing).
  const mgr1b = new QuotaManager();
  mgr1b.registerProviderStaticConfig('crs.key1b.gpt-5.2', { authType: 'apikey', apikeyDailyResetTime: '16:00Z' });
  const now1b = Date.now();
  const resetAt1b = new Date(now1b + 30 * 60_000).toISOString();
  mgr1b.onProviderError({
    code: 'HTTP_402',
    message: `HTTP 402: ${JSON.stringify({ error: { code: 'daily_cost_limit_exceeded' }, resetAt: resetAt1b })}`,
    stage: 'provider.http',
    status: 402,
    recoverable: false,
    runtime: { requestId: 'req1b', providerKey: 'crs.key1b.gpt-5.2' },
    timestamp: now1b,
    details: {}
  });
  const s1b = mgr1b.getSnapshot().providers['crs.key1b.gpt-5.2'];
  assert.ok(s1b);
  assert.equal(s1b.blacklistUntil, Date.parse(resetAt1b), 'resetAt in message must be used');

  // Case 2: 402 without resetAt falls back to configured daily reset time (UTC).
  const mgr2 = new QuotaManager();
  mgr2.registerProviderStaticConfig('crs.key2.gpt-5.2', { authType: 'apikey', apikeyDailyResetTime: '16:00Z' });
  const now2 = Date.parse('2026-02-02T14:50:00.000Z');
  mgr2.onProviderError({
    code: 'HTTP_402',
    message: 'HTTP 402',
    stage: 'provider.http',
    status: 402,
    recoverable: false,
    runtime: { requestId: 'req2', providerKey: 'crs.key2.gpt-5.2' },
    timestamp: now2,
    details: {}
  });
  const s2 = mgr2.getSnapshot().providers['crs.key2.gpt-5.2'];
  assert.ok(s2);
  assert.equal(s2.blacklistUntil, Date.parse('2026-02-02T16:00:00.000Z'), 'configured reset time must be applied');

  // Case 3: if now is after reset time, next day should be chosen.
  const mgr3 = new QuotaManager();
  mgr3.registerProviderStaticConfig('crs.key3.gpt-5.2', { authType: 'apikey', apikeyDailyResetTime: '16:00Z' });
  const now3 = Date.parse('2026-02-02T16:10:00.000Z');
  mgr3.onProviderError({
    code: 'HTTP_402',
    message: 'HTTP 402',
    stage: 'provider.http',
    status: 402,
    recoverable: false,
    runtime: { requestId: 'req3', providerKey: 'crs.key3.gpt-5.2' },
    timestamp: now3,
    details: {}
  });
  const s3 = mgr3.getSnapshot().providers['crs.key3.gpt-5.2'];
  assert.ok(s3);
  assert.equal(s3.blacklistUntil, Date.parse('2026-02-03T16:00:00.000Z'), 'next day reset must be used');

  // Case 4: manual blacklist must not be overridden by automated error cooldowns.
  const mgr4 = new QuotaManager();
  mgr4.registerProviderStaticConfig('crs.key4.gpt-5.2', { authType: 'apikey' });
  mgr4.disableProvider({ providerKey: 'crs.key4.gpt-5.2', mode: 'blacklist', durationMs: 60_000, reason: 'manual' });
  const before = mgr4.getSnapshot().providers['crs.key4.gpt-5.2'];
  assert.ok(before);
  const beforeUntil = before.blacklistUntil;
  mgr4.onProviderError({
    code: 'HTTP_429',
    message: 'HTTP 429',
    stage: 'provider.http',
    status: 429,
    recoverable: true,
    runtime: { requestId: 'req4', providerKey: 'crs.key4.gpt-5.2' },
    timestamp: Date.now(),
    details: {}
  });
  const after = mgr4.getSnapshot().providers['crs.key4.gpt-5.2'];
  assert.ok(after);
  assert.equal(after.blacklistUntil, beforeUntil, 'manual blacklist must be preserved');

  // Case 5: local-time default (12:00) must cross DST boundaries correctly.
  // Run in a child process with TZ set to ensure deterministic behavior.
  const tzTestCode = `
    import assert from 'node:assert/strict';
    import path from 'node:path';
    const repoRoot = ${JSON.stringify(repoRoot)};
    const { QuotaManager } = await import(path.resolve(repoRoot, 'dist/quota/index.js'));

    function runCase(nowIso, expectedResetIso) {
      const mgr = new QuotaManager();
      const nowMs = Date.parse(nowIso);
      mgr.onProviderError({
        code: 'HTTP_402',
        message: 'HTTP 402',
        stage: 'provider.http',
        status: 402,
        recoverable: false,
        runtime: { requestId: 'dst', providerKey: 'crs.dst.gpt-5.2' },
        timestamp: nowMs,
        details: {}
      });
      const s = mgr.getSnapshot().providers['crs.dst.gpt-5.2'];
      assert.ok(s);
      assert.equal(s.blacklistUntil, Date.parse(expectedResetIso), 'local resetAt must match expected UTC timestamp');
    }

    // America/Los_Angeles: DST starts on 2026-03-08 (offset -08 -> -07).
    // Local noon:
    // - 2026-03-07 12:00 PST = 2026-03-07T20:00:00Z
    // - 2026-03-08 12:00 PDT = 2026-03-08T19:00:00Z
    runCase('2026-03-07T18:00:00.000Z', '2026-03-07T20:00:00.000Z');
    runCase('2026-03-08T18:00:00.000Z', '2026-03-08T19:00:00.000Z');
    console.log('[quota-manager-402-reset] DST local reset tests passed');
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', tzTestCode], {
    env: { ...process.env, TZ: 'America/Los_Angeles' },
    stdio: 'inherit'
  });
  if (child.status !== 0) {
    throw new Error(`DST local reset tests failed (exit=${child.status})`);
  }

  console.log('[quota-manager-402-reset] tests passed');
}

main().catch((err) => {
  console.error('[quota-manager-402-reset] failed:', err);
  process.exit(1);
});
