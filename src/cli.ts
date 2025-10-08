#!/usr/bin/env node

/**
 * RouteCodex CLI - ESM entry point
 * Multi-provider OpenAI proxy server command line interface
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import type { Ora } from 'ora';
import path from 'path';
import fs from 'fs';
import { homedir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import type { UnknownObject } from './types/common-types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ServerConfig {
  port: number;
  host: string;
}

interface LoggingConfig {
  level: string;
}

interface ProvidersConfig {
  [key: string]: unknown;
}

interface DefaultConfig {
  server: ServerConfig;
  logging: LoggingConfig;
  providers: ProvidersConfig;
}

interface TemplateConfig {
  server?: Partial<ServerConfig>;
  logging?: Partial<LoggingConfig>;
  [key: string]: unknown;
}

// simple-log config type removed

interface HealthCheckResult {
  status: string;
  port: number;
  host: string;
  responseTime?: number;
  error?: string;
}

// Simple logger
const logger = {
  info: (msg: string) => console.log(`${chalk.blue('ℹ')  } ${  msg}`),
  success: (msg: string) => console.log(`${chalk.green('✓')  } ${  msg}`),
  warning: (msg: string) => console.log(`${chalk.yellow('⚠')  } ${  msg}`),
  error: (msg: string) => console.log(`${chalk.red('✗')  } ${  msg}`),
  debug: (msg: string) => console.log(`${chalk.gray('◉')  } ${  msg}`)
};

// CLI program setup
const program = new Command();

// Resolve version from package.json at runtime to avoid hardcoding mismatches
const pkgVersion: string = (() => {
  try {
    const pkgPath = path.resolve(__dirname, '..', 'package.json');
    const txt = fs.readFileSync(pkgPath, 'utf-8');
    const j = JSON.parse(txt);
    return typeof j?.version === 'string' ? j.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

program
  .name('routecodex')
  .description('Multi-provider OpenAI proxy server')
  .version(pkgVersion);

// Start command
program
  .command('start')
  .description('Start the RouteCodex server')
  .option('-p, --port <port>', 'Server port', '5506')
  .option('-h, --host <host>', 'Server host', 'localhost')
  .option('-c, --config <config>', 'Configuration file path')
  .option('--log-level <level>', 'Log level (debug, info, warn, error)', 'info')
  .option('--codex', 'Use Codex system prompt (tools unchanged)')
  .option('--claude', 'Use Claude system prompt (tools unchanged)')
  .option('--restart', 'Restart if an instance is already running')
  .action(async (options) => {
    const spinner = ora('Starting RouteCodex server...').start();

    try {
      // Validate system prompt replacement flags
      try {
        if (options.codex && options.claude) {
          spinner.fail('Flags --codex and --claude are mutually exclusive');
          process.exit(1);
        }
        if (options.codex) {
          process.env.ROUTECODEX_SYSTEM_PROMPT_SOURCE = 'codex';
        } else if (options.claude) {
          process.env.ROUTECODEX_SYSTEM_PROMPT_SOURCE = 'claude';
        }
      } catch { /* ignore */ }

      // Prepare to spawn server as child process for robust Ctrl+C handling

      // Resolve config path
      let configPath = options.config;
      if (!configPath) {
        configPath = path.join(homedir(), '.routecodex', 'config.json');
      }

      // Ensure provided config path is a file (not a directory)
      if (fs.existsSync(configPath)) {
        const stats = fs.statSync(configPath);
        if (stats.isDirectory()) {
          spinner.fail(`Configuration path must be a file, received directory: ${configPath}`);
          process.exit(1);
        }
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
        let defaultConfig: DefaultConfig = {
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
          const template: TemplateConfig = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
          defaultConfig = {
            server: {
              ...(template.server || {}),
              port: parseInt(options.port),
              host: options.host
            },
            logging: {
              ...(template.logging || {}),
              level: options.logLevel
            },
            providers: (template as UnknownObject).providers || {}
          } as DefaultConfig;
        }

        fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
        logger.success(`Default configuration created: ${configPath}`);
      }

      // Determine target port from config
      const resolvedPort = determinePort(configPath, parseInt(options.port, 10));

      // Ensure port state aligns with requested behavior (no implicit self-stop)
      await ensurePortAvailable(resolvedPort, spinner, { restart: !!options.restart });

      // simple-log application removed

      // Resolve modules config path
      const modulesConfigPath = getModulesConfigPath();
      if (!fs.existsSync(modulesConfigPath)) {
        spinner.fail(`Modules configuration file not found: ${modulesConfigPath}`);
        process.exit(1);
      }

      // resolvedPort already determined above

      // Spawn child Node process to run the server entry; forward signals
      const nodeBin = process.execPath; // current Node
      const serverEntry = path.resolve(__dirname, 'index.js');
      const child = spawnSync as any; // keep type imports happy
      // Use spawn (not spawnSync); import child_process at top already
      const { spawn } = await import('child_process');

      const env = { ...process.env } as NodeJS.ProcessEnv;
      const args: string[] = [serverEntry, modulesConfigPath];

      const childProc = spawn(nodeBin, args, { stdio: 'inherit', env });
      // Persist child pid for out-of-band stop diagnostics
      try {
        const pidFile = path.join(homedir(), '.routecodex', 'server.cli.pid');
        fs.writeFileSync(pidFile, String(childProc.pid ?? ''), 'utf8');
      } catch { /* ignore */ }

      spinner.succeed(`RouteCodex server starting on ${options.host}:${options.port}`);
      logger.info(`Configuration loaded from: ${configPath}`);
      logger.info('Press Ctrl+C to stop the server');

      // Forward signals to child
      const shutdown = async (sig: NodeJS.Signals) => {
        // 1) Ask server to shutdown over HTTP
        try {
          await fetch(`http://127.0.0.1:${resolvedPort}/shutdown`, { method: 'POST' } as any).catch(() => {});
        } catch { /* ignore */ }
        // 2) Forward signal to child
        try { childProc.kill(sig); } catch { /* ignore */ }
        try { if (childProc.pid) { process.kill(-childProc.pid, sig); } } catch { /* ignore */ }
        // 3) Wait briefly; if still listening, try SIGTERM/SIGKILL by port
        const deadline = Date.now() + 3500;
        while (Date.now() < deadline) {
          if (findListeningPids(resolvedPort).length === 0) break;
          await sleep(120);
        }
        const remain = findListeningPids(resolvedPort);
        if (remain.length) {
          for (const pid of remain) {
            try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
          }
          const killDeadline = Date.now() + 1500;
          while (Date.now() < killDeadline) {
            if (findListeningPids(resolvedPort).length === 0) break;
            await sleep(100);
          }
        }
        const still = findListeningPids(resolvedPort);
        if (still.length) {
          for (const pid of still) {
            try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
          }
        }
        // Ensure parent exits even if child fails to exit
        try { process.exit(0); } catch { /* ignore */ }
      };
      process.on('SIGINT', () => { void shutdown('SIGINT'); });
      process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

      // Fallback keypress handler: capture Ctrl+C / q when some environments swallow SIGINT
      const cleanupKeypress = setupKeypress(() => { void shutdown('SIGINT'); });

      childProc.on('exit', (code, signal) => {
        // Propagate exit code
        try { cleanupKeypress(); } catch { /* ignore */ }
        if (signal) {
          process.exit(0);
        } else {
          process.exit(code ?? 0);
        }
      });

      // Do not exit parent; keep process alive to relay signals
      await new Promise(() => {});

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
  .argument('<action>', 'Action to perform (show, edit, validate, init)')
  .option('-c, --config <config>', 'Configuration file path')
  .option('-t, --template <template>', 'Configuration template (default, lmstudio, oauth)')
  .option('-f, --force', 'Force overwrite existing configuration')
  .action(async (action, options) => {
    try {
      const configPath = options.config || path.join(homedir(), '.routecodex', 'config.json');

      switch (action) {
        case 'init':
          await initializeConfig(configPath, options.template, options.force);
          break;

        case 'show':
          if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            console.log(JSON.stringify(config, null, 2));
          } else {
            logger.error('Configuration file not found');
          }
          break;

        case 'edit': {
          const editor = process.env.EDITOR || 'nano';
          const { spawn } = await import('child_process');
          spawn(editor, [configPath], { stdio: 'inherit' });
          break;
        }

        case 'validate': {
          if (fs.existsSync(configPath)) {
            try {
              JSON.parse(fs.readFileSync(configPath, 'utf8'));
              logger.success('Configuration is valid');
            } catch (error) {
              logger.error(`Configuration is invalid: ${  error instanceof Error ? error.message : String(error)}`);
            }
          } else {
            logger.error('Configuration file not found');
          }
          break;
        }

        default:
          logger.error('Unknown action. Use: show, edit, validate, init');
      }
    } catch (error) {
      logger.error(`Config command failed: ${  error instanceof Error ? error.message : String(error)}`);
    }
  });

