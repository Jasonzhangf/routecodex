import type { Command } from 'commander';

import { createClaudeCommand, type ClaudeCommandContext } from '../commands/claude.js';

export function registerClaudeCommand(program: Command, ctx: ClaudeCommandContext): void {
  createClaudeCommand(program, ctx);
}
