import type { Command } from 'commander';

import { createClockAdminCommand, type ClockAdminCommandContext } from '../commands/clock-admin.js';

export function registerClockAdminCommand(program: Command, ctx: ClockAdminCommandContext): void {
  createClockAdminCommand(program, ctx);
}
