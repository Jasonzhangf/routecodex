// 2026-06-16 runtime lifecycle rebase gate.
// Scans the repo for legacy pid/stop-intent write patterns that lived directly
// under <rccUserDir>/ and verifies they have been replaced with the new helpers.
//
// Forbidden patterns:
// - join(<someHome>, `server-${port}.pid`)
// - join(<someHome>, `daemon-stop-${port}.json`)
// - resolveRccPath('token-daemon.pid') used as the pid file path
// - `daemon-stop-${Math.floor(port)}.json` literal in the new helper module
//
// The gate is intentionally source-level: it cannot see runtime behaviour, but
// it locks the contract that legacy paths are no longer written by the code.

import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();

function readOrNull(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

const checks = [
  {
    label: 'src/index.ts must not write server-<port>.pid in <rccHome>/',
    file: 'src/index.ts',
    forbidden: [/join\(resolveRccPath\(\),\s*`server-\$\{bindPort\}\.pid`\)/],
    required: [/writeServerPidCache\(/]
  },
  {
    label: 'src/cli/commands/start.ts must use writeServerPidCache',
    file: 'src/cli/commands/start.ts',
    forbidden: [/join\(routeCodexHome,\s*`server-\$\{resolvedPort\}\.pid`\)/],
    required: [/writeServerPidCache\(/]
  },
  {
    label: 'src/utils/daemon-stop-intent.ts is a re-export only',
    file: 'src/utils/daemon-stop-intent.ts',
    forbidden: [/daemon-stop-\$\{Math\.floor\(port\)\}\.json/],
    required: [/from\s+'\.\/server-runtime-stop-intent\.js'/]
  },
  {
    label: 'src/cli.ts token-daemon pid path is sourced from helper',
    file: 'src/cli.ts',
    forbidden: [/resolveRccPath\('token-daemon\.pid'\)/],
    required: [/resolveTokenDaemonPidPath\(\)/]
  },
  {
    label: 'src/commands/token-daemon.ts pid path is sourced from helper',
    file: 'src/commands/token-daemon.ts',
    forbidden: [/resolveRccPath\('token-daemon\.pid'\)/],
    required: [/resolveTokenDaemonPidPath\(\)/]
  },
  {
    label: 'src/config/user-data-paths.ts exposes runtime-lifecycle subdir',
    file: 'src/config/user-data-paths.ts',
    forbidden: [],
    required: [/runtimeLifecycle:\s*'state\/runtime-lifecycle'/]
  }
];

const failures = [];
for (const check of checks) {
  const abs = path.join(repoRoot, check.file);
  const text = readOrNull(abs);
  if (text === null) {
    failures.push(`[verify:runtime-lifecycle-pid-rebase] missing file: ${check.file}`);
    continue;
  }
  for (const pattern of check.forbidden) {
    if (pattern.test(text)) {
      failures.push(`[verify:runtime-lifecycle-pid-rebase] forbidden pattern ${pattern} in ${check.file}`);
    }
  }
  for (const pattern of check.required) {
    if (!pattern.test(text)) {
      failures.push(`[verify:runtime-lifecycle-pid-rebase] missing required pattern ${pattern} in ${check.file}`);
    }
  }
}

if (failures.length > 0) {
  console.error('[verify:runtime-lifecycle-pid-rebase] failed');
  for (const line of failures) console.error(`- ${line}`);
  process.exit(1);
}

console.log('[verify:runtime-lifecycle-pid-rebase] ok');
console.log(`- checks: ${checks.length}`);
