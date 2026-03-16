import type { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';

import { createLauncherCommand, type LauncherCommandContext, normalizeOpenAiBaseUrl } from './launcher-kernel.js';

export type CodexCommandContext = LauncherCommandContext;

function readDefaultRouteCodexCodexProfile(ctx: CodexCommandContext): string | null {
  const explicit =
    (typeof ctx.env.ROUTECODEX_CODEX_PROFILE === 'string' && ctx.env.ROUTECODEX_CODEX_PROFILE.trim())
      ? ctx.env.ROUTECODEX_CODEX_PROFILE.trim()
      : ((typeof ctx.env.RCC_CODEX_PROFILE === 'string' && ctx.env.RCC_CODEX_PROFILE.trim())
        ? ctx.env.RCC_CODEX_PROFILE.trim()
        : '');
  if (explicit) {
    return explicit;
  }

  const fsImpl = ctx.fsImpl ?? fs;
  const pathImpl = ctx.pathImpl ?? path;
  const configPath = pathImpl.join(ctx.homedir(), '.codex', 'config.toml');
  try {
    if (!fsImpl.existsSync(configPath)) {
      return null;
    }
    const content = fsImpl.readFileSync(configPath, 'utf8');
    if (/\[profiles\.rcm\]/m.test(content) && /\[model_providers\.rcm\]/m.test(content)) {
      return 'rcm';
    }
  } catch {
    return null;
  }

  return null;
}

export function createCodexCommand(program: Command, ctx: CodexCommandContext): void {
  const defaultRouteCodexProfile = readDefaultRouteCodexCodexProfile(ctx);
  createLauncherCommand(program, ctx, {
    commandName: 'codex',
    displayName: 'Codex',
    description: 'Launch Codex with RouteCodex as proxy (args after this command are passed through)',
    allowAutoStartServer: false,
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
      const resolvedProfile =
        (typeof options.profile === 'string' && options.profile.trim())
          ? options.profile.trim()
          : defaultRouteCodexProfile;
      if (resolvedProfile) {
        args.push('--profile', resolvedProfile);
      }
      return args;
    },
    buildEnv: ({ env, baseUrl, configuredApiKey, cwd }) => {
      // Prefer launcher-injected proxy key (may carry session daemon/scope suffix for session binding).
      const proxyApiKey = (typeof env.OPENAI_API_KEY === 'string' && env.OPENAI_API_KEY.trim())
        ? env.OPENAI_API_KEY.trim()
        : (configuredApiKey || 'rcc-proxy-key');
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
        OPENAI_API_KEY: proxyApiKey
      } as NodeJS.ProcessEnv;
    }
  });
}
