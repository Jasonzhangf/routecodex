import type { Command } from 'commander';

import { createLauncherCommand, type LauncherCommandContext } from './launcher-kernel.js';

export type ClaudeCommandContext = LauncherCommandContext;

export function createClaudeCommand(program: Command, ctx: ClaudeCommandContext): void {
  createLauncherCommand(program, ctx, {
    commandName: 'claude',
    displayName: 'Claude',
    description: 'Launch Claude with RouteCodex as proxy (args after this command are passed through)',
    allowAutoStartServer: false,
    binaryOptionFlags: '--claude-path <path>',
    binaryOptionName: 'claudePath',
    binaryOptionDescription: 'Path to Claude executable',
    binaryDefault: 'claude',
    binaryEnvKey: 'CLAUDE_PATH',
    extraKnownOptions: ['--claude-path', '--model', '--profile'],
    withModelOption: true,
    withProfileOption: true,
    buildArgs: (options) => {
      const args: string[] = [];
      if (typeof options.model === 'string' && options.model.trim()) {
        args.push('--model', options.model.trim());
      }
      if (typeof options.profile === 'string' && options.profile.trim()) {
        args.push('--profile', options.profile.trim());
      }
      return args;
    },
    buildEnv: ({ env, baseUrl, configuredApiKey, cwd }) => {
      // Always prefer the proxy key injected by launcher-kernel (OPENAI_API_KEY),
      // because it may carry the clock daemon suffix for per-session binding.
      const proxyApiKey = (typeof env.OPENAI_API_KEY === 'string' && env.OPENAI_API_KEY.trim())
        ? env.OPENAI_API_KEY.trim()
        : (configuredApiKey || 'rcc-proxy-key');
      const claudeEnv = {
        ...env,
        PWD: cwd,
        RCC_WORKDIR: cwd,
        ROUTECODEX_WORKDIR: cwd,
        CLAUDE_WORKDIR: cwd,
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_API_URL: baseUrl,
        ANTHROPIC_API_KEY: proxyApiKey
      } as NodeJS.ProcessEnv;

      try {
        delete (claudeEnv as Record<string, unknown>).ANTHROPIC_AUTH_TOKEN;
      } catch {
        // ignore
      }
      try {
        delete (claudeEnv as Record<string, unknown>).ANTHROPIC_TOKEN;
      } catch {
        // ignore
      }

      return claudeEnv;
    }
  });
}
