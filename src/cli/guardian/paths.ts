import path from 'node:path';
import { resolveRccGuardianDir } from '../../config/user-data-paths.js';

export type GuardianPaths = {
  rootDir: string;
  stateFile: string;
  lockFile: string;
  logFile: string;
};

export function resolveGuardianPaths(homeDir?: string): GuardianPaths {
  const rootDir = resolveRccGuardianDir(homeDir);
  return {
    rootDir,
    stateFile: path.join(rootDir, 'guardian-state.json'),
    lockFile: path.join(rootDir, 'guardian-spawn.lock'),
    logFile: path.join(rootDir, 'guardian.log')
  };
}
