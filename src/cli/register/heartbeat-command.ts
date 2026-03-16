import type { Command } from 'commander';

import { createHeartbeatCommand, type HeartbeatCommandContext } from '../commands/heartbeat.js';

export function registerHeartbeatCommand(program: Command, ctx: HeartbeatCommandContext): void {
  createHeartbeatCommand(program, ctx);
}
