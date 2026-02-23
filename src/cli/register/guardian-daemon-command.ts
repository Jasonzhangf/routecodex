import type { Command } from 'commander';

import { createGuardianDaemonCommand } from '../commands/guardian-daemon.js';

export function registerGuardianDaemonCommand(program: Command): void {
  createGuardianDaemonCommand(program);
}
