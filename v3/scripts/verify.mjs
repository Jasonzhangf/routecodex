#!/usr/bin/env node
import { run } from './_common.mjs';

// Fast, deterministic checks first so cheap failures surface before slow
// architecture gates; fail-fast order is the only sequencing contract here.
await run('cargo', ['fmt', '--all', '--', '--check']);
await run('cargo', ['clippy', '--locked', '--workspace', '--all-targets'], {
  env: { ...process.env, CARGO_NET_OFFLINE: process.env.CARGO_NET_OFFLINE ?? 'true' },
});
await run('node', ['scripts/verify-isolation.mjs']);
await run('node', ['scripts/architecture/verify-admission.mjs']);
await run('npm', ['run', 'test:distribution']);
await run('npm', ['run', 'test:install-cleanup']);
await run('node', ['scripts/run-admission-gate.mjs', 'scripts/architecture/verify-v3-architecture-ci.mjs']);
await run('node', ['scripts/architecture/verify-v3-build-test-artifact-budget.mjs']);
process.stdout.write('[v3 verify] PASS\n');
