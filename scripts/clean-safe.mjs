#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const cwd = process.cwd();
const distDir = path.join(cwd, 'dist');
const coverageDir = path.join(cwd, 'coverage');

function removeDir(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function isTruthy(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function readPortFromConfig(configPath) {
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const json = JSON.parse(raw);
    const port = (json && typeof json.httpserver === 'object' && typeof json.httpserver.port === 'number')
      ? json.httpserver.port
      : json?.port;
    return typeof port === 'number' && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function resolveConfigPath() {
  const explicit = String(process.env.ROUTECODEX_CONFIG_PATH || process.env.ROUTECODEX_CONFIG || '').trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  return path.join(os.homedir(), '.routecodex', 'config.json');
}

function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readProcessCommand(pid) {
  if (process.platform === 'win32') {
    return '';
  }
  try {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    if (result.error || Number(result.status ?? 0) !== 0) {
      return '';
    }
    return String(result.stdout || '').trim();
  } catch {
    return '';
  }
}

function shouldPreserveDistForRunningServer() {
  if (!isTruthy(process.env.ROUTECODEX_BUILD_RESTART_ONLY ?? process.env.RCC_BUILD_RESTART_ONLY ?? '')) {
    return false;
  }

  const configPath = resolveConfigPath();
  if (!fs.existsSync(configPath)) {
    return false;
  }
  const port = readPortFromConfig(configPath);
  if (!port) {
    return false;
  }

  const pidFile = path.join(os.homedir(), '.routecodex', `server-${port}.pid`);
  if (!fs.existsSync(pidFile)) {
    return false;
  }
  const rawPid = Number.parseInt(String(fs.readFileSync(pidFile, 'utf8') || '').trim(), 10);
  if (!isPidAlive(rawPid)) {
    return false;
  }
  const command = readProcessCommand(rawPid);
  if (!command) {
    return false;
  }
  const distIndex = path.join(cwd, 'dist', 'index.js');
  const distCli = path.join(cwd, 'dist', 'cli.js');
  return command.includes(distIndex) || command.includes(distCli);
}

const skipDist =
  isTruthy(process.env.ROUTECODEX_SKIP_CLEAN ?? process.env.RCC_SKIP_CLEAN ?? '') ||
  shouldPreserveDistForRunningServer();

if (skipDist) {
  removeDir(coverageDir);
  process.stdout.write('[clean-safe] skipped dist removal (active server detected or skip flag set)\n');
  process.exit(0);
}

removeDir(distDir);
removeDir(coverageDir);
process.stdout.write('[clean-safe] removed dist/ and coverage/\n');
