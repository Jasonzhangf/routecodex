import { spawnSync } from 'node:child_process';

const result = spawnSync(
  process.execPath,
  ['scripts/architecture/verify-no-fallback-diff.mjs', '--all'],
  { stdio: 'inherit' },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
