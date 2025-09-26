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
  info: (msg: string) => console.log(`${chalk.blue('ℹ')  } ${  msg}`),
  success: (msg: string) => console.log(`${chalk.green('✓')  } ${  msg}`),
  warning: (msg: string) => console.log(`${chalk.yellow('⚠')  } ${  msg}`),
  error: (msg: string) => console.log(`${chalk.red('✗')  } ${  msg}`),
  debug: (msg: string) => console.log(`${chalk.gray('◉')  } ${  msg}`)
};

// CLI program setup
const program = new Command();

program
  .name('routecodex')
  .description('Multi-provider OpenAI proxy server')
  .version('0.2.7');

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
      // Import main application
      const { main } = await import('./index.js');

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

      // 检查并应用简单日志配置
      const simpleLogConfig = loadSimpleLogConfig();
      if (simpleLogConfig && simpleLogConfig.enabled) {
        logger.info('检测到简单日志配置，正在应用...');
        logger.info(`简单日志级别: ${simpleLogConfig.logLevel}`);
        logger.info(`简单日志输出: ${simpleLogConfig.output}`);
        
        // 将简单日志配置应用到环境变量或全局配置中
        process.env.SIMPLE_LOG_ENABLED = 'true';
        process.env.SIMPLE_LOG_LEVEL = simpleLogConfig.logLevel;
        process.env.SIMPLE_LOG_OUTPUT = simpleLogConfig.output;
        
        if (simpleLogConfig.output === 'file' || simpleLogConfig.output === 'both') {
          process.env.SIMPLE_LOG_DIRECTORY = simpleLogConfig.logDirectory;
          logger.info(`简单日志目录: ${simpleLogConfig.logDirectory}`);
        }
        
        logger.success('✨ 简单日志配置已应用！');
        logger.info('💡 提示: 使用 "routecodex simple-log off" 可以随时关闭简单日志');
      }

      // Set modules config path in process.argv and start the main application
      process.argv[2] = './config/modules.json';
      await main();

      spinner.succeed(`RouteCodex server started on ${options.host}:${options.port}`);
      logger.info(`Configuration loaded from: ${configPath}`);
      logger.info('Press Ctrl+C to stop the server');

      // Note: Graceful shutdown is handled by the main application

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
              logger.error(`Configuration is invalid: ${  error instanceof Error ? error.message : String(error)}`);
            }
          } else {
            logger.error('Configuration file not found');
          }
          break;

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
    let templateConfig: any;

    switch (template) {
      case 'lmstudio':
        templateConfig = {
          server: {
            port: 5506,
            host: "localhost"
          },
          logging: {
            level: "info",
            format: "json"
          },
          providers: {
            lmstudio: {
              type: "lmstudio",
              baseUrl: "http://localhost:1234",
              apiKey: "${LM_STUDIO_API_KEY:-}",
              models: {
                "llama3-8b-instruct": {
                  maxTokens: 8192,
                  temperature: 0.7,
                  supportsStreaming: true,
                  supportsTools: true
                },
                "llama3-70b-instruct": {
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
              "gpt-4": "llama3-70b-instruct",
              "gpt-4-turbo": "llama3-70b-instruct",
              "gpt-3.5-turbo": "llama3-8b-instruct",
              "claude-3-haiku": "qwen2.5-7b-instruct",
              "claude-3-sonnet": "llama3-70b-instruct"
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
            level: "info",
            format: "json"
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
            level: "info",
            format: "json"
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
      logger.error(`Status check failed: ${  error instanceof Error ? error.message : String(error)}`);
    }
  });

// Import commands at top level
import { createDryRunCommands } from './commands/dry-run.js';
import { createOfflineLogCommand } from './commands/offline-log.js';
import { createSimpleLogCommand } from './commands/simple-log.js';

// 简单日志配置工具函数
function loadSimpleLogConfig(): any {
  const configPath = path.join(homedir(), '.routecodex', 'simple-log-config.json');
  
  if (!fs.existsSync(configPath)) {
    return null;
  }
  
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (error) {
    console.warn('无法读取简单日志配置，使用默认设置');
    return null;
  }
}

// Add commands
program.addCommand(createDryRunCommands());
program.addCommand(createOfflineLogCommand());
program.addCommand(createSimpleLogCommand());

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

// Parse command line arguments
program.parse();
