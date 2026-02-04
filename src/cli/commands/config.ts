import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { Command } from 'commander';

import { initializeConfigV1, parseProvidersArg } from '../config/init-config.js';
import { getInitProviderCatalog } from '../config/init-provider-catalog.js';
import { installBundledDocsBestEffort } from '../config/bundled-docs.js';

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

export type ConfigCommandContext = {
  logger: LoggerLike;
  createSpinner: (text: string) => Promise<Spinner>;
  getHomeDir?: () => string;
  fsImpl?: Pick<typeof fs, 'existsSync' | 'readFileSync' | 'writeFileSync' | 'mkdirSync'>;
  pathImpl?: Pick<typeof path, 'join' | 'dirname' | 'resolve'>;
  spawnImpl?: typeof spawn;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  prompt?: (question: string) => Promise<string>;
};

function buildInteractivePrompt(
  ctx: ConfigCommandContext
): { prompt: (question: string) => Promise<string>; close: () => void } | null {
  if (typeof ctx.prompt === 'function') {
    return { prompt: ctx.prompt, close: () => {} };
  }
  if (!input.isTTY || !output.isTTY) {
    return null;
  }
  const rl = readline.createInterface({ input, output });
  return {
    prompt: async (question: string) => rl.question(question),
    close: () => rl.close()
  };
}

export function createConfigCommand(program: Command, ctx: ConfigCommandContext): void {
  const fsImpl = ctx.fsImpl ?? fs;
  const pathImpl = ctx.pathImpl ?? path;
  const home = ctx.getHomeDir ?? (() => homedir());
  const env = ctx.env ?? process.env;
  const log = ctx.log ?? ((line: string) => console.log(line));
  const spawnImpl = ctx.spawnImpl ?? spawn;
  const bin = typeof (program as unknown as { name?: () => string }).name === 'function' ? program.name() : 'rcc';

  program
    .command('config')
    .description('Configuration management')
    .addHelpText(
      'after',
      `
Tips:
  - Prefer "${bin} init" for guided config generation.

Examples:
  ${bin} init
  ${bin} config show
  ${bin} config validate
  ${bin} config init --providers openai,tab --default-provider tab
`
    )
    .argument('<action>', 'Action to perform (show, edit, validate, init)')
    .option('-c, --config <config>', 'Configuration file path')
    .option('-t, --template <template>', 'Init template provider id (e.g., openai, tab, glm, qwen)')
    .option('--providers <ids>', 'Init providers (comma-separated), e.g. openai,tab,glm')
    .option('--default-provider <id>', 'Init default provider id for routing.default')
    .option('--host <host>', 'Init server host (httpserver.host)')
    .option('--port <port>', 'Init server port (httpserver.port)')
    .option('-f, --force', 'Force overwrite existing configuration')
    .action(async (action: string, options: { config?: string; template?: string; providers?: string; defaultProvider?: string; host?: string; port?: string; force?: boolean }) => {
      try {
        const configPath = options.config || pathImpl.join(home(), '.routecodex', 'config.json');

        switch (action) {
          case 'init':
            {
              const spinner = await ctx.createSpinner('Initializing configuration...');
              const catalog = getInitProviderCatalog();
              const supported = catalog.map((p) => p.id).join(', ');
              const providersFromArg =
                parseProvidersArg(options.providers) ??
                (typeof options.template === 'string' && options.template.trim() ? [options.template.trim()] : undefined);

              // `config init` is intentionally non-interactive (use `${bin} init` for guided generation).
              // This keeps CLI behavior deterministic in CI/tests and avoids hanging on readline prompts.
              if (!providersFromArg || providersFromArg.length === 0) {
                spinner.fail('Failed to initialize configuration');
                ctx.logger.error(`Non-interactive init requires --providers or --template. Supported: ${supported}`);
                return;
              }
              const result = await initializeConfigV1(
                {
                  fsImpl,
                  pathImpl
                },
                {
                  configPath,
                  force: Boolean(options.force),
                  host: options.host,
                  port:
                    typeof options.port === 'string' && Number.isFinite(Number(options.port)) && Number(options.port) > 0
                      ? Math.floor(Number(options.port))
                      : undefined,
                  providers: providersFromArg,
                  defaultProvider: options.defaultProvider
                },
                undefined
              );

              if (!result.ok) {
                spinner.fail('Failed to initialize configuration');
                ctx.logger.error(result.message);
                return;
              }

              spinner.succeed(`Configuration initialized: ${result.configPath}`);
              if (result.backupPath) {
                ctx.logger.info(`Backed up existing config: ${result.backupPath}`);
              }
              ctx.logger.info(`Providers: ${result.selectedProviders.join(', ')}`);
              ctx.logger.info(`Default provider: ${result.defaultProvider}`);
              {
                const installed = installBundledDocsBestEffort({ fsImpl, pathImpl });
                if (installed.ok) {
                  ctx.logger.info(`Docs installed: ${installed.targetDir}`);
                }
              }
              ctx.logger.info('Next: edit apiKey/tokenFile/cookieFile as needed, then run: rcc start');
            }
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
