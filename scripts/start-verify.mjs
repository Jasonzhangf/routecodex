#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const args = process.argv.slice(2);

function readFlag(name) {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) {
    return '';
  }
  return String(args[index + 1] || '').trim();
}

function argsWithoutValueFlags(names) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (names.has(arg)) {
      i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function runChild(command, childArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, childArgs, {
      stdio: 'inherit',
      env: process.env,
      cwd: process.cwd(),
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
      } else {
        resolve(code ?? 0);
      }
    });
  });
}

function readConfiguredPort(configPath) {
  if (!configPath) {
    return '';
  }
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    return '';
  }
  const text = fs.readFileSync(resolved, 'utf8');
  try {
    const parsed = JSON.parse(text);
    const groupedPort = Array.isArray(parsed?.httpserver?.ports)
      ? parsed.httpserver.ports
          .map((entry) => entry?.port)
          .find((value) => Number.isInteger(value) && value > 0)
      : undefined;
    const port = groupedPort ?? parsed?.httpserver?.port ?? parsed?.server?.port ?? parsed?.port;
    if (Number.isInteger(port) && port > 0) {
      return String(port);
    }
  } catch {
    // Non-JSON configs are parsed below with the narrow server-level port shape.
  }
  const match = text.match(/(?:^|\n)\s*port\s*=\s*([0-9]+)/);
  return match ? match[1] : '';
}

const rawMode = readFlag('--mode').toLowerCase();
if (rawMode === 'bg' || rawMode === 'fg') {
  const timeout = readFlag('--timeout') || (rawMode === 'bg' ? '180' : '90');
  const config = readFlag('--config') || readFlag('-c');
  const configuredPort = readConfiguredPort(config);
  const serverCommand = [
    ...(config ? [`ROUTECODEX_CONFIG_PATH=${shellQuote(config)}`] : []),
    'node',
    'dist/index.js',
  ].join(' ');
  const runner = rawMode === 'bg'
    ? path.join(__dirname, 'run-bg.sh')
    : path.join(__dirname, 'run-fg-gtimeout.sh');
  const runnerArgs = rawMode === 'bg'
    ? [...(configuredPort ? ['--port', configuredPort] : []), '--', serverCommand, timeout]
    : [timeout, ...(configuredPort ? ['--port', configuredPort] : []), '--', serverCommand];
  process.exit(await runChild('bash', [runner, ...runnerArgs]));
}

const forwarded = argsWithoutValueFlags(new Set(['--verify-mode']));
const verifyMode = readFlag('--verify-mode');
const hasProtocolMode = forwarded.some((arg, idx) => (
  arg === '--mode' && typeof forwarded[idx + 1] === 'string'
));
if (verifyMode) {
  forwarded.push('--mode', verifyMode);
} else if (!hasProtocolMode) {
  forwarded.push('--mode', 'both');
}

const target = path.join(__dirname, 'install-verify.mjs');
process.exit(await runChild(process.execPath, [target, ...forwarded]));
