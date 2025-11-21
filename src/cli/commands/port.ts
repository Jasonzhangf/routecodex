import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import { createSpinner } from '../spinner.js';
import { findListeningPids, sleep } from '../server-runner.js';

export function registerPortCommand(program: Command) {
  program
    .command('port')
    .description('Port utilities (doctor)')
    .argument('<sub>', 'Subcommand: doctor')
    .argument('[port]', 'Port number')
    .option('--kill', 'Kill all listeners on the port')
    .action(async (sub: string, portArg: string | undefined, opts: { kill?: boolean }) => {
      if ((sub || '').toLowerCase() !== 'doctor') {
        console.error(chalk.red("Unknown subcommand. Use: rcc port doctor [port] [--kill]"));
        process.exit(2);
      }
      const spinner = await createSpinner('Inspecting port...');
      try {
        let port = Number(portArg || 0);
        if (!Number.isFinite(port) || port <= 0) {
          const cfgPath = path.join(homedir(), '.routecodex', 'config.json');
          if (fs.existsSync(cfgPath)) {
            try {
              const raw = fs.readFileSync(cfgPath, 'utf8');
              const cfg = JSON.parse(raw);
              port = (cfg?.httpserver?.port ?? cfg?.server?.port ?? cfg?.port) || port;
            } catch {}
          }
        }
        if (!Number.isFinite(port) || port <= 0) {
          spinner.fail('Missing port. Provide an explicit port or set it in ~/.routecodex/config.json');
          process.exit(1);
        }

        const pids = findListeningPids(port);
        spinner.stop();
        console.log(chalk.cyan(`Port ${port} listeners:`));
        if (!pids.length) {
          console.log('  (none)');
        } else {
          for (const pid of pids) {
            let cmd = '';
            try { cmd = require('child_process').spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim(); } catch {}
            console.log(`  PID ${pid} ${cmd}`);
          }
        }

        if (opts.kill && pids.length) {
          const ksp = await createSpinner(`Killing ${pids.length} listener(s) on ${port}...`);
          for (const pid of pids) {
            try { process.kill(pid, 'SIGKILL'); } catch (e) { ksp.warn(`Failed to kill ${pid}: ${(e as Error).message}`); }
          }
          await sleep(300);
          const remain = findListeningPids(port);
          if (remain.length) {
            ksp.fail(`Some listeners remain: ${remain.join(', ')}`);
            process.exit(1);
          }
          ksp.succeed(`Port ${port} is now free.`);
        }
      } catch (e) {
        spinner.fail('Port inspection failed');
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
      }
    });
}

