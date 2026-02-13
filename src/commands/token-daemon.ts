import { Command } from 'commander';
import fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { TokenDaemon } from '../token-daemon/index.js';
import {
  printStatus,
  printServers,
  printProviders,
  printTokens,
  interactiveRefresh
} from '../token-daemon/index.js';
import {
  tryAcquireTokenManagerLeader,
  releaseTokenManagerLeader
} from '../token-daemon/leader-lock.js';
import { logProcessLifecycle } from '../utils/process-lifecycle-logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TOKEN_DAEMON_PID_FILE = path.join(homedir(), '.routecodex', 'token-daemon.pid');
const CLI_ENTRY = path.resolve(__dirname, '../cli.js');

async function safeInteractiveRefresh(selector: string, options: { force?: boolean }): Promise<void> {
  try {
    await interactiveRefresh(selector, options);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`✗ OAuth failed: ${msg}`);
    process.exitCode = 1;
  }
}

export function createTokenDaemonCommand(): Command {
  const cmd = new Command('token-daemon');
  cmd
    .description('Background daemon for monitoring and refreshing OAuth tokens')
    .argument(
      '[selector]',
      'Token selector: file basename, full path, or provider id (e.g. "iflow-oauth-1-work.json")'
    )
    .action(async (selector?: string) => {
      if (!selector) {
        cmd.outputHelp();
        return;
      }
      await safeInteractiveRefresh(selector, { force: true });
    });

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
      await startDaemonForeground(options);
    });

  cmd
    .command('restart')
    .description('Stop existing daemon if running, then start a new one in background')
    .option('--interval <seconds>', 'Polling interval in seconds', '60')
    .option(
      '--refresh-ahead-minutes <minutes>',
      'Minutes before expiry to attempt silent refresh',
      '30'
    )
    .action(async (options: { interval?: string; refreshAheadMinutes?: string }) => {
      const stopped = await stopExistingDaemon();
      if (stopped) {
        console.log('Stopped existing token daemon');
        await delay(300);
      } else {
        console.log('No existing token daemon detected');
      }
      await startDaemonBackground(options);
      console.log('Token daemon restarted in background');
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
      await safeInteractiveRefresh(selector, { force: true });
    });

  return cmd;
}

async function startDaemonForeground(options: { interval?: string; refreshAheadMinutes?: string }): Promise<void> {
  const ownerId = 'cli:token-daemon';
  const { isLeader, leader } = await tryAcquireTokenManagerLeader(ownerId);
  if (!isLeader) {
    const owner = leader?.ownerId ?? 'unknown';
    const pid = leader?.pid ?? 'unknown';
    console.error(
      'Token manager leader already active (owner=%s, pid=%s); refusing to start a second token daemon.',
      owner,
      pid
    );
    process.exitCode = 1;
    return;
  }

  const intervalMs = Number(options.interval || '60') * 1000;
  const refreshAheadMinutes = Number(options.refreshAheadMinutes || '5');
  const daemon = new TokenDaemon({
    intervalMs: Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : undefined,
    refreshAheadMinutes: Number.isFinite(refreshAheadMinutes) && refreshAheadMinutes > 0
      ? refreshAheadMinutes
      : undefined
  });

  await writePidFile(String(process.pid));
  await daemon.start();

  const cleanupAndExit = async () => {
    await daemon.stop();
    await releaseTokenManagerLeader(ownerId);
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
}

async function startDaemonBackground(options: { interval?: string; refreshAheadMinutes?: string }): Promise<void> {
  const args = buildStartArgs(options);
  logProcessLifecycle({
    event: 'detached_spawn',
    source: 'token-daemon.startBackground',
    details: {
      role: 'token-daemon',
      result: 'attempt',
      command: process.execPath,
      args
    }
  });

  try {
    const child = spawn(process.execPath, args, {
      stdio: 'ignore',
      detached: true,
      env: { ...process.env }
    });

    child.once('error', (error) => {
      logProcessLifecycle({
        event: 'detached_spawn',
        source: 'token-daemon.startBackground',
        details: {
          role: 'token-daemon',
          result: 'failed',
          command: process.execPath,
          args,
          childPid: child.pid ?? null,
          error
        }
      });
    });

    logProcessLifecycle({
      event: 'detached_spawn',
      source: 'token-daemon.startBackground',
      details: {
        role: 'token-daemon',
        result: 'success',
        command: process.execPath,
        args,
        childPid: child.pid ?? null
      }
    });

    try {
      child.unref();
    } catch {
      // ignore
    }
  } catch (error) {
    logProcessLifecycle({
      event: 'detached_spawn',
      source: 'token-daemon.startBackground',
      details: {
        role: 'token-daemon',
        result: 'failed',
        command: process.execPath,
        args,
        error
      }
    });
    throw error;
  }
}

async function stopExistingDaemon(): Promise<boolean> {
  let pidFile: string | null = null;
  try {
    pidFile = await fs.readFile(TOKEN_DAEMON_PID_FILE, 'utf8');
  } catch {
    return false;
  }
  if (!pidFile) {
    return false;
  }
  const pid = Number(pidFile.trim());
  if (!Number.isFinite(pid)) {
    return false;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ESRCH') {
      console.warn(`Failed to stop token daemon (pid=${pid}): ${err.message}`);
    }
  }
  try {
    await fs.unlink(TOKEN_DAEMON_PID_FILE);
  } catch {
    // ignore
  }
  return true;
}

function buildStartArgs(options: { interval?: string; refreshAheadMinutes?: string }): string[] {
  const args = [CLI_ENTRY, 'token-daemon', 'start'];
  if (options.interval) {
    args.push('--interval', options.interval);
  }
  if (options.refreshAheadMinutes) {
    args.push('--refresh-ahead-minutes', options.refreshAheadMinutes);
  }
  return args;
}

async function writePidFile(pid: string): Promise<void> {
  try {
    const dir = path.dirname(TOKEN_DAEMON_PID_FILE);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(TOKEN_DAEMON_PID_FILE, pid, 'utf8');
  } catch {
    // ignore pid file failures
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
