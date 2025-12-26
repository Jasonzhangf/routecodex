import { Command } from 'commander';
import fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';
import { TokenDaemon } from '../token-daemon/index.js';
import {
  printStatus,
  printServers,
  printProviders,
  printTokens,
  interactiveRefresh
} from '../token-daemon/index.js';

const TOKEN_DAEMON_PID_FILE = path.join(homedir(), '.routecodex', 'token-daemon.pid');

export function createTokenDaemonCommand(): Command {
  const cmd = new Command('token-daemon');
  cmd
    .description('Background daemon for monitoring and refreshing OAuth tokens');

  cmd
    .command('start')
    .description('Start token refresh daemon (runs in foreground, Ctrl+C to stop)')
    .option('--interval <seconds>', 'Polling interval in seconds', '60')
    .option(
      '--refresh-ahead-minutes <minutes>',
      'Minutes before expiry to attempt silent refresh',
      '30'
    )
    .action(async (options: { interval?: string; refreshAheadMinutes?: string }) => {
      const intervalMs = Number(options.interval || '60') * 1000;
      const refreshAheadMinutes = Number(options.refreshAheadMinutes || '30');
      const daemon = new TokenDaemon({
        intervalMs: Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : undefined,
        refreshAheadMinutes: Number.isFinite(refreshAheadMinutes) && refreshAheadMinutes > 0
          ? refreshAheadMinutes
          : undefined
      });

      // write PID file for auto-start / detection
      try {
        const dir = path.dirname(TOKEN_DAEMON_PID_FILE);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(TOKEN_DAEMON_PID_FILE, String(process.pid), 'utf8');
      } catch {
        // non-fatal
      }

      await daemon.start();

      const cleanupAndExit = async () => {
        daemon.stop();
        try {
          await fs.unlink(TOKEN_DAEMON_PID_FILE);
        } catch {
          // ignore
        }
        process.exit(0);
      };

      const handleStop = () => {
        void cleanupAndExit();
      };
      process.on('SIGINT', handleStop);
      process.on('SIGTERM', handleStop);
    });

  cmd
    .command('status')
    .description('Print current token status snapshot')
    .option('--json', 'Output raw JSON snapshot', false)
    .action(async (options: { json?: boolean }) => {
      await printStatus(!!options.json);
    });

  cmd
    .command('servers')
    .description('List detected RouteCodex server instances')
    .option('--json', 'Output raw JSON', false)
    .action(async (options: { json?: boolean }) => {
      await printServers(!!options.json);
    });

  cmd
    .command('providers')
    .description('List providers and auth bindings for each server')
    .option('--json', 'Output raw JSON', false)
    .action(async (options: { json?: boolean }) => {
      await printProviders(!!options.json);
    });

  cmd
    .command('tokens')
    .description('List OAuth tokens and their usage across servers')
    .option('--json', 'Output raw JSON', false)
    .action(async (options: { json?: boolean }) => {
      await printTokens(!!options.json);
    });

  cmd
    .command('refresh')
    .description('Trigger interactive re-auth for a specific token (opens browser)')
    .argument(
      '<selector>',
      'Token selector: file basename, full path, or provider id (e.g. "iflow-oauth-1-work.json")'
    )
    .action(async (selector: string) => {
      await interactiveRefresh(selector);
    });

  return cmd;
}
