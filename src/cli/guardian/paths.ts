import path from 'node:path';
import { homedir } from 'node:os';

export type GuardianPaths = {
  rootDir: string;
  stateFile: string;
  lockFile: string;
  logFile: string;
};

export function resolveGuardianPaths(homeDir?: string): GuardianPaths {
  const resolvedHome = typeof homeDir === 'string' && homeDir.trim() ? homeDir.trim() : homedir();
  const rootDir = path.join(resolvedHome, '.routecodex', 'guardian');
  return {
    rootDir,
    stateFile: path.join(rootDir, 'guardian-state.json'),
    lockFile: path.join(rootDir, 'guardian-spawn.lock'),
    logFile: path.join(rootDir, 'guardian.log')
  };
}