// Initialize configuration helper function
async function initializeConfig(configPath: string, template?: string, force: boolean = false) {
  const spinner = ora('Initializing configuration...').start();

  try {
    // Create config directory if it doesn't exist
    const configDir = path.dirname(configPath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    // Check if config already exists
    if (fs.existsSync(configPath) && !force) {
      spinner.warn('Configuration file already exists');
      spinner.info('Use --force flag to overwrite or choose a different path');
      return;
    }

    // Load template
    let templateConfig: TemplateConfig | undefined;

    switch (template) {
      case 'lmstudio':
        templateConfig = {
          server: {
            port: 5506,
            host: "localhost"
          },
          logging: {
            level: "info"
          },
          providers: {
            lmstudio: {
              type: "lmstudio",
              baseUrl: "http://localhost:1234",
              apiKey: "${LM_STUDIO_API_KEY:-}",
              models: {
                "gpt-oss-20b-mlx": {
                  maxTokens: 8192,
                  temperature: 0.7,
                  supportsStreaming: true,
                  supportsTools: true
                },
                "qwen2.5-7b-instruct": {
                  maxTokens: 32768,
                  temperature: 0.7,
                  supportsStreaming: true,
                  supportsTools: true
                }
              },
              timeout: 60000,
              retryAttempts: 3
            }
          },
          routing: {
            default: "lmstudio",
            models: {
              "gpt-4": "gpt-oss-20b-mlx",
              "gpt-4-turbo": "gpt-oss-20b-mlx",
              "gpt-3.5-turbo": "gpt-oss-20b-mlx",
              "claude-3-haiku": "qwen2.5-7b-instruct",
              "claude-3-sonnet": "gpt-oss-20b-mlx"
            }
          },
          features: {
            tools: {
              enabled: true,
              maxTools: 10
            },
            streaming: {
              enabled: true,
              chunkSize: 1024
            },
            oauth: {
              enabled: true,
              providers: ["qwen", "iflow"]
            }
          }
        };
        break;

      case 'oauth':
        templateConfig = {
          server: {
            port: 5506,
            host: "localhost"
          },
          logging: {
            level: "info"
          },
          providers: {
            qwen: {
              type: "qwen-provider",
              baseUrl: "https://chat.qwen.ai",
              oauth: {
                clientId: "f0304373b74a44d2b584a3fb70ca9e56",
                deviceCodeUrl: "https://chat.qwen.ai/api/v1/oauth2/device/code",
                tokenUrl: "https://chat.qwen.ai/api/v1/oauth2/token",
                scopes: ["openid", "profile", "email", "model.completion"]
              },
              models: {
                "qwen3-coder-plus": {
                  maxTokens: 32768,
                  temperature: 0.7,
                  supportsStreaming: true,
                  supportsTools: true
                }
              }
            },
            iflow: {
              type: "iflow-http",
              baseUrl: "https://api.iflow.cn/v1",
              oauth: {
                clientId: "10009311001",
                clientSecret: "4Z3YjXycVsQvyGF1etiNlIBB4RsqSDtW",
                authUrl: "https://iflow.cn/oauth",
                tokenUrl: "https://iflow.cn/oauth/token",
                deviceCodeUrl: "https://iflow.cn/oauth/device/code",
                scopes: ["openid", "profile", "api"]
              },
              models: {
                "iflow-pro": {
                  maxTokens: 32768,
                  temperature: 0.7,
                  supportsStreaming: true,
                  supportsTools: true
                }
              }
            }
          },
          routing: {
            default: "qwen",
            models: {
              "gpt-4": "qwen3-coder-plus",
              "gpt-3.5-turbo": "qwen3-coder-plus",
              "claude-3-haiku": "qwen3-coder-plus",
              "claude-3-sonnet": "iflow-pro"
            }
          },
          features: {
            tools: {
              enabled: true,
              maxTools: 10
            },
            streaming: {
              enabled: true,
              chunkSize: 1024
            },
            oauth: {
              enabled: true,
              autoRefresh: true,
              sharedCredentials: true
            }
          }
        };
        break;

      default:
        templateConfig = {
          server: {
            port: 5506,
            host: "localhost"
          },
          logging: {
            level: "info"
          },
          providers: {
            openai: {
              type: "openai",
              apiKey: "${OPENAI_API_KEY}",
              baseUrl: "https://api.openai.com/v1",
              models: {
                "gpt-4": {
                  maxTokens: 8192,
                  temperature: 0.7
                },
                "gpt-3.5-turbo": {
                  maxTokens: 4096,
                  temperature: 0.7
                }
              }
            }
          },
          routing: {
            default: "openai"
          },
          features: {
            tools: {
              enabled: true,
              maxTools: 10
            },
            streaming: {
              enabled: true,
              chunkSize: 1024
            }
          }
        };
    }

    // Write configuration file
    fs.writeFileSync(configPath, JSON.stringify(templateConfig, null, 2));

    spinner.succeed(`Configuration initialized: ${configPath}`);
    logger.info(`Template used: ${template || 'default'}`);
    logger.info('You can now start the server with: routecodex start');

  } catch (error) {
    spinner.fail('Failed to initialize configuration');
    logger.error(`Initialization failed: ${  error instanceof Error ? error.message : String(error)}`);
  }
}

// Stop command
program
  .command('stop')
  .description('Stop the RouteCodex server')
  .option('-p, --port <port>', 'Server port')
  .action(async (options) => {
    const spinner = ora('Stopping RouteCodex server...').start();
    try {
      // Resolve config path and port
      const configPath = path.join(homedir(), '.routecodex', 'config.json');
      const resolvedPort = determinePort(configPath, options.port ? parseInt(options.port, 10) : 5520);

      const pids = findListeningPids(resolvedPort);
      if (!pids.length) {
        spinner.succeed(`No server listening on ${resolvedPort}.`);
        return;
      }
      for (const pid of pids) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
      }
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

// Restart command (stop + start with same environment)
program
  .command('restart')
  .description('Restart the RouteCodex server')
  .option('-p, --port <port>', 'Server port (fallback if config missing)')
  .option('-h, --host <host>', 'Server host', 'localhost')
  .option('-c, --config <config>', 'Configuration file path')
  .option('--log-level <level>', 'Log level (debug, info, warn, error)', 'info')
  .option('--codex', 'Use Codex system prompt (tools unchanged)')
  .option('--claude', 'Use Claude system prompt (tools unchanged)')
  .action(async (options) => {
    const spinner = ora('Restarting RouteCodex server...').start();
    try {
      // Resolve config and port
      const configPath = options.config || path.join(homedir(), '.routecodex', 'config.json');
      const resolvedPort = determinePort(configPath, options.port ? parseInt(options.port, 10) : 5520);

      // Stop current instance (if any)
      const pids = findListeningPids(resolvedPort);
      if (pids.length) {
        for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ } }
        const deadline = Date.now() + 3500;
        while (Date.now() < deadline) {
          if (findListeningPids(resolvedPort).length === 0) break;
          await sleep(120);
        }
        const remain = findListeningPids(resolvedPort);
        for (const pid of remain) { try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ } }
      }

      spinner.text = 'Starting RouteCodex server...';

      // Delegate to start command behavior with --restart semantics
      const nodeBin = process.execPath;
      const serverEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'index.js');
      const { spawn } = await import('child_process');

      // Prompt source flags
      if (options.codex && options.claude) {
        spinner.fail('Flags --codex and --claude are mutually exclusive');
        process.exit(1);
      }
      if (options.codex) { process.env.ROUTECODEX_SYSTEM_PROMPT_SOURCE = 'codex'; }
      else if (options.claude) { process.env.ROUTECODEX_SYSTEM_PROMPT_SOURCE = 'claude'; }
      else if (!process.env.ROUTECODEX_SYSTEM_PROMPT_SOURCE) {
        // Default to Codex system prompt source if not specified
        process.env.ROUTECODEX_SYSTEM_PROMPT_SOURCE = 'codex';
      }

      const modulesConfigPath = getModulesConfigPath();
      const env = { ...process.env } as NodeJS.ProcessEnv;
      const args: string[] = [serverEntry, modulesConfigPath];
      const child = spawn(nodeBin, args, { stdio: 'inherit', env });
      try { fs.writeFileSync(path.join(homedir(), '.routecodex', 'server.cli.pid'), String(child.pid ?? ''), 'utf8'); } catch {}

      spinner.succeed(`RouteCodex server restarting on ${options.host || 'localhost'}:${resolvedPort}`);
      logger.info('Press Ctrl+C to stop the server');

      const shutdown = async (sig: NodeJS.Signals) => {
        try { await fetch(`http://127.0.0.1:${resolvedPort}/shutdown`, { method: 'POST' } as any).catch(() => {}); } catch {}
        try { child.kill(sig); } catch {}
        try { if (child.pid) { process.kill(-child.pid, sig); } } catch {}
        const deadline = Date.now() + 3500;
        while (Date.now() < deadline) {
          if (findListeningPids(resolvedPort).length === 0) break;
          await sleep(120);
        }
        const remain = findListeningPids(resolvedPort);
        for (const pid of remain) { try { process.kill(pid, 'SIGTERM'); } catch {} }
        const killDeadline = Date.now() + 1500;
        while (Date.now() < killDeadline) {
          if (findListeningPids(resolvedPort).length === 0) break;
          await sleep(100);
        }
        const still = findListeningPids(resolvedPort);
        for (const pid of still) { try { process.kill(pid, 'SIGKILL'); } catch {} }
        // Ensure parent exits in any case
        try { process.exit(0); } catch {}
      };
      process.on('SIGINT', () => { void shutdown('SIGINT'); });
      process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

      // Fallback keypress handler for restart mode as well
      const cleanupKeypress2 = setupKeypress(() => { void shutdown('SIGINT'); });

      child.on('exit', (code, signal) => {
        try { cleanupKeypress2(); } catch { /* ignore */ }
        if (signal) process.exit(0);
        else process.exit(code ?? 0);
      });

      await new Promise(() => {});
    } catch (e) {
      spinner.fail(`Failed to restart: ${(e as Error).message}`);
      process.exit(1);
    }
  });

