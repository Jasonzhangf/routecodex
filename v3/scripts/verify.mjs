#!/usr/bin/env node
import { run } from './_common.mjs';

run('node', ['scripts/verify-isolation.mjs']);
run('node', ['scripts/architecture/verify-admission.mjs']);
run('npm', ['run', 'test:distribution']);
run('npm', ['run', 'test:install-cleanup']);
run('node', ['scripts/run-admission-gate.mjs', 'scripts/architecture/verify-v3-architecture-ci.mjs']);
run('node', ['scripts/architecture/verify-v3-build-test-artifact-budget.mjs']);
run('cargo', ['fmt', '--all', '--', '--check']);
run('cargo', ['clippy', '--locked', '--workspace', '--all-targets'], {
  env: { ...process.env, CARGO_NET_OFFLINE: process.env.CARGO_NET_OFFLINE ?? 'true' },
});
process.stdout.write('[v3 verify] PASS\n');
