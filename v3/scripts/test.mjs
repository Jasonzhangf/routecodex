#!/usr/bin/env node
import { run } from './_common.mjs';

await run(
  'node',
  [
    'scripts/run-v3-cargo-test.mjs',
    '--locked',
    '--workspace',
    '--exclude',
    'routecodex-v3-cli',
    '--exclude',
    'routecodex-v3-lifecycle',
    '--',
    '--nocapture',
  ],
  { timeoutMs: 45 * 60_000 },
);
await run(
  'node',
  [
    'scripts/run-v3-cargo-test.mjs',
    '--locked',
    '-p',
    'routecodex-v3-runtime',
    '--lib',
    'hub_v1::web_search_sidecar::tests::web_search_hook_sidecar_pending_connect_is_cancelled_without_thread_growth',
    '--',
    '--ignored',
    '--exact',
    '--test-threads=1',
    '--nocapture',
  ],
  { timeoutMs: 45 * 60_000 },
);
await run(
  'npm',
  ['run', '--silent', 'test:v3-managed-server-lifecycle'],
  { tempDir: false },
);
await run(
  'node',
  [
    'scripts/run-v3-cargo-test.mjs',
    '--locked',
    '-p',
    'routecodex-v3-cli',
    '--test',
    'foundation_cli',
    '--test',
    'h2_p6_controlled_replay',
    '--test',
    'user_config_cli',
    '--test',
    'user_config_provider_request_dry_run',
    '--test',
    'vr_full_function_controlled_replay',
    '--',
    '--nocapture',
  ],
  { timeoutMs: 45 * 60_000 },
);
process.stdout.write('[v3 test] PASS\n');
