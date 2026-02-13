import type { Command } from 'commander';

import { createTmuxInjectCommand, type TmuxInjectCommandContext } from '../commands/tmux-inject.js';

export function registerTmuxInjectCommand(program: Command, ctx: TmuxInjectCommandContext): void {
  createTmuxInjectCommand(program, ctx);
}
