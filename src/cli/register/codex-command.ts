import type { Command } from 'commander';

import { createCodexCommand, type CodexCommandContext } from '../commands/codex.js';

export function registerCodexCommand(program: Command, ctx: CodexCommandContext): void {
  createCodexCommand(program, ctx);
}
