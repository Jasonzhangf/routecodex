import type { Command } from 'commander';

import { createLauncherCommand, type LauncherCommandContext } from './launcher-kernel.js';

export type ClaudeCommandContext = LauncherCommandContext;

export function createClaudeCommand(program: Command, ctx: ClaudeCommandContext): void {
  createLauncherCommand(program, ctx, {
    commandName: 'claude',
    displayName: 'Claude',
    description: 'Launch Claude with RouteCodex as proxy (args after this command are passed through)',
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
      const claudeEnv = {
        ...env,
        PWD: cwd,
        RCC_WORKDIR: cwd,
        ROUTECODEX_WORKDIR: cwd,
        CLAUDE_WORKDIR: cwd,
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_API_URL: baseUrl,
        ANTHROPIC_API_KEY: (typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY.trim())
          ? env.ANTHROPIC_API_KEY.trim()
          : ((typeof env.OPENAI_API_KEY === 'string' && env.OPENAI_API_KEY.trim())
            ? env.OPENAI_API_KEY.trim()
            : (configuredApiKey || 'rcc-proxy-key'))
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
