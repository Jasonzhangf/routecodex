import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import { createSpinner } from '../spinner.js';
import { logger } from '../logger.js';
import { LOCAL_HOSTS } from '../../constants/index.js';

export function registerCodeCommand(program: Command, isDevPackage: boolean, DEFAULT_DEV_PORT: number) {
  program
    .command('code')
    .description('Launch Claude Code interface with RouteCodex as proxy (args after this command are passed to Claude by default)')
    .option('-p, --port <port>', 'RouteCodex server port (overrides config file)')
    .option('-h, --host <host>', 'RouteCodex server host', LOCAL_HOSTS.IPV4)
    .option('-c, --config <config>', 'RouteCodex configuration file path')
    .option('--claude-path <path>', 'Path to Claude Code executable', 'claude')
    .option('--cwd <dir>', 'Working directory for Claude Code (defaults to current shell cwd)')
    .option('--model <model>', 'Model to use with Claude Code')
    .option('--profile <profile>', 'Claude Code profile to use')
    .option('--ensure-server', 'Ensure RouteCodex server is running before launching Claude')
    .argument('[extraArgs...]', 'Additional args to pass through to Claude')
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(async (...cmdArgs) => {
      const options = cmdArgs.pop() as any;
      const spinner = await createSpinner('Preparing Claude Code with RouteCodex...');
      try {
        let configPath = options.config || path.join(homedir(), '.routecodex', 'config.json');
        let actualPort = options.port ? parseInt(options.port, 10) : null;
        let actualHost = options.host;

        if (isDevPackage) {
          if (!actualPort) {
            const envPort = Number(process.env.ROUTECODEX_PORT || process.env.RCC_PORT || NaN);
            actualPort = Number.isFinite(envPort) && envPort > 0 ? envPort : DEFAULT_DEV_PORT;
            logger.info(`Using dev default port ${actualPort} for routecodex code (config ports ignored)`);
          }
        } else {
          if (!actualPort && fs.existsSync(configPath)) {
            try {
              const configContent = fs.readFileSync(configPath, 'utf8');
              const config = JSON.parse(configContent);
              actualPort = (config?.httpserver?.port ?? config?.server?.port ?? config?.port) || null;
              actualHost = (config?.httpserver?.host || config?.server?.host || config?.host || actualHost);
            } catch { spinner.warn('Failed to read configuration file, using defaults'); }
          }
        }

        if (!actualPort) {
          spinner.fail('Invalid or missing port configuration for RouteCodex server');
          logger.error('Please set httpserver.port in your configuration (e.g., ~/.routecodex/config.json) or use --port');
          process.exit(1);
        }

        if (options.ensureServer) {
          spinner.text = 'Checking RouteCodex server status...';
          const normalizeConnectHost = (h: string): string => {
            const v = String(h || '').toLowerCase();
            if (v === '0.0.0.0' || v === '::' || v === '::1' || v === 'localhost') {return LOCAL_HOSTS.IPV4;}
            return h || LOCAL_HOSTS.IPV4;
          };
          const connectHost = normalizeConnectHost(actualHost);
          const serverUrl = `http://${connectHost}:${actualPort}`;
          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3000);
            const response = await fetch(`${serverUrl}/ready`, { signal: controller.signal, method: 'GET' } as any);
            clearTimeout(timeoutId);
            if (!response.ok) throw new Error('Server not ready');
            const j = await response.json().catch(() => ({}));
            if (j?.status !== 'ready') throw new Error('Server reported not_ready');
            spinner.succeed('RouteCodex server is ready');
          } catch {
            spinner.info('RouteCodex server is not running, starting it...');
            const { spawn } = await import('child_process');
            const serverEntry = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../index.js');
            const env = { ...process.env } as NodeJS.ProcessEnv;
            // 优先让服务端按工作目录解析 modules.json；无需传参
            const serverProcess = spawn(process.execPath, [serverEntry], { stdio: 'pipe', env, detached: true });
            serverProcess.unref();
            spinner.text = 'Waiting for RouteCodex server to become ready...';
            let ready = false;
            // simple wait loop
            for (let i = 0; i < 30; i++) {
              await new Promise(r => setTimeout(r, 1000));
              try {
                const res = await fetch(`${serverUrl}/ready`, { method: 'GET' } as any);
                if (res.ok) { const jr = await res.json().catch(() => ({})); if (jr?.status === 'ready') { ready = true; break; } }
              } catch {}
            }
            if (ready) spinner.succeed('RouteCodex server is ready'); else spinner.warn('RouteCodex server may not be fully ready, continuing...');
          }
        }

        spinner.text = 'Launching Claude Code...';
        const resolvedBaseHost = (() => {
          const v = String(actualHost || '').toLowerCase();
          if (v === '0.0.0.0' || v === '::' || v === '::1' || v === 'localhost') return LOCAL_HOSTS.IPV4;
          return actualHost || LOCAL_HOSTS.IPV4;
        })();
        const anthropicBase = `http://${resolvedBaseHost}:${actualPort}`;
        const currentCwd = (() => {
          try { const d = options.cwd ? String(options.cwd) : process.cwd(); const resolved = path.resolve(d); if (fs.existsSync(resolved)) return resolved; } catch {}
          return process.cwd();
        })();

        const claudeEnv = {
          ...process.env,
          PWD: currentCwd,
          RCC_WORKDIR: currentCwd,
          ROUTECODEX_WORKDIR: currentCwd,
          CLAUDE_WORKDIR: currentCwd,
          ANTHROPIC_BASE_URL: anthropicBase,
          ANTHROPIC_API_URL: anthropicBase,
          ANTHROPIC_API_KEY: 'rcc-proxy-key'
        } as NodeJS.ProcessEnv;
        try { delete (claudeEnv as any)['ANTHROPIC_AUTH_TOKEN']; } catch {}
        try { delete (claudeEnv as any)['ANTHROPIC_TOKEN']; } catch {}
        logger.info('Unset ANTHROPIC_AUTH_TOKEN/ANTHROPIC_TOKEN for Claude process to avoid conflicts');
        logger.info(`Setting Anthropic base URL to: ${anthropicBase}`);

        const claudeArgs: string[] = [];
        if (options.model) claudeArgs.push('--model', options.model);
        if (options.profile) claudeArgs.push('--profile', options.profile);

        // Transparent passthrough of unknown args after `rcc code`
        try {
          const rawArgv = process.argv.slice(2);
          const idxCode = rawArgv.findIndex(a => a === 'code');
          const afterCode = idxCode >= 0 ? rawArgv.slice(idxCode + 1) : [];
          const sepIndex = afterCode.indexOf('--');
          const tail = sepIndex >= 0 ? afterCode.slice(sepIndex + 1) : afterCode;
          const knownOpts = new Set(['-p','--port','-h','--host','-c','--config','--claude-path','--model','--profile','--ensure-server']);
          const requireValue = new Set(['-p','--port','-h','--host','-c','--config','--claude-path','--model','--profile']);
          const passThrough: string[] = [];
          for (let i = 0; i < tail.length; i++) {
            const tok = tail[i];
            if (!tok) continue;
            if (knownOpts.has(tok)) { if (requireValue.has(tok)) i++; continue; }
            passThrough.push(tok);
          }
          claudeArgs.push(...passThrough);
        } catch {}

        const claudeBin = String(options.claudePath || 'claude');
        const { spawn } = await import('child_process');
        const claudeProcess = spawn(claudeBin, claudeArgs, { stdio: 'inherit', env: claudeEnv });
        claudeProcess.on('exit', (code) => process.exit(code ?? 0));
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });
}
