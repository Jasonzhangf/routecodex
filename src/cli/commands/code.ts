import type { Command } from 'commander';

type LoggerLike = {
  info: (msg: string) => void;
  warning: (msg: string) => void;
  success: (msg: string) => void;
  error: (msg: string) => void;
};

export type CodeCommandContext = {
  logger: LoggerLike;
  exit: (code: number) => never;
};

export function createCodeCommand(program: Command, ctx: CodeCommandContext): void {
  program
    .command('code')
    .description('Deprecated. Use `rcc claude` instead.')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(() => {
      ctx.logger.error('`rcc code` has been removed. Use `rcc claude` instead.');
      ctx.exit(1);
    });
}
