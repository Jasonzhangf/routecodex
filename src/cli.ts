#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { registerStartCommand } from './cli/commands/start.js';
import { registerStopCommand } from './cli/commands/stop.js';
import { registerRestartCommand } from './cli/commands/restart.js';
import { registerStatusCommand } from './cli/commands/status.js';
import { registerPortCommand } from './cli/commands/port.js';
import { registerConfigCommand } from './cli/commands/config.js';
import { registerCodeCommand } from './cli/commands/code.js';
import { registerCleanCommand } from './cli/commands/clean.js';
import { registerMonitorCommand } from './cli/commands/monitor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const program = new Command();

const pkg = (() => {
  try { return JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')); }
  catch { return { name: 'routecodex', version: '0.0.0' }; }
})();
const pkgName: string = typeof pkg?.name === 'string' ? pkg.name : 'routecodex';
const pkgVersion: string = typeof pkg?.version === 'string' ? pkg.version : '0.0.0';
const IS_DEV_PACKAGE = pkgName === 'routecodex';
const DEFAULT_DEV_PORT = 5555;

program
  .name(pkgName === 'rcc' ? 'rcc' : 'routecodex')
  .description('RouteCodex CLI - Multi-provider OpenAI proxy server and Claude Code interface')
  .version(pkgVersion);

// Optional commands registered when available
try {
  const { createProviderUpdateCommand } = await import('./commands/provider-update.js');
  program.addCommand(createProviderUpdateCommand());
} catch {}
try {
  const { createValidateCommand } = await import('./commands/validate.js');
  program.addCommand(createValidateCommand());
} catch {}

// Core commands (function化注册)
registerCodeCommand(program, IS_DEV_PACKAGE, DEFAULT_DEV_PORT);
registerStartCommand(program, IS_DEV_PACKAGE);
registerConfigCommand(program);
registerStopCommand(program);
registerRestartCommand(program);
registerStatusCommand(program);
registerCleanCommand(program);
registerMonitorCommand(program);
registerPortCommand(program);

// 简化的 examples（小体量保留在入口）
program
  .command('examples')
  .description('Show usage examples')
  .action(() => {
    console.log(chalk.cyan('RouteCodex Usage Examples'));
    console.log('='.repeat(40));
    console.log('\n- rcc config init\n- rcc start\n- rcc code --ensure-server\n- rcc status');
  });

program.parse();