// Status command
program
  .command('status')
  .description('Show server status')
  .option('-j, --json', 'Output in JSON format')
  .action(async (options) => {
    try {
      // Check if server is running by trying to connect (HTTP)
      const { get } = await import('http');

      const checkServer = (port: number, host: string): Promise<HealthCheckResult> => {
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
                // Ensure required fields in case health payload differs
                resolve({
                  status: health?.status || 'unknown',
                  port,
                  host
                });
              } catch {
                resolve({ status: 'unknown', port, host });
              }
            });
          });

          req.on('error', () => {
            resolve({ status: 'stopped', port, host });
          });

          req.on('timeout', () => {
            req.destroy();
            resolve({ status: 'timeout', port, host });
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
      logger.error(`Status check failed: ${  error instanceof Error ? error.message : String(error)}`);
    }
  });

// Clean command: purge local capture and debug data for fresh runs
program
  .command('clean')
  .description('Clean captured data and debug logs')
  .option('-y, --yes', 'Confirm deletion without prompt')
  .option('--what <targets>', 'Targets to clean: captures,logs,all', 'all')
  .action(async (options) => {
    const confirm = Boolean(options.yes);
    const what = String(options.what || 'all');
    if (!confirm) {
      logger.warning("Add --yes to confirm deletion.");
      logger.info("Example: routecodex clean --yes --what all");
      return;
    }
    const home = homedir();
    const targets: Array<{ path: string; label: string }>= [];
    if (what === 'captures' || what === 'all') {
      targets.push({ path: path.join(home, '.routecodex', 'codex-samples'), label: 'captures' });
    }
    if (what === 'logs' || what === 'all') {
      targets.push({ path: path.join(process.cwd(), 'debug-logs'), label: 'debug-logs' });
      targets.push({ path: path.join(home, '.routecodex', 'logs'), label: 'user-logs' });
    }
    let removedAny = false;
    for (const t of targets) {
      try {
        if (fs.existsSync(t.path)) {
          const entries = fs.readdirSync(t.path);
          for (const name of entries) {
            const p = path.join(t.path, name);
            try {
              // Recursively remove files/folders
              fs.rmSync(p, { recursive: true, force: true });
              removedAny = true;
            } catch (e) {
              logger.warning(`Failed to remove ${p}: ${(e as Error).message}`);
            }
          }
          logger.success(`Cleared ${t.label} at ${t.path}`);
        }
      } catch (e) {
        logger.warning(`Unable to access ${t.label} at ${t.path}: ${(e as Error).message}`);
      }
    }
    if (!removedAny) {
      logger.info('Nothing to clean.');
    }
  });

