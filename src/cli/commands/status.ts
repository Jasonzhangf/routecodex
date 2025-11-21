import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import { logger } from '../logger.js';
import { LOCAL_HOSTS } from '../../constants/index.js';

export function registerStatusCommand(program: Command) {
  program
    .command('status')
    .description('Show server status')
    .option('-j, --json', 'Output in JSON format')
    .action(async (options) => {
      try {
        const configPath = path.join(homedir(), '.routecodex', 'config.json');
        if (!fs.existsSync(configPath)) {
          logger.error('Configuration file not found');
          logger.info('Please create a configuration file first:');
          logger.info('  rcc config init');
          if (options.json) {
            console.log(JSON.stringify({ error: 'Configuration file not found' }, null, 2));
          }
          return;
        }

        let port: number;
        let host: string;
        try {
          const configContent = fs.readFileSync(configPath, 'utf8');
          const config = JSON.parse(configContent);
          port = config?.port || config?.server?.port;
          host = config?.server?.host || config?.host || LOCAL_HOSTS.LOCALHOST;
          if (!port || typeof port !== 'number' || port <= 0) {
            const errorMsg = 'Invalid or missing port configuration in configuration file';
            logger.error(errorMsg);
            if (options.json) console.log(JSON.stringify({ error: errorMsg }, null, 2));
            return;
          }
        } catch (error) {
          const errorMsg = `Failed to parse configuration file: ${configPath}`;
          logger.error(errorMsg);
          if (options.json) console.log(JSON.stringify({ error: errorMsg }, null, 2));
          return;
        }

        const { get } = await import('http');
        const checkServer = (port: number, host: string) => new Promise((resolve) => {
          const req = get({ hostname: host, port, path: '/health', method: 'GET', timeout: 5000 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              try { const health = JSON.parse(data); resolve({ status: health?.status || 'unknown', port, host }); }
              catch { resolve({ status: 'unknown', port, host }); }
            });
          });
          req.on('error', () => resolve({ status: 'stopped', port, host }));
          req.on('timeout', () => { req.destroy(); resolve({ status: 'timeout', port, host }); });
          req.end();
        });

        const status = await checkServer(port, host) as any;
        if (options.json) {
          console.log(JSON.stringify(status, null, 2));
        } else {
          switch (status.status) {
            case 'running':
              logger.success(`Server is running on ${host}:${port}`);
              break;
            case 'stopped':
              logger.error('Server is not running');
              break;
            case 'error':
              logger.error('Server is in error state');
              break;
            default:
              logger.warning('Server status unknown');
          }
        }
      } catch (error) {
        logger.error(`Status check failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}

