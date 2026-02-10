import type { Command } from 'commander';

import { createLauncherCommand, type LauncherCommandContext, normalizeOpenAiBaseUrl } from './launcher-kernel.js';

export type CodexCommandContext = LauncherCommandContext;

export function createCodexCommand(program: Command, ctx: CodexCommandContext): void {
  createLauncherCommand(program, ctx, {
    commandName: 'codex',
    displayName: 'Codex',
    description: 'Launch Codex with RouteCodex as proxy (args after this command are passed through)',
    binaryOptionFlags: '--codex-path <path>',
    binaryOptionName: 'codexPath',
    binaryOptionDescription: 'Path to Codex executable',
    binaryDefault: 'codex',
    binaryEnvKey: 'CODEX_PATH',
    extraKnownOptions: ['--codex-path', '--model', '--profile'],
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
      const openAiBase = normalizeOpenAiBaseUrl(baseUrl);
      return {
        ...env,
        PWD: cwd,
        RCC_WORKDIR: cwd,
        ROUTECODEX_WORKDIR: cwd,
        CODEX_WORKDIR: cwd,
        OPENAI_BASE_URL: openAiBase,
        OPENAI_API_BASE: openAiBase,
        OPENAI_API_BASE_URL: openAiBase,
        OPENAI_API_KEY: configuredApiKey || 'rcc-proxy-key'
      } as NodeJS.ProcessEnv;
    }
  });
}