// Import commands at top level
import { createDryRunCommands } from './commands/dry-run.js';
// offline-log CLI temporarily disabled to simplify build

// simple-log config helper removed

// Add commands
program.addCommand(createDryRunCommands());
// offline-log command disabled
// simple-log command removed

// Examples command
program
  .command('examples')
  .description('Show usage examples')
  .action(() => {
    console.log(chalk.cyan('RouteCodex Usage Examples'));
    console.log('='.repeat(40));
    console.log('');

    console.log(chalk.yellow('1. Initialize Configuration:'));
    console.log('  # Create default configuration');
    console.log('  routecodex config init');
    console.log('');
    console.log('  # Create LMStudio configuration');
    console.log('  routecodex config init --template lmstudio');
    console.log('');
    console.log('  # Create OAuth configuration');
    console.log('  routecodex config init --template oauth');
    console.log('');

    console.log(chalk.yellow('2. Start Server:'));
    console.log('  # Start with default config');
    console.log('  routecodex start');
    console.log('');
    console.log('  # Start with custom config');
    console.log('  routecodex start --config ./config/lmstudio-config.json');
    console.log('');
    console.log('  # Start with custom port');
    console.log('  routecodex start --port 8080');
    console.log('');

    console.log(chalk.yellow('3. Configuration Management:'));
    console.log('  # Show current configuration');
    console.log('  routecodex config show');
    console.log('');
    console.log('  # Edit configuration');
    console.log('  routecodex config edit');
    console.log('');
    console.log('  # Validate configuration');
    console.log('  routecodex config validate');
    console.log('');

    console.log(chalk.yellow('4. Dry-Run Testing:'));
    console.log('  # Execute request pipeline dry-run');
    console.log('  routecodex dry-run request ./request.json --pipeline-id test --mode dry-run');
    console.log('');
    console.log('  # Execute response pipeline dry-run');
    console.log('  routecodex dry-run response ./response.json --pipeline-id test');
    console.log('');
    console.log('  # Start response capture session');
    console.log('  routecodex dry-run capture --start');
    console.log('');
    console.log('  # Process multiple files in batch');
    console.log('  routecodex dry-run batch ./test-data --pattern *.json --output ./results');
    console.log('');
    console.log('  # Execute chain of pipelines');
    console.log('  routecodex dry-run chain ./input.json --chain ./chain-config.json');
    console.log('');

    console.log(chalk.yellow('5. Environment Variables:'));
    console.log('  # Set LM Studio API Key');
    console.log('  export LM_STUDIO_API_KEY="your-api-key"');
    console.log('');
    console.log('  # Set OpenAI API Key');
    console.log('  export OPENAI_API_KEY="your-api-key"');
    console.log('');

    console.log(chalk.yellow('6. Testing:'));
    console.log('  # Test with curl');
    console.log('  curl -X POST http://localhost:5506/v1/chat/completions \\');
    console.log('    -H "Content-Type: application/json" \\');
    console.log('    -H "Authorization: Bearer test-key" \\');
    console.log('    -d \'{"model": "gpt-4", "messages": [{"role": "user", "content": "Hello!"}]}\'');
    console.log('');
  });

