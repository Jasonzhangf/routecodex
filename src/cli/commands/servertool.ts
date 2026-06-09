import type { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVERTOOL_BINARY_NAME = process.platform === 'win32' ? 'routecodex-servertool.exe' : 'routecodex-servertool';

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
    .option('--flow <flowId>', 'servertool flow id')
    .action(async (toolName: string, options: { inputJson: string; flow?: string }) => {
      try {
        const args = ['run', toolName, '--input-json', options.inputJson];
        if (typeof options.flow === 'string') {
          args.push('--flow', options.flow);
        }
        const result = execFileSync(
          resolveServertoolBinary(),
          args,
          {
            encoding: 'utf8',
            timeout: 30_000,
            stdio: ['ignore', 'pipe', 'pipe']
          }
        );
        deps.log(result.trimEnd());
      } catch (error) {
        const message = formatServertoolBinaryError(error);
        deps.error(message);
        deps.exit(1);
      }
    });
}

function resolveServertoolBinary(): string {
  const envPath = typeof process.env.ROUTECODEX_SERVERTOOL_BIN === 'string'
    ? process.env.ROUTECODEX_SERVERTOOL_BIN.trim()
    : '';
  const candidates = [
    envPath,
    resolve(__dirname, '../../../sharedmodule/llmswitch-core/dist/bin', SERVERTOOL_BINARY_NAME),
    resolve(process.cwd(), 'sharedmodule/llmswitch-core/dist/bin', SERVERTOOL_BINARY_NAME),
    resolve(process.cwd(), 'sharedmodule/llmswitch-core/rust-core/target/release', SERVERTOOL_BINARY_NAME),
    resolve(process.cwd(), 'sharedmodule/llmswitch-core/rust-core/target/debug', SERVERTOOL_BINARY_NAME)
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`SERVERTOOL_BINARY_NOT_FOUND: ${candidates.join(', ')}`);
}

function formatServertoolBinaryError(error: unknown): string {
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const stderr = typeof record.stderr === 'string'
      ? record.stderr
      : Buffer.isBuffer(record.stderr)
        ? record.stderr.toString('utf8')
        : '';
    if (stderr.trim()) {
      return stderr.trim();
    }
  }
  return error instanceof Error ? error.message : String(error ?? 'unknown');
}
