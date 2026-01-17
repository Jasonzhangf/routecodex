import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import type { Command } from 'commander';

import { API_ENDPOINTS, DEFAULT_CONFIG, HTTP_PROTOCOLS, LOCAL_HOSTS } from '../../constants/index.js';

type Spinner = {
  start(text?: string): Spinner;
  succeed(text?: string): void;
  fail(text?: string): void;
  warn(text?: string): void;
  info(text?: string): void;
  stop(): void;
  text: string;
};

type LoggerLike = {
  info: (msg: string) => void;
  warning: (msg: string) => void;
  success: (msg: string) => void;
  error: (msg: string) => void;
};

type TemplateConfig = {
  server?: { port?: number; host?: string };
  logging?: { level?: string };
  [key: string]: unknown;
};

export type ConfigCommandContext = {
  logger: LoggerLike;
  createSpinner: (text: string) => Promise<Spinner>;
  getHomeDir?: () => string;
  fsImpl?: Pick<typeof fs, 'existsSync' | 'readFileSync' | 'writeFileSync' | 'mkdirSync'>;
  pathImpl?: Pick<typeof path, 'join' | 'dirname'>;
  spawnImpl?: typeof spawn;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
};

function buildTemplate(template: string | undefined): TemplateConfig {
  switch (template) {
    case 'lmstudio':
      return {
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
        routing: {
          default: 'lmstudio',
          models: {
            'gpt-4': 'gpt-oss-20b-mlx',
            'gpt-4-turbo': 'gpt-oss-20b-mlx',
            'gpt-3.5-turbo': 'gpt-oss-20b-mlx',
            'claude-3-haiku': 'qwen2.5-7b-instruct',
            'claude-3-sonnet': 'gpt-oss-20b-mlx'
          }
        },
        features: {
          tools: { enabled: true, maxTools: 10 },
          streaming: { enabled: true, chunkSize: 1024 },
          oauth: { enabled: true, providers: ['qwen', 'iflow'] }
        }
      };
    case 'oauth':
      return {
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
            models: {
              'qwen3-coder-plus': { maxTokens: 32768, temperature: 0.7, supportsStreaming: true, supportsTools: true }
            }
          }
        },
        routing: { default: 'qwen', models: { 'gpt-4': 'qwen3-coder-plus', 'gpt-3.5-turbo': 'qwen3-coder-plus' } },
        features: {
          tools: { enabled: true, maxTools: 10 },
          streaming: { enabled: true, chunkSize: 1024 },
          oauth: { enabled: true, autoRefresh: true, sharedCredentials: true }
        }
      };
    default:
      return {
        server: { port: DEFAULT_CONFIG.PORT, host: LOCAL_HOSTS.LOCALHOST },
        logging: { level: 'info' },
        providers: {
          openai: {
            type: 'openai',
            apiKey: '${OPENAI_API_KEY}',
            baseUrl: API_ENDPOINTS.OPENAI,
            models: { 'gpt-4': { maxTokens: 8192, temperature: 0.7 }, 'gpt-3.5-turbo': { maxTokens: 4096, temperature: 0.7 } }
          }
        },
        routing: { default: 'openai' },
        features: { tools: { enabled: true, maxTools: 10 }, streaming: { enabled: true, chunkSize: 1024 } }
      };
  }
}

async function initializeConfig(ctx: ConfigCommandContext, configPath: string, template?: string, force: boolean = false) {
  const spinner = await ctx.createSpinner('Initializing configuration...');

  const fsImpl = ctx.fsImpl ?? fs;
  const pathImpl = ctx.pathImpl ?? path;

  try {
    const configDir = pathImpl.dirname(configPath);
    if (!fsImpl.existsSync(configDir)) {
      fsImpl.mkdirSync(configDir, { recursive: true });
    }

    if (fsImpl.existsSync(configPath) && !force) {
      spinner.warn('Configuration file already exists');
      spinner.info('Use --force flag to overwrite or choose a different path');
      return;
    }

    const templateConfig = buildTemplate(template);
    fsImpl.writeFileSync(configPath, JSON.stringify(templateConfig, null, 2));

    spinner.succeed(`Configuration initialized: ${configPath}`);
    ctx.logger.info(`Template used: ${template || 'default'}`);
    ctx.logger.info('You can now start the server with: rcc start');
  } catch (error) {
    spinner.fail('Failed to initialize configuration');
    ctx.logger.error(`Initialization failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function createConfigCommand(program: Command, ctx: ConfigCommandContext): void {
  const fsImpl = ctx.fsImpl ?? fs;
  const pathImpl = ctx.pathImpl ?? path;
  const home = ctx.getHomeDir ?? (() => homedir());
  const env = ctx.env ?? process.env;
  const log = ctx.log ?? ((line: string) => console.log(line));
  const spawnImpl = ctx.spawnImpl ?? spawn;

  program
    .command('config')
    .description('Configuration management')
    .argument('<action>', 'Action to perform (show, edit, validate, init)')
    .option('-c, --config <config>', 'Configuration file path')
    .option('-t, --template <template>', 'Configuration template (default, lmstudio, oauth)')
    .option('-f, --force', 'Force overwrite existing configuration')
    .action(async (action: string, options: { config?: string; template?: string; force?: boolean }) => {
      try {
        const configPath = options.config || pathImpl.join(home(), '.routecodex', 'config.json');

        switch (action) {
          case 'init':
            await initializeConfig(ctx, configPath, options.template, Boolean(options.force));
            break;
          case 'show':
            if (fsImpl.existsSync(configPath)) {
              const config = JSON.parse(fsImpl.readFileSync(configPath, 'utf8'));
              log(JSON.stringify(config, null, 2));
            } else {
              ctx.logger.error('Configuration file not found');
            }
            break;
          case 'edit': {
            const editor = env.EDITOR || 'nano';
            spawnImpl(editor, [configPath], { stdio: 'inherit' });
            break;
          }
          case 'validate': {
            if (fsImpl.existsSync(configPath)) {
              try {
                JSON.parse(fsImpl.readFileSync(configPath, 'utf8'));
                ctx.logger.success('Configuration is valid');
              } catch (error) {
                ctx.logger.error(`Configuration is invalid: ${error instanceof Error ? error.message : String(error)}`);
              }
            } else {
              ctx.logger.error('Configuration file not found');
            }
            break;
          }
          default:
            ctx.logger.error('Unknown action. Use: show, edit, validate, init');
        }
      } catch (error) {
        ctx.logger.error(`Config command failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}

