import type { Command } from 'commander';

import { TokenDaemon } from '../../token-daemon/index.js';
import { openAuthInCamoufox } from '../../providers/core/config/camoufox-launcher.js';
import { createCamoufoxCommand } from '../commands/camoufox.js';

export function registerCamoufoxCommand(
  program: Command,
  deps: {
    env: Record<string, string | undefined>;
    fsImpl: { existsSync: (path: string) => boolean; statSync: (path: string) => { isFile: () => boolean } };
    pathImpl: {
      resolve: (...paths: string[]) => string;
      join: (...paths: string[]) => string;
      basename: (p: string) => string;
      isAbsolute: (p: string) => boolean;
    };
    homedir: () => string;
    log: (line: string) => void;
    error: (line: string) => void;
    exit: (code: number) => never;
  }
): void {
  createCamoufoxCommand(program, {
    env: deps.env,
    fsImpl: deps.fsImpl,
    pathImpl: deps.pathImpl,
    homedir: deps.homedir,
    findTokenBySelector: async (selector) => {
      const token = await TokenDaemon.findTokenBySelector(selector);
      if (!token) return null;
      return { provider: token.provider, alias: token.alias || 'default', filePath: token.filePath };
    },
    openInCamoufox: async (opts) => openAuthInCamoufox(opts),
    log: deps.log,
    error: deps.error,
    exit: deps.exit
  });
}

