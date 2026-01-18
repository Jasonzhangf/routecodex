import type { Command } from 'commander';

import { createStartCommand, type StartCommandContext } from '../commands/start.js';

export function registerStartCommand(program: Command, ctx: StartCommandContext): void {
  createStartCommand(program, ctx);
}
