import type { Command } from 'commander';

import type { Spinner } from '../spinner.js';
import type { CliLogger } from '../logger.js';
import { createCleanCommand } from '../commands/clean.js';
import { createEnvCommand } from '../commands/env.js';
import { createExamplesCommand } from '../commands/examples.js';
import { createPortCommand } from '../commands/port.js';

export function registerBasicCommands(
  program: Command,
  deps: {
    env: {
      isDevPackage: boolean;
      defaultDevPort: number;
      log: (line: string) => void;
      error: (line: string) => void;
      exit: (code: number) => never;
    };
    clean: {
      logger: CliLogger;
    };
    examples: {
      log: (line: string) => void;
    };
    port: {
      defaultPort: number;
      createSpinner: (text: string) => Promise<Spinner>;
      findListeningPids: (port: number) => number[];
      killPidBestEffort: (pid: number, opts: { force: boolean }) => void;
      sleep: (ms: number) => Promise<void>;
      log: (line: string) => void;
      error: (line: string) => void;
      exit: (code: number) => never;
    };
  }
): void {
  createEnvCommand(program, deps.env);
  createCleanCommand(program, deps.clean);
  createExamplesCommand(program, deps.examples);
  createPortCommand(program, deps.port);
}
