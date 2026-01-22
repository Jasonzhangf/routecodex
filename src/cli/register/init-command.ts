import type { Command } from 'commander';

import { createInitCommand, type InitCommandContext } from '../commands/init.js';

export function registerInitCommand(program: Command, ctx: InitCommandContext): void {
  createInitCommand(program, ctx);
}

