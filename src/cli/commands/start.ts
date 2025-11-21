import { Command } from 'commander';
import { createSpinner } from '../spinner.js';
import { logger } from '../logger.js';
import { resolveConfigPath, readConfig, resolveEffectivePort } from '../config-resolver.js';
import { ensurePortAvailable, runServerChild } from '../server-runner.js';

export function registerStartCommand(program: Command, isDevPackage: boolean) {
  program
    .command('start')
    .description('Start the RouteCodex server')
    .option('-c, --config <config>', 'Configuration file path')
    .option('--log-level <level>', 'Log level (debug, info, warn, error)', 'info')
    .option('--codex', 'Use Codex system prompt (tools unchanged)')
    .option('--claude', 'Use Claude system prompt (tools unchanged)')
    .option('--restart', 'Restart if an instance is already running')
    .option('--exclusive', 'Always take over the port (kill existing listeners)')
    .action(async (options) => {
      const spinner = await createSpinner('Starting RouteCodex server...');
      try {
        try {
          if (options.codex && options.claude) {
            spinner.fail('Flags --codex and --claude are mutually exclusive');
            process.exit(1);
          }
          if (options.codex) process.env.ROUTECODEX_SYSTEM_PROMPT_SOURCE = 'codex';
          else if (options.claude) process.env.ROUTECODEX_SYSTEM_PROMPT_SOURCE = 'claude';
        } catch {}

        const configPath = resolveConfigPath(options.config);
        const config = readConfig(configPath);
        const resolvedPort = resolveEffectivePort(config, isDevPackage);

        await ensurePortAvailable(resolvedPort, spinner, { restart: true });

        // 交给子进程前停止本地 spinner，避免服务端成功日志时仍显示“Starting ...”悬挂
        try { spinner.stop(); } catch {}
        await runServerChild({ configPath, resolvedPort, config, isDevPackage });
      } catch (error) {
        spinner.fail('Failed to start server');
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });
}
