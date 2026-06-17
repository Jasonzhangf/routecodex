import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';

// 2026-06-16 runtime lifecycle rebase:
// - server-<port>.pid must NOT be written under <rccUserDir>/
// - daemon-stop-<port>.json must NOT be written under <rccUserDir>/
// - token-daemon.pid must NOT be written under <rccUserDir>/
// The authoritative state lives at:
//   <rccUserDir>/state/runtime-lifecycle/ports/<port>/{pid.cache,stop-intent.json,instance.json}
//   <rccUserDir>/state/runtime-lifecycle/daemon/token-daemon.pid

const repoRoot = process.cwd();

const startPath = join(repoRoot, 'src/cli/commands/start.ts');
const indexPath = join(repoRoot, 'src/index.ts');
const cliTsPath = join(repoRoot, 'src/cli.ts');
const tokenDaemonPath = join(repoRoot, 'src/commands/token-daemon.ts');
const daemonStopIntentPath = join(repoRoot, 'src/utils/daemon-stop-intent.ts');
const managedPidsPath = join(repoRoot, 'src/utils/managed-server-pids.ts');
const userDataPathsPath = join(repoRoot, 'src/config/user-data-paths.ts');
const pidHelperPath = join(repoRoot, 'src/utils/server-runtime-pid.ts');
const stopIntentHelperPath = join(repoRoot, 'src/utils/server-runtime-stop-intent.ts');

function readOrNull(p: string): string | null {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

describe('runtime pid/stop-intent moved out of <rccHome>/ root', () => {
  it('user-data-paths exposes runtime-lifecycle subdir', () => {
    const source = readOrNull(userDataPathsPath);
    expect(source).not.toBeNull();
    expect(source ?? '').toMatch(/runtimeLifecycle:\s*'state\/runtime-lifecycle'/);
  });

  it('start.ts no longer writes server-<port>.pid directly under home', () => {
    const source = readOrNull(startPath) ?? '';
    expect(source).not.toMatch(/`server-\$\{resolvedPort\}\.pid`/);
    expect(source).not.toMatch(/join\(routeCodexHome,\s*`server-\$\{resolvedPort\}\.pid`\)/);
    expect(source).toMatch(/writeServerPidCache\(/);
  });

  it('index.ts no longer writes server-<port>.pid directly under home', () => {
    const source = readOrNull(indexPath) ?? '';
    expect(source).not.toMatch(/`server-\$\{bindPort\}\.pid`/);
    expect(source).toMatch(/writeServerPidCache\(/);
  });

  it('cli.ts token-daemon pid is sourced from runtime helper', () => {
    const source = readOrNull(cliTsPath) ?? '';
    expect(source).toMatch(/resolveTokenDaemonPidPath\(\)/);
    expect(source).not.toMatch(/resolveRccPath\('token-daemon\.pid'\)/);
  });

  it('token-daemon command uses runtime helper for pid path', () => {
    const source = readOrNull(tokenDaemonPath) ?? '';
    expect(source).toMatch(/resolveTokenDaemonPidPath\(\)/);
    expect(source).not.toMatch(/resolveRccPath\('token-daemon\.pid'\)/);
  });

  it('daemon-stop-intent.ts is a thin re-export from server-runtime-stop-intent', () => {
    const source = readOrNull(daemonStopIntentPath) ?? '';
    expect(source).toMatch(/from\s+'\.\/server-runtime-stop-intent\.js'/);
    expect(source).not.toMatch(/daemon-stop-\$\{Math\.floor\(port\)\}\.json/);
  });

  it('managed-server-pids resolves cache under state/runtime-lifecycle/ports/<port>/pid.cache', () => {
    const source = readOrNull(managedPidsPath) ?? '';
    expect(source).toMatch(/resolveServerPidCachePath/);
  });

  it('new helpers exist', () => {
    expect(readOrNull(pidHelperPath)).toMatch(/resolveServerPidCachePath/);
    expect(readOrNull(stopIntentHelperPath)).toMatch(/resolveServerStopIntentPath/);
  });
});
