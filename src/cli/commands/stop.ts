import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import { createSpinner } from '../spinner.js';
import { logger } from '../logger.js';
import { findListeningPids, sleep } from '../server-runner.js';

export function registerStopCommand(program: Command) {
  program
    .command('stop')
    .description('Stop the RouteCodex server')
    .action(async () => {
      const spinner = await createSpinner('Stopping RouteCodex server...');
      try {
        const configPath = path.join(homedir(), '.routecodex', 'config.json');
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
        const pids = findListeningPids(resolvedPort);
        if (!pids.length) {
          spinner.succeed(`No server listening on ${resolvedPort}.`);
          return;
        }
        for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ } }
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          if (findListeningPids(resolvedPort).length === 0) {
            spinner.succeed(`Stopped server on ${resolvedPort}.`);
            return;
          }
          await sleep(100);
        }
        const remain = findListeningPids(resolvedPort);
        if (remain.length) {
          for (const pid of remain) { try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ } }
        }
        spinner.succeed(`Force stopped server on ${resolvedPort}.`);
      } catch (e) {
        spinner.fail(`Failed to stop: ${(e as Error).message}`);
        process.exit(1);
      }
    });
}

