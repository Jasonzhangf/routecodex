import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import type { Command } from 'commander';

import { LOCAL_HOSTS } from '../../constants/index.js';
import { normalizeConnectHost, normalizePort } from '../utils/normalize.js';
import { safeReadJson } from '../utils/safe-read-json.js';

export type EnvCommandOptions = {
  port?: string;
  host?: string;
  config?: string;
  json?: boolean;
};

export type EnvCommandContext = {
  isDevPackage: boolean;
  defaultDevPort: number;
  log: (line: string) => void;
  error: (line: string) => void;
  exit: (code: number) => never;
};

type EnvCommandConfig = {
  httpserver?: { port?: number; host?: string };
  server?: { port?: number; host?: string };
  port?: number;
  host?: string;
};

export function computeEnvOutput(args: { host: string; port: number; json: boolean }): string[] {
  const base = `http://${args.host}:${args.port}`;
  if (args.json) {
    return [
      JSON.stringify(
        {
          ANTHROPIC_BASE_URL: base,
          ANTHROPIC_API_URL: base,
          ANTHROPIC_API_KEY: 'rcc-proxy-key',
          UNSET: ['ANTHROPIC_TOKEN', 'ANTHROPIC_AUTH_TOKEN']
        },
        null,
        2
      )
    ];
  }
  return [
    `export ANTHROPIC_BASE_URL=${base}`,
    `export ANTHROPIC_API_URL=${base}`,
    'export ANTHROPIC_API_KEY=rcc-proxy-key',
    'unset ANTHROPIC_TOKEN',
    'unset ANTHROPIC_AUTH_TOKEN'
  ];
}

export function createEnvCommand(program: Command, ctx: EnvCommandContext): void {
  program
    .command('env')
    .description('Print environment exports for Anthropic tools to use RouteCodex proxy')
    .option('-p, --port <port>', 'RouteCodex server port (overrides config file)')
    .option('-h, --host <host>', 'RouteCodex server host')
    .option('-c, --config <config>', 'RouteCodex configuration file path')
    .option('--json', 'Output JSON instead of shell exports')
    .action(async (options: EnvCommandOptions) => {
      try {
        const configPath = options.config ? options.config : path.join(homedir(), '.routecodex', 'config.json');

        let host = options.host;
        let port = normalizePort(options.port);

        if (ctx.isDevPackage) {
          if (!Number.isFinite(port)) {
            const envPort = Number(process.env.ROUTECODEX_PORT || process.env.RCC_PORT || NaN);
            port = Number.isFinite(envPort) && envPort > 0 ? envPort : ctx.defaultDevPort;
          }
        } else {
          if (!Number.isFinite(port) && fs.existsSync(configPath)) {
            const cfg = safeReadJson<EnvCommandConfig>(configPath);
            port = normalizePort(cfg?.httpserver?.port ?? cfg?.server?.port ?? cfg?.port);
            host =
              typeof cfg?.httpserver?.host === 'string'
                ? cfg.httpserver.host
                : typeof cfg?.server?.host === 'string'
                  ? cfg.server.host
                  : (cfg?.host ?? host);
          }
        }

        if (!Number.isFinite(port) || !port || port <= 0) {
          throw new Error('Missing port. Set via --port, env or config file');
        }

        const resolvedHost = normalizeConnectHost(host, LOCAL_HOSTS.IPV4);
        const lines = computeEnvOutput({ host: resolvedHost, port, json: Boolean(options.json) });
        for (const line of lines) {
          ctx.log(line);
        }
      } catch (error) {
        ctx.error(error instanceof Error ? error.message : String(error));
        ctx.exit(1);
      }
    });
}

