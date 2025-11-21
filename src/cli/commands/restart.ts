import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import { createSpinner } from '../spinner.js';
import { logger } from '../logger.js';
import { LOCAL_HOSTS, HTTP_PROTOCOLS, API_PATHS } from '../../constants/index.js';
import { getModulesConfigPath } from '../config-resolver.js';
import { findListeningPids, sleep, setupKeypress } from '../server-runner.js';

export function registerRestartCommand(program: Command) {
  program
    .command('restart')
    .description('Restart the RouteCodex server')
    .option('-c, --config <config>', 'Configuration file path')
    .option('--log-level <level>', 'Log level (debug, info, warn, error)', 'info')
    .option('--codex', 'Use Codex system prompt (tools unchanged)')
    .option('--claude', 'Use Claude system prompt (tools unchanged)')
    .action(async (options) => {
      const spinner = await createSpinner('Restarting RouteCodex server...');
      try {
        const configPath = options.config || path.join(homedir(), '.routecodex', 'config.json');
        if (!fs.existsSync(configPath)) {
          spinner.fail(`Configuration file not found: ${configPath}`);
          logger.error('Cannot determine server port without configuration file');
          logger.info('Please create a configuration file first:');
          logger.info('  rcc config init');
          process.exit(1);
        }

        let config;
        try {
          const configContent = fs.readFileSync(configPath, 'utf8');
          config = JSON.parse(configContent);
        } catch (error) {
          spinner.fail('Failed to parse configuration file');
          logger.error(`Invalid JSON in configuration file: ${configPath}`);
          process.exit(1);
        }

        const port = (config?.httpserver?.port ?? config?.server?.port ?? config?.port);
        if (!port || typeof port !== 'number' || port <= 0) {
          spinner.fail('Invalid or missing port configuration');
          logger.error('Configuration file must specify a valid port number');
          process.exit(1);
        }

        const resolvedPort = port;

        // Stop current instance (if any)
        const pids = findListeningPids(resolvedPort);
        if (pids.length) {
          for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ } }
          const deadline = Date.now() + 3500;
          while (Date.now() < deadline) {
            if (findListeningPids(resolvedPort).length === 0) {break;}
            await sleep(120);
          }
          const remain = findListeningPids(resolvedPort);
          for (const pid of remain) { try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ } }
        }

        spinner.text = 'Starting RouteCodex server...';

        // Delegate to start behavior
        const nodeBin = process.execPath;
        const serverEntry = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../index.js');
        const { spawn } = await import('child_process');

        if (options.codex && options.claude) {
          spinner.fail('Flags --codex and --claude are mutually exclusive');
          process.exit(1);
        }
        if (options.codex) { process.env.ROUTECODEX_SYSTEM_PROMPT_SOURCE = 'codex'; }
        else if (options.claude) { process.env.ROUTECODEX_SYSTEM_PROMPT_SOURCE = 'claude'; }
        else if (!process.env.ROUTECODEX_SYSTEM_PROMPT_SOURCE) {
          process.env.ROUTECODEX_SYSTEM_PROMPT_SOURCE = 'codex';
        }

        const modulesConfigPath = getModulesConfigPath();
        const env = { ...process.env } as NodeJS.ProcessEnv;
        const args: string[] = [serverEntry, modulesConfigPath];
        const child = spawn(nodeBin, args, { stdio: 'inherit', env });
        try { fs.writeFileSync(path.join(homedir(), '.routecodex', 'server.cli.pid'), String(child.pid ?? ''), 'utf8'); } catch {}

        const host = (config?.httpserver?.host || config?.server?.host || config?.host || LOCAL_HOSTS.LOCALHOST);
        spinner.succeed(`RouteCodex server restarting on ${host}:${resolvedPort}`);
        logger.info(`Server will run on port: ${resolvedPort}`);
        logger.info('Press Ctrl+C to stop the server');

        const shutdown = async (sig: NodeJS.Signals) => {
          try { await fetch(`${HTTP_PROTOCOLS.HTTP}${LOCAL_HOSTS.IPV4}:${resolvedPort}${API_PATHS.SHUTDOWN}`, { method: 'POST' }).catch(() => {}); } catch {}
          try { child.kill(sig); } catch {}
          try { if (child.pid) { process.kill(-child.pid, sig); } } catch {}
          const deadline = Date.now() + 3500;
          while (Date.now() < deadline) {
            if (findListeningPids(resolvedPort).length === 0) {break;}
            await sleep(120);
          }
          const remain = findListeningPids(resolvedPort);
          for (const pid of remain) { try { process.kill(pid, 'SIGTERM'); } catch {} }
          const killDeadline = Date.now() + 1500;
          while (Date.now() < killDeadline) {
            if (findListeningPids(resolvedPort).length === 0) {break;}
            await sleep(100);
          }
          const still = findListeningPids(resolvedPort);
          for (const pid of still) { try { process.kill(pid, 'SIGKILL'); } catch {} }
          try { process.exit(0); } catch {}
        };
        process.on('SIGINT', () => { void shutdown('SIGINT'); });
        process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

        const cleanupKeypress2 = setupKeypress(() => { void shutdown('SIGINT'); });
        child.on('exit', (code, signal) => {
          try { cleanupKeypress2(); } catch {}
          if (signal) {process.exit(0);} else {process.exit(code ?? 0);} 
        });
        await new Promise(() => {});
      } catch (e) {
        spinner.fail(`Failed to restart: ${(e as Error).message}`);
        process.exit(1);
      }
    });
}

