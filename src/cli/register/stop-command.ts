import type { Command } from 'commander';

import { createStopCommand, type StopCommandContext } from '../commands/stop.js';

export function registerStopCommand(program: Command, ctx: StopCommandContext): void {
  createStopCommand(program, ctx);
}
