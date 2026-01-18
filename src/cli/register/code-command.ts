import type { Command } from 'commander';

import { createCodeCommand, type CodeCommandContext } from '../commands/code.js';

export function registerCodeCommand(program: Command, ctx: CodeCommandContext): void {
  createCodeCommand(program, ctx);
}