function determinePort(configPath: string, fallback: number): number {
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(content);
    const candidate = config?.server?.port ?? config?.httpserver?.port ?? config?.port;
    const parsed = parseInt(candidate, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  } catch {
    // ignore parsing errors and fall back
  }
  return fallback;
}

async function ensurePortAvailable(port: number, parentSpinner: Ora, opts: { restart?: boolean } = {}): Promise<void> {
  if (!port || Number.isNaN(port)) { return; }

  const initialPids = findListeningPids(port);
  if (initialPids.length === 0) { return; }

  // If a healthy server is already running and no restart requested, report and exit gracefully
  const healthy = await isServerHealthyQuick(port);
  if (healthy && !opts.restart) {
    parentSpinner.stop();
    logger.success(`RouteCodex is already running on port ${port}.`);
    logger.info(`Use 'routecodex stop' or 'routecodex start --restart' to restart.`);
    process.exit(0);
  }

  parentSpinner.stop();
  logger.warning(`Port ${port} is in use by PID(s): ${initialPids.join(', ')}`);
  const stopSpinner = ora(`Port ${port} is in use on 0.0.0.0. Attempting graceful stop...`).start();
  const gracefulTimeout = Number(process.env.ROUTECODEX_STOP_TIMEOUT_MS ?? 5000);
  const killTimeout = Number(process.env.ROUTECODEX_KILL_TIMEOUT_MS ?? 3000);
  const pollInterval = 150;

  for (const pid of initialPids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      stopSpinner.warn(`Failed to send SIGTERM to PID ${pid}: ${(error as Error).message}`);
    }
  }

  const gracefulDeadline = Date.now() + gracefulTimeout;
  while (Date.now() < gracefulDeadline) {
    if (findListeningPids(port).length === 0) {
      stopSpinner.succeed(`Port ${port} freed after graceful stop.`);
      logger.success(`Port ${port} freed after graceful stop.`);
      parentSpinner.start('Starting RouteCodex server...');
      return;
    }
    await sleep(pollInterval);
  }

  let remaining = findListeningPids(port);
  if (remaining.length) {
    stopSpinner.warn(`Graceful stop timed out, sending SIGKILL to PID(s): ${remaining.join(', ')}`);
    logger.warning(`Graceful stop timed out. Forcing SIGKILL to PID(s): ${remaining.join(', ')}`);
    for (const pid of remaining) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        const message = (error as Error).message;
        stopSpinner.warn(`Failed to send SIGKILL to PID ${pid}: ${message}`);
        logger.error(`Failed to SIGKILL PID ${pid}: ${message}`);
      }
    }

    const killDeadline = Date.now() + killTimeout;
    while (Date.now() < killDeadline) {
      if (findListeningPids(port).length === 0) {
        stopSpinner.succeed(`Port ${port} freed after SIGKILL.`);
        logger.success(`Port ${port} freed after SIGKILL.`);
        parentSpinner.start('Starting RouteCodex server...');
        return;
      }
      await sleep(pollInterval);
    }
  }

  remaining = findListeningPids(port);
  if (remaining.length) {
    stopSpinner.fail(`Failed to free port ${port}. Still held by PID(s): ${remaining.join(', ')}`);
    logger.error(`Failed to free port ${port}. Still held by PID(s): ${remaining.join(', ')}`);
    throw new Error(`Failed to free port ${port}`);
  }

  stopSpinner.succeed(`Port ${port} freed.`);
  logger.success(`Port ${port} freed.`);
  parentSpinner.start('Starting RouteCodex server...');
}

