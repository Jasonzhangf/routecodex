import type { Command } from 'commander';
import {
  executeServertoolCliCommand,
  parseServertoolCliInputJson
} from 'rcc-llmswitch-core/v2/servertool/cli-executor';

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
    .command('run <toolName>')
    .description('Run a RouteCodex servertool')
    .requiredOption('--input-json <json>', 'servertool input JSON object')
    .action(async (toolName: string, options: { inputJson: string }) => {
      try {
        const result = await executeServertoolCliCommand({
          toolName,
          input: parseServertoolCliInputJson(options.inputJson)
        });
        deps.log(JSON.stringify(result));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error ?? 'unknown');
        deps.error(message);
        deps.exit(1);
      }
    });
}
