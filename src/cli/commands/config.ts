import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import { logger } from '../logger.js';
import { createSpinner } from '../spinner.js';
import { LOCAL_HOSTS, HTTP_PROTOCOLS, DEFAULT_CONFIG, API_ENDPOINTS } from '../../constants/index.js';

interface ServerConfig { port: number; host: string; }
interface LoggingConfig { level: string; }
interface TemplateConfig { server?: Partial<ServerConfig>; logging?: Partial<LoggingConfig>; [k: string]: unknown }

export function registerConfigCommand(program: Command) {
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
              try { JSON.parse(fs.readFileSync(configPath, 'utf8')); logger.success('Configuration is valid'); }
              catch (error) { logger.error(`Configuration is invalid: ${error instanceof Error ? error.message : String(error)}`); }
            } else { logger.error('Configuration file not found'); }
            break;
          }
          default:
            logger.error('Unknown action. Use: show, edit, validate, init');
        }
      } catch (error) {
        logger.error(`Config command failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}

async function initializeConfig(configPath: string, template?: string, force: boolean = false) {
  const spinner = await createSpinner('Initializing configuration...');
  try {
    const configDir = path.dirname(configPath);
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    if (fs.existsSync(configPath) && !force) {
      spinner.warn('Configuration file already exists');
      spinner.info('Use --force flag to overwrite or choose a different path');
      return;
    }

    let templateConfig: TemplateConfig | undefined;
    switch (template) {
      case 'lmstudio':
        templateConfig = {
          server: { port: DEFAULT_CONFIG.PORT, host: LOCAL_HOSTS.LOCALHOST },
          logging: { level: 'info' },
          providers: {
            lmstudio: {
              type: 'lmstudio',
              baseUrl: `${HTTP_PROTOCOLS.HTTP}${LOCAL_HOSTS.LOCALHOST}:${DEFAULT_CONFIG.LM_STUDIO_PORT}`,
              apiKey: '${LM_STUDIO_API_KEY:-}',
              models: {
                'gpt-oss-20b-mlx': { maxTokens: 8192, temperature: 0.7, supportsStreaming: true, supportsTools: true },
                'qwen2.5-7b-instruct': { maxTokens: 32768, temperature: 0.7, supportsStreaming: true, supportsTools: true }
              },
              timeout: 60000,
              retryAttempts: 3
            }
          },
          routing: { default: 'lmstudio', models: { 'gpt-4': 'gpt-oss-20b-mlx', 'gpt-4-turbo': 'gpt-oss-20b-mlx', 'gpt-3.5-turbo': 'gpt-oss-20b-mlx', 'claude-3-haiku': 'qwen2.5-7b-instruct', 'claude-3-sonnet': 'gpt-oss-20b-mlx' } },
          features: { tools: { enabled: true, maxTools: 10 }, streaming: { enabled: true, chunkSize: 1024 }, oauth: { enabled: true, providers: ['qwen', 'iflow'] } }
        };
        break;
      case 'oauth':
        templateConfig = {
          server: { port: DEFAULT_CONFIG.PORT, host: LOCAL_HOSTS.LOCALHOST },
          logging: { level: 'info' },
          providers: {
            qwen: {
              type: 'qwen-provider',
              baseUrl: 'https://chat.qwen.ai',
              oauth: {
                clientId: 'f0304373b74a44d2b584a3fb70ca9e56',
                deviceCodeUrl: 'https://chat.qwen.ai/api/v1/oauth2/device/code',
                tokenUrl: 'https://chat.qwen.ai/api/v1/oauth2/token',
                scopes: ['openid', 'profile', 'email', 'model.completion']
              },
              models: { 'qwen3-coder-plus': { maxTokens: 32768, temperature: 0.7, supportsStreaming: true, supportsTools: true } }
            }
          },
          routing: { default: 'qwen', models: { 'gpt-4': 'qwen3-coder-plus', 'gpt-3.5-turbo': 'qwen3-coder-plus' } },
          features: { tools: { enabled: true, maxTools: 10 }, streaming: { enabled: true, chunkSize: 1024 }, oauth: { enabled: true, autoRefresh: true, sharedCredentials: true } }
        };
        break;
      default:
        templateConfig = {
          server: { port: DEFAULT_CONFIG.PORT, host: LOCAL_HOSTS.LOCALHOST },
          logging: { level: 'info' },
          providers: {
            openai: {
              type: 'openai', apiKey: '${OPENAI_API_KEY}', baseUrl: API_ENDPOINTS.OPENAI,
              models: { 'gpt-4': { maxTokens: 8192, temperature: 0.7 }, 'gpt-3.5-turbo': { maxTokens: 4096, temperature: 0.7 } }
            }
          },
          routing: { default: 'openai', models: { 'gpt-4': 'gpt-4', 'gpt-3.5-turbo': 'gpt-3.5-turbo' } },
          features: { tools: { enabled: true, maxTools: 10 }, streaming: { enabled: true, chunkSize: 1024 } }
        };
    }

    fs.writeFileSync(configPath, JSON.stringify(templateConfig, null, 2));
    spinner.succeed(`Configuration initialized: ${configPath}`);
    logger.info(`Template used: ${template || 'default'}`);
    logger.info('You can now start the server with: rcc start');
  } catch (error) {
    spinner.fail('Failed to initialize configuration');
    logger.error(`Initialization failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

