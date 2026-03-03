import type { Command } from 'commander';

import { createSessionAdminCommand, type SessionAdminCommandContext } from '../commands/session-admin.js';

export function registerSessionAdminCommand(program: Command, ctx: SessionAdminCommandContext): void {
  createSessionAdminCommand(program, ctx);
}
