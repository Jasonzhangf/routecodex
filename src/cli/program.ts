import { Command } from 'commander';

import type { CliRuntime } from './runtime.js';

export type CliProgramContext = {
  pkgName: string;
  cliVersion: string;
  runtime: CliRuntime;
};

export function createCliProgram(ctx: CliProgramContext): Command {
  const program = new Command();

  program.configureOutput({
    writeOut: (str) => ctx.runtime.writeOut(str),
    writeErr: (str) => ctx.runtime.writeErr(str)
  });

  program
    .name(ctx.pkgName === 'rcc' ? 'rcc' : 'routecodex')
    .description('RouteCodex CLI - Multi-provider OpenAI proxy server and Claude Code interface')
    .version(ctx.cliVersion);

  // Keep behavior deterministic in tests (Commander will treat extra args as unknown command).
  program.command('noop', { hidden: true }).description('internal').action(() => {});

  return program;
}

