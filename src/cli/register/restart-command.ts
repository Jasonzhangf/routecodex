import type { Command } from 'commander';

import { createRestartCommand, type RestartCommandContext } from '../commands/restart.js';

export function registerRestartCommand(program: Command, ctx: RestartCommandContext): void {
  createRestartCommand(program, ctx);
}
