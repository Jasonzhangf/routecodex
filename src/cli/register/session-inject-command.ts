import type { Command } from 'commander';

import { createSessionInjectCommand, type SessionInjectCommandContext } from '../commands/session-inject.js';

export function registerSessionInjectCommand(program: Command, ctx: SessionInjectCommandContext): void {
  createSessionInjectCommand(program, ctx);
}