function findListeningPids(port: number): number[] {
  try {
    const result = spawnSync('lsof', ['-tiTCP', `:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    if (result.error) {
      logger.warning(`lsof not available to inspect port usage: ${result.error.message}`);
      return [];
    }
    const stdout = (result.stdout || '').trim();
    if (!stdout) {
      return [];
    }
    return stdout
      .split(/\s+/)
      .map((value) => parseInt(value, 10))
      .filter((pid) => !Number.isNaN(pid));
  } catch (error) {
    logger.warning(`Failed to inspect port ${port}: ${(error as Error).message}`);
    return [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fallback keypress setup: capture Ctrl+C and 'q' to trigger shutdown when SIGINT is not delivered
function setupKeypress(onInterrupt: () => void): () => void {
  try {
    const stdin = process.stdin as unknown as {
      isTTY?: boolean;
      setRawMode?: (v: boolean) => void;
      resume?: () => void;
      pause?: () => void;
      on?: (ev: string, cb: (data: Buffer) => void) => void;
      off?: (ev: string, cb: (data: Buffer) => void) => void;
    };
    if (stdin && stdin.isTTY) {
      const onData = (data: Buffer) => {
        const s = data.toString('utf8');
        // Ctrl+C
        if (s === '\u0003') { try { onInterrupt(); } catch { /* ignore */ } return; }
        // 'q' or 'Q' quick quit
        if (s === 'q' || s === 'Q') { try { onInterrupt(); } catch { /* ignore */ } return; }
      };
      stdin.setRawMode?.(true);
      stdin.resume?.();
      stdin.on?.('data', onData);
      return () => {
        try { stdin.off?.('data', onData); } catch { /* ignore */ }
        try { stdin.setRawMode?.(false); } catch { /* ignore */ }
        try { stdin.pause?.(); } catch { /* ignore */ }
      };
    }
  } catch { /* ignore */ }
  return () => {};
}

async function isServerHealthyQuick(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => { try { controller.abort(); } catch { /* ignore */ } }, 800);
    const res = await fetch(`http://127.0.0.1:${port}/health`, { method: 'GET', signal: (controller as any).signal } as any);
    clearTimeout(t);
    if (!res.ok) { return false; }
    const data = await res.json().catch(() => null);
    return !!data && (data.status === 'healthy' || data.status === 'ready');
  } catch {
    return false;
  }
}

function getModulesConfigPath(): string {
  return path.resolve(__dirname, '../config/modules.json');
}

// Parse command line arguments
program.parse();
