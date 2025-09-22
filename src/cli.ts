#!/usr/bin/env node

/**
 * RouteCodex CLI - ESM entry point
 * Multi-provider OpenAI proxy server command line interface
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import path from 'path';
import fs from 'fs';
import { homedir } from 'os';

// Simple logger
const logger = {
  info: (msg: string) => console.log(chalk.blue('ℹ') + ' ' + msg),
  success: (msg: string) => console.log(chalk.green('✓') + ' ' + msg),
  warning: (msg: string) => console.log(chalk.yellow('⚠') + ' ' + msg),
  error: (msg: string) => console.log(chalk.red('✗') + ' ' + msg),
  debug: (msg: string) => console.log(chalk.gray('◉') + ' ' + msg)
};

// CLI program setup
const program = new Command();

program
  .name('routecodex')
  .description('Multi-provider OpenAI proxy server')
  .version('0.0.1');

// Start command
program
  .command('start')
  .description('Start the RouteCodex server')
  .option('-p, --port <port>', 'Server port', '5506')
  .option('-h, --host <host>', 'Server host', 'localhost')
  .option('-c, --config <config>', 'Configuration file path')
  .option('--log-level <level>', 'Log level (debug, info, warn, error)', 'info')
  .action(async (options) => {
    const spinner = ora('Starting RouteCodex server...').start();

    try {
      // Import ESM modules dynamically
      const { RouteCodexServer } = await import('./server/RouteCodexServer.js');

      // Resolve config path
      let configPath = options.config;
      if (!configPath) {
        configPath = path.join(homedir(), '.routecodex', 'config.json');
      }

      // Check if config exists
      if (!fs.existsSync(configPath)) {
        spinner.warn(`Configuration file not found: ${configPath}`);
        logger.info('Creating default configuration...');

        // Create config directory if it doesn't exist
        const configDir = path.dirname(configPath);
        if (!fs.existsSync(configDir)) {
          fs.mkdirSync(configDir, { recursive: true });
        }

        // Load default config template
        const templatePath = path.join(homedir(), '.routecodex', 'default.json');
        let defaultConfig: any = {
          server: {
            port: parseInt(options.port),
            host: options.host
          },
          logging: {
            level: options.logLevel
          },
          providers: {}
        };

        // Use template if available
        if (fs.existsSync(templatePath)) {
          const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
          defaultConfig = {
            ...template,
            server: {
              ...template.server,
              port: parseInt(options.port),
              host: options.host
            },
            logging: {
              ...template.logging,
              level: options.logLevel
            }
          };
        }

        fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
        logger.success(`Default configuration created: ${configPath}`);
      }

      // Load configuration
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

      // Override with command line options
      if (options.port) config.server.port = parseInt(options.port);
      if (options.host) config.server.host = options.host;
      if (options.logLevel) config.logging.level = options.logLevel;

      // Create and start server
      const server = new RouteCodexServer(config);
      await server.initialize();
      await server.start();

      spinner.succeed(`RouteCodex server started on ${options.host}:${options.port}`);
      logger.info(`Configuration loaded from: ${configPath}`);
      logger.info('Press Ctrl+C to stop the server');

      // Handle graceful shutdown
      process.on('SIGINT', async () => {
        logger.info('Shutting down server...');
        await server.stop();
        process.exit(0);
      });

    } catch (error) {
      spinner.fail('Failed to start server');
      logger.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Config command
program
  .command('config')
  .description('Configuration management')
  .argument('<action>', 'Action to perform (show, edit, validate)')
  .option('-c, --config <config>', 'Configuration file path')
  .action(async (action, options) => {
    try {
      const configPath = options.config || path.join(homedir(), '.routecodex', 'config.json');

      switch (action) {
        case 'show':
          if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            console.log(JSON.stringify(config, null, 2));
          } else {
            logger.error('Configuration file not found');
          }
          break;

        case 'edit':
          const editor = process.env.EDITOR || 'nano';
          const { spawn } = await import('child_process');
          spawn(editor, [configPath], { stdio: 'inherit' });
          break;

        case 'validate':
          if (fs.existsSync(configPath)) {
            try {
              JSON.parse(fs.readFileSync(configPath, 'utf8'));
              logger.success('Configuration is valid');
            } catch (error) {
              logger.error('Configuration is invalid: ' + (error instanceof Error ? error.message : String(error)));
            }
          } else {
            logger.error('Configuration file not found');
          }
          break;

        default:
          logger.error('Unknown action. Use: show, edit, validate');
      }
    } catch (error) {
      logger.error('Config command failed: ' + (error instanceof Error ? error.message : String(error)));
    }
  });

// Status command
program
  .command('status')
  .description('Show server status')
  .option('-j, --json', 'Output in JSON format')
  .action(async (options) => {
    try {
      // Check if server is running by trying to connect
      const { get } = await import('https');

      const checkServer = (port: number, host: string): Promise<any> => {
        return new Promise((resolve) => {
          const req = get({
            hostname: host,
            port: port,
            path: '/health',
            method: 'GET',
            timeout: 5000
          }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              try {
                const health = JSON.parse(data);
                resolve(health);
              } catch {
                resolve({ status: 'unknown', message: 'Invalid response' });
              }
            });
          });

          req.on('error', () => {
            resolve({ status: 'stopped', message: 'Server not running' });
          });

          req.on('timeout', () => {
            req.destroy();
            resolve({ status: 'timeout', message: 'Server timeout' });
          });

          req.end();
        });
      };

      const status = await checkServer(5506, 'localhost');

      if (options.json) {
        console.log(JSON.stringify(status, null, 2));
      } else {
        switch (status.status) {
          case 'running':
            logger.success('Server is running');
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
      logger.error('Status check failed: ' + (error instanceof Error ? error.message : String(error)));
    }
  });

// Parse command line arguments
program.parse();