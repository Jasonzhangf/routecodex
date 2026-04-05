#!/usr/bin/env node
/**
 * RouteCodex memory guard (PID-scoped, no broad kill).
 *
 * Usage:
 *   node scripts/monitor/memory-guard.mjs --port 5555 --rss-mb 8192
 *   node scripts/monitor/memory-guard.mjs --port 5555 --rss-mb 4096 --action restart
 *   node scripts/monitor/memory-guard.mjs --port 5555 --rss-mb 2048 --once
 */

import { execSync, spawnSync } from 'node:child_process';

function parseArgs(argv) {
  const options = {
    port: 5555,
    rssMb: 8192,
    intervalMs: 2000,
    graceMs: 5000,
    action: 'kill', // kill | restart
    once: false
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--port' && i + 1 < args.length) {
      options.port = Number.parseInt(String(args[++i]), 10);
      continue;
    }
    if (arg === '--rss-mb' && i + 1 < args.length) {
      options.rssMb = Number.parseInt(String(args[++i]), 10);
      continue;
    }
    if (arg === '--interval-ms' && i + 1 < args.length) {
      options.intervalMs = Number.parseInt(String(args[++i]), 10);
      continue;
    }
    if (arg === '--grace-ms' && i + 1 < args.length) {
      options.graceMs = Number.parseInt(String(args[++i]), 10);
      continue;
    }
    if (arg === '--action' && i + 1 < args.length) {
      const action = String(args[++i]).trim().toLowerCase();
      options.action = action === 'restart' ? 'restart' : 'kill';
      continue;
    }
    if (arg === '--once') {
      options.once = true;
      continue;
    }
  }
  if (!Number.isFinite(options.port) || options.port <= 0) {
    throw new Error(`invalid --port: ${options.port}`);
  }
  if (!Number.isFinite(options.rssMb) || options.rssMb <= 0) {
    throw new Error(`invalid --rss-mb: ${options.rssMb}`);
  }
  if (!Number.isFinite(options.intervalMs) || options.intervalMs < 200) {
    options.intervalMs = 2000;
  }
  if (!Number.isFinite(options.graceMs) || options.graceMs < 0) {
    options.graceMs = 5000;
  }
  return options;
}

function nowIso() {
  return new Date().toISOString();
}

function log(line) {
  console.log(`[${nowIso()}] [memory-guard] ${line}`);
}

function runStdout(command) {
  try {
    return String(execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) || '').trim();
  } catch {
    return '';
  }
}

function resolveListenerPid(port) {
  const out = runStdout(`lsof -t -nP -iTCP:${port} -sTCP:LISTEN | head -n 1`);
  const pid = Number.parseInt(out, 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function readPidCommand(pid) {
  return runStdout(`ps -o command= -p ${pid}`);
}

function readPidRssMb(pid) {
  const out = runStdout(`ps -o rss= -p ${pid}`);
  const rssKb = Number.parseInt(out, 10);
  if (!Number.isFinite(rssKb) || rssKb <= 0) {
    return null;
  }
  return Math.round((rssKb / 1024) * 10) / 10;
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isLikelyRouteCodexProcess(commandText) {
  const text = String(commandText || '').toLowerCase();
  return (
    text.includes('routecodex')
    || text.includes('dist/index.js')
    || (text.includes('node') && text.includes('rcc'))
  );
}

async function terminatePidScoped(pid, graceMs) {
  log(`threshold exceeded, terminate pid=${pid} with SIGTERM`);
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    log(`SIGTERM failed for pid=${pid}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      log(`pid=${pid} exited after SIGTERM`);
      return;
    }
    await sleep(250);
  }
  if (isPidAlive(pid)) {
    log(`pid=${pid} still alive after ${graceMs}ms, escalate SIGKILL`);
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      log(`SIGKILL failed for pid=${pid}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
  }
}

function restartRouteCodex(port) {
  log(`attempt restart on port=${port}`);
  const result = spawnSync('routecodex', ['restart', '--port', String(port)], {
    stdio: 'inherit'
  });
  if ((result.status ?? 1) !== 0) {
    log(`restart failed with status=${result.status ?? -1}`);
  } else {
    log('restart completed');
  }
}

async function evaluateOnce(options) {
  const pid = resolveListenerPid(options.port);
  if (!pid) {
    log(`no listener found on port=${options.port}`);
    return;
  }
  const cmd = readPidCommand(pid);
  const rssMb = readPidRssMb(pid);
  if (!isLikelyRouteCodexProcess(cmd)) {
    log(`skip pid=${pid}, command does not look like RouteCodex: ${cmd}`);
    return;
  }
  if (rssMb === null) {
    log(`pid=${pid} rss unavailable`);
    return;
  }
  log(`pid=${pid} rss=${rssMb}MB threshold=${options.rssMb}MB`);
  if (rssMb < options.rssMb) {
    return;
  }
  await terminatePidScoped(pid, options.graceMs);
  if (options.action === 'restart') {
    restartRouteCodex(options.port);
  }
}

async function main() {
  const options = parseArgs(process.argv);
  log(
    `start port=${options.port} rssMb=${options.rssMb} intervalMs=${options.intervalMs} action=${options.action} once=${options.once}`
  );
  if (options.once) {
    await evaluateOnce(options);
    return;
  }
  while (true) {
    await evaluateOnce(options);
    await sleep(options.intervalMs);
  }
}

main().catch((error) => {
  log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

