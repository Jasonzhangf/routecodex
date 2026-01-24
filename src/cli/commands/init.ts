import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { Command } from 'commander';

import { getInitProviderCatalog } from '../config/init-provider-catalog.js';
import { initializeConfigV1, parseProvidersArg } from '../config/init-config.js';
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

export type InitCommandContext = {
  logger: LoggerLike;
  createSpinner: (text: string) => Promise<Spinner>;
  getHomeDir?: () => string;
  fsImpl?: Pick<typeof fs, 'existsSync' | 'readFileSync' | 'writeFileSync' | 'mkdirSync'>;
  pathImpl?: Pick<typeof path, 'join' | 'dirname' | 'resolve'>;
  prompt?: (question: string) => Promise<string>;
};

function buildInteractivePrompt(
  ctx: InitCommandContext
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

export function createInitCommand(program: Command, ctx: InitCommandContext): void {
  const fsImpl = ctx.fsImpl ?? fs;
  const pathImpl = ctx.pathImpl ?? path;
  const home = ctx.getHomeDir ?? (() => homedir());
  const bin = typeof (program as unknown as { name?: () => string }).name === 'function' ? program.name() : 'rcc';

  program
    .command('init')
    .description('Initialize ~/.routecodex/config.json (provider selection guided)')
    .addHelpText(
      'after',
      `
Examples:
  ${bin} init
  ${bin} init --list-providers
  ${bin} init --providers openai,tab --default-provider tab
`
    )
    .option('-c, --config <config>', 'Configuration file path')
    .option('-f, --force', 'Force overwrite existing configuration')
    .option('--providers <ids>', 'Providers (comma-separated), e.g. openai,tab,glm')
    .option('--default-provider <id>', 'Default provider id for routing.default')
    .option('--host <host>', 'Server host (httpserver.host)')
    .option('--port <port>', 'Server port (httpserver.port)')
    .option('--list-providers', 'List built-in provider ids and exit')
    .action(async (options: { config?: string; force?: boolean; providers?: string; defaultProvider?: string; host?: string; port?: string; listProviders?: boolean }) => {
      const spinner = await ctx.createSpinner('Initializing configuration...');

      const configPath = options.config || pathImpl.join(home(), '.routecodex', 'config.json');

      const catalog = getInitProviderCatalog();
      const supported = catalog.map((p) => p.id).join(', ');

      if (options.listProviders) {
        spinner.stop();
        for (const entry of catalog) {
          ctx.logger.info(`${entry.id} - ${entry.label}: ${entry.description}`);
        }
        return;
      }

      const providersFromArg = parseProvidersArg(options.providers);
      const promptBundle = providersFromArg ? null : buildInteractivePrompt(ctx);

      const result = await initializeConfigV1(
        { fsImpl, pathImpl },
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
        promptBundle ? { prompt: promptBundle.prompt } : undefined
      );
      try { promptBundle?.close(); } catch { /* ignore */ }

      if (!result.ok) {
        spinner.fail('Failed to initialize configuration');
        ctx.logger.error(result.message);
        if (!providersFromArg && !promptBundle) {
          ctx.logger.error(`Non-interactive init requires --providers. Supported: ${supported}`);
        }
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
    });
}
