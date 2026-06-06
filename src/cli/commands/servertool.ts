import type { Command } from 'commander';
import { executeServertoolCliTicket } from 'rcc-llmswitch-core/v2/servertool/cli-executor';

export function createServertoolCommand(
  program: Command,
  deps: {
    log: (line: string) => void;
    error: (line: string) => void;
    exit: (code: number) => never;
  }
): void {
  const servertool = program
    .command('servertool')
    .description('Run RouteCodex servertool CLI operations');

  servertool
    .command('run')
    .description('Run a servertool ticket')
    .requiredOption('--ticket <ticketId>', 'servertool ticket id')
    .action(async (options: { ticket: string }) => {
      try {
        const result = await executeServertoolCliTicket(String(options.ticket || '').trim());
        deps.log(JSON.stringify(result));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error ?? 'unknown');
        deps.error(message);
        deps.exit(1);
      }
    });
}
