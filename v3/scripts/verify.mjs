#!/usr/bin/env node
import { runAll } from './_common.mjs';

// Run every gate and report the complete failure set once. Local commit still
// uses verify:fast; this collected mode is for the CI verify tier so one run
// surfaces all independent failures instead of one per re-run.
const { failures, warnings } = await runAll([
  { label: 'rustfmt', command: 'cargo', args: ['fmt', '--all', '--', '--check'] },
  {
    label: 'clippy',
    command: 'npm',
    args: ['run', 'verify:v3-clippy'],
    env: { ...process.env, CARGO_NET_OFFLINE: process.env.CARGO_NET_OFFLINE ?? 'true' },
  },
  { label: 'isolation', command: 'node', args: ['scripts/verify-isolation.mjs'] },
  { label: 'admission', command: 'node', args: ['scripts/architecture/verify-admission.mjs'] },
  { label: 'distribution', command: 'npm', args: ['run', 'test:distribution'] },
  { label: 'install-cleanup', command: 'npm', args: ['run', 'test:install-cleanup'] },
  {
    label: 'architecture-ci',
    command: 'node',
    args: ['scripts/run-admission-gate.mjs', 'scripts/architecture/verify-v3-architecture-ci.mjs'],
  },
  {
    label: 'artifact-budget',
    command: 'node',
    args: ['scripts/architecture/verify-v3-build-test-artifact-budget.mjs'],
  },
]);

if (warnings.length > 0) {
  process.stderr.write(`[v3 verify] WARN ${warnings.length} environment-unavailable gate(s)\n`);
  for (const warning of warnings) process.stderr.write(`- ${warning}\n`);
}

if (failures.length > 0) {
  process.stderr.write(`[v3 verify] FAIL ${failures.length} gate(s)\n`);
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('[v3 verify] PASS\n');
}
