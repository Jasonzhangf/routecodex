import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import chalk from 'chalk';
import { createSpinner } from '../spinner.js';
import { LOCAL_HOSTS, DEFAULT_CONFIG } from '../../constants/index.js';
import { ensurePortAvailable } from '../server-runner.js';

export function registerMonitorCommand(program: Command) {
  program
    .command('monitor')
    .description('Monitoring utilities and transparent passthrough')
    .argument('[sub]', 'Subcommand: start | status')
    .option('-c, --config <config>', 'Configuration file path (default: ~/.routecodex/config.json)')
    .action(async (sub: string | undefined, options) => {
      const userCfgPath = options.config || path.join(homedir(), '.routecodex', 'config.json');

      const ensureMonitorJsonForCodexFc = () => {
        try {
          const codexPath = path.join(homedir(), '.codex', 'config.toml');
          if (!fs.existsSync(codexPath)) {return { ok: false };}
          const txt = fs.readFileSync(codexPath, 'utf8');
          const lines = txt.split(/\r?\n/);
          let inFc = false; let baseUrl: string | null = null; let envKey: string | null = null;
          for (const raw of lines) {
            const line = raw.trim();
            if (/^\[.*\]$/.test(line)) { inFc = /^\[\s*model_providers\.fc\s*\]$/.test(line); continue; }
            if (!inFc) {continue;}
            const m1 = line.match(/^base_url\s*=\s*"([^"]+)"/); if (m1) {baseUrl = m1[1];}
            const m2 = line.match(/^env_key\s*=\s*"([^"]+)"/); if (m2) {envKey = m2[1];}
          }
          if (!baseUrl) {return { ok: false };}
          const monDir = path.join(homedir(), '.routecodex'); fs.mkdirSync(monDir, { recursive: true });
          const monPath = path.join(monDir, 'monitor.json');
          let j: any = {}; try { j = JSON.parse(fs.readFileSync(monPath, 'utf8')); } catch {}
          j.mode = j.mode || 'transparent';
          j.transparent = j.transparent || {};
          j.transparent.enabled = true;
          j.transparent.endpoints = j.transparent.endpoints || {};
          j.transparent.endpoints.openai = baseUrl;
          j.transparent.preferClientHeaders = (j.transparent.preferClientHeaders !== false);
          if (!j.transparent.wireApi) { j.transparent.wireApi = 'responses'; }
          if (!j.transparent.modelMapping || typeof j.transparent.modelMapping !== 'object') { j.transparent.modelMapping = {}; }
          const envRef = envKey && /^[A-Z0-9_]+$/.test(envKey) ? envKey : 'FC_API_KEY';
          j.transparent.auth = j.transparent.auth || {}; j.transparent.auth.openai = `env:${envRef}`;
          fs.writeFileSync(monPath, JSON.stringify(j, null, 2), 'utf8');
          return { ok: true, monPath, baseUrl, envKey: envRef };
        } catch (e) { return { ok: false, error: (e as any)?.message || String(e) }; }
      };

      const showStatus = () => {
        try {
          const monPath = path.join(homedir(), '.routecodex', 'monitor.json');
          let j: any = null; if (fs.existsSync(monPath)) { try { j = JSON.parse(fs.readFileSync(monPath, 'utf8')); } catch { j = null; } }
          console.log(chalk.cyan('Monitoring status:'));
          console.log(`  monitor.json : ${fs.existsSync(monPath) ? monPath : '(missing)'}`);
          const mode = j?.mode || (j?.transparent?.enabled ? 'transparent' : 'off');
          console.log(`  mode         : ${mode}`);
          console.log(`  upstream     : ${j?.transparent?.endpoints?.openai || '(unset)'}`);
          const auth = j?.transparent?.auth?.openai || '(unset)';
          console.log(`  auth         : ${auth}`);
        } catch (e) {
          console.error(chalk.red('Failed to read monitor status:'), (e as Error)?.message || e);
          process.exit(2);
        }
      };

      if (!sub) sub = 'start';
      if (sub === 'status') return showStatus();
      if (sub === 'start') {
        const spinner = await createSpinner('Starting RouteCodex in monitor mode...');
        try {
          const filled = ensureMonitorJsonForCodexFc();
          if (filled.ok) {
            spinner.info(`monitor.json updated for fc upstream: ${filled.baseUrl}`);
            if (!process.env[filled.envKey!]) console.log(chalk.yellow(`Hint: export ${filled.envKey}='<your_fc_api_key>'`));
          } else {
            spinner.info('monitor.json not updated from codex fc (no ~/.codex/config.toml). Using existing monitor.json if present.');
          }
          if (!fs.existsSync(userCfgPath)) {
            spinner.fail(`Configuration file not found: ${userCfgPath}`);
            console.log(`Create minimal config, e.g.: {"httpserver":{"host":"${LOCAL_HOSTS.IPV4}","port":${DEFAULT_CONFIG.PORT}}}`);
            process.exit(1);
          }
          const cfg = JSON.parse(fs.readFileSync(userCfgPath, 'utf8'));
          const port = (cfg?.httpserver?.port ?? cfg?.server?.port ?? cfg?.port);
          if (!port || typeof port !== 'number' || port <= 0) { spinner.fail('Invalid or missing port configuration'); process.exit(1); }

          await ensurePortAvailable(port, spinner, { restart: true });
          const nodeBin = process.execPath;
          const serverEntry = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../index.js');
          const { spawn } = await import('child_process');
          const env = { ...process.env } as NodeJS.ProcessEnv;
          env.ROUTECODEX_CONFIG = userCfgPath;
          env.ROUTECODEX_MONITOR_ENABLED = '1';
          env.ROUTECODEX_MONITOR_AB = '1';
          // 不显式传递 modules.json 路径，按工作目录/用户目录解析
          spawn(nodeBin, [serverEntry], { stdio: 'inherit', env });
          spinner.succeed('RouteCodex (monitor mode) starting');
          console.log(`Config: ${userCfgPath}`);
          console.log('Press Ctrl+C to stop');
        } catch (e) {
          spinner.fail('Failed to start monitor mode');
          console.error(e instanceof Error ? e.message : String(e));
          process.exit(1);
        }
        return;
      }
      console.error(chalk.red('Unknown subcommand. Use: rcc monitor start | rcc monitor status'));
      process.exit(2);
    });
}
