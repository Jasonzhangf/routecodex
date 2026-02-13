import type { Command } from 'commander';

import type { LoadedRouteCodexConfig } from '../../config/routecodex-config-loader.js';
import type { ManagedZombieProcess } from '../../utils/managed-server-pids.js';
import type { CliLogger } from '../logger.js';
import type { Spinner } from '../spinner.js';
import { createConfigCommand } from '../commands/config.js';
import { createStatusCommand } from '../commands/status.js';

export function registerStatusConfigCommands(
  program: Command,
  deps: {
    config: {
      logger: CliLogger;
      createSpinner: (text: string) => Promise<Spinner>;
    };
    status: {
      logger: CliLogger;
      log: (line: string) => void;
      loadConfig: () => Promise<LoadedRouteCodexConfig>;
      fetch: typeof fetch;
      listManagedZombieChildren?: (port: number) => ManagedZombieProcess[];
    };
  }
): void {
  createConfigCommand(program, deps.config);
  createStatusCommand(program, deps.status);
}
