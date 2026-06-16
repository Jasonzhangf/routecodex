import type { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordStoplessContinuationState } from '../../modules/llmswitch/bridge/state-integrations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVERTOOL_BINARY_NAME = process.platform === 'win32' ? 'routecodex-servertool.exe' : 'routecodex-servertool';
const STOPLESS_PUBLIC_TOOL_NAME = 'reasoning_stop';
const STOPLESS_INTERNAL_TOOL_NAME = 'stop_message_auto';

export function createServertoolCommand(
  program: Command,
  deps: {
    log: (line: string) => void;
    error: (line: string) => void;
    exit: (code: number) => never;
  }
): void {
  const servertool = program
    .command('hook')
    .alias('servertool')
    .description('Run RouteCodex hook CLI operations');

  servertool
    .command('run <toolName>')
    .description('Run a RouteCodex servertool')
    .requiredOption('--input-json <json>', 'servertool input JSON object')
    .option('--flow <flowId>', 'servertool flow id')
    .option('--repeat-count <count>', 'stopless repeat count')
    .option('--max-repeats <count>', 'stopless max repeats')
    .option('--session-id <sessionId>', 'stopless session id')
    .option('--request-id <requestId>', 'stopless request id')
    .action(async (toolName: string, options: { inputJson: string; flow?: string; repeatCount?: string; maxRepeats?: string; sessionId?: string; requestId?: string }) => {
      try {
        const args = ['run', toolName, '--input-json', options.inputJson];
        if (typeof options.flow === 'string') {
          args.push('--flow', options.flow);
        }
        if (typeof options.repeatCount === 'string') {
          args.push('--repeat-count', options.repeatCount);
        }
        if (typeof options.maxRepeats === 'string') {
          args.push('--max-repeats', options.maxRepeats);
        }
        if (typeof options.sessionId === 'string') {
          args.push('--session-id', options.sessionId);
        }
        if (typeof options.requestId === 'string') {
          args.push('--request-id', options.requestId);
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
        const trimmed = result.trimEnd();
        if (toolName === STOPLESS_INTERNAL_TOOL_NAME || toolName === STOPLESS_PUBLIC_TOOL_NAME) {
          const payload = JSON.parse(trimmed) as Record<string, unknown>;
          const sessionId = typeof options.sessionId === 'string' && options.sessionId.trim()
            ? options.sessionId.trim()
            : (typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '');
          const requestId = typeof options.requestId === 'string' && options.requestId.trim()
            ? options.requestId.trim()
            : (typeof payload.requestId === 'string' ? payload.requestId.trim() : '');
          if (!sessionId || !requestId) {
            throw new Error('SERVERTOOL_CLI_MISSING_STOPLESS_IDENTITY: sessionId/requestId');
          }
          const continuationPrompt = typeof payload.continuationPrompt === 'string'
            ? payload.continuationPrompt
            : '';
          const repeatCount = typeof payload.repeatCount === 'number'
            ? payload.repeatCount
            : Number(payload.repeatCount ?? 0);
          const maxRepeats = typeof payload.maxRepeats === 'number'
            ? payload.maxRepeats
            : Number(payload.maxRepeats ?? 0);
          await recordStoplessContinuationState({
            sessionId,
            requestId,
            text: continuationPrompt,
            nextUsed: repeatCount,
            maxRepeats
          });
        }
        deps.log(trimmed);
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
