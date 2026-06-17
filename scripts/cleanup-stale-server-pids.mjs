#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const quiet = process.argv.includes('--quiet');
const rccHome = path.join(os.homedir(), '.rcc');
const legacyRouteCodexHome = path.join(os.homedir(), '.routecodex');

function log(message) {
  if (!quiet) {
    console.log(`[cleanup:server-pids] ${message}`);
  }
}

function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
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
    return String(result.stdout || '').trim().toLowerCase();
  } catch {
    return '';
  }
}

function isTrustedRouteCodexCommand(command) {
  const normalized = String(command || '').trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized.includes('routecodex/dist/index.js')) {
    return true;
  }
  if (normalized.includes('routecodex/dist/cli.js')) {
    return true;
  }
  return false;
}

function isPidListeningOnPort(pid, port) {
  if (process.platform === 'win32') {
    return true;
  }
  try {
    const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    if (result.error) {
      return true;
    }
    if (Number(result.status ?? 0) !== 0) {
      return false;
    }
    const pids = String(result.stdout || '')
      .split(/\r?\n/)
      .map((entry) => Number.parseInt(entry.trim(), 10))
      .filter((entry) => Number.isFinite(entry) && entry > 0);
    return pids.includes(pid);
  } catch {
    return true;
  }
}

function cleanupPidFile(filePath) {
  const fileName = path.basename(filePath);
  const match = fileName.match(/^server-(\d+)\.pid$/i);
  const cachePort = fileName === 'pid.cache'
    ? Number.parseInt(path.basename(path.dirname(filePath)), 10)
    : null;
  const filePort = match
    ? Number.parseInt(match[1], 10)
    : (Number.isFinite(cachePort) && cachePort > 0 ? cachePort : null);
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { removed: false, reason: 'unreadable' };
  }
  const trimmed = String(raw || '').trim();
  let pid = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    try {
      const parsed = JSON.parse(trimmed);
      pid = Number.parseInt(String(parsed?.pid || '').trim(), 10);
    } catch {
      pid = Number.NaN;
    }
  }
  if (!Number.isFinite(pid) || pid <= 0) {
    fs.rmSync(filePath, { force: true });
    return { removed: true, reason: 'invalid_pid' };
  }
  if (!isPidAlive(pid)) {
    fs.rmSync(filePath, { force: true });
    return { removed: true, reason: 'pid_not_alive' };
  }

  const command = readProcessCommand(pid);
  if (command && !isTrustedRouteCodexCommand(command)) {
    fs.rmSync(filePath, { force: true });
    return { removed: true, reason: 'pid_not_routecodex' };
  }
  if (Number.isFinite(filePort) && filePort > 0 && !isPidListeningOnPort(pid, filePort)) {
    fs.rmSync(filePath, { force: true });
    return { removed: true, reason: 'pid_not_listening_on_port' };
  }

  return { removed: false, reason: `kept:${fileName}:${pid}` };
}

function main() {
  const candidates = [];
  for (const rootDir of [rccHome, legacyRouteCodexHome]) {
    if (!fs.existsSync(rootDir)) {
      continue;
    }
    const entries = fs.readdirSync(rootDir);
    for (const name of entries) {
      if (/^server-\d+\.pid$/i.test(name) || name === 'server.cli.pid') {
        candidates.push(path.join(rootDir, name));
      }
    }
  }
  const runtimePortsDir = path.join(rccHome, 'state', 'runtime-lifecycle', 'ports');
  if (fs.existsSync(runtimePortsDir)) {
    for (const portEntry of fs.readdirSync(runtimePortsDir, { withFileTypes: true })) {
      if (!portEntry.isDirectory()) {
        continue;
      }
      const cachePath = path.join(runtimePortsDir, portEntry.name, 'pid.cache');
      if (fs.existsSync(cachePath)) {
        candidates.push(cachePath);
      }
    }
  }

  let removed = 0;
  let kept = 0;
  for (const filePath of candidates) {
    const result = cleanupPidFile(filePath);
    if (result.removed) {
      removed += 1;
      log(`removed ${path.basename(filePath)} (${result.reason})`);
    } else {
      kept += 1;
      log(`kept ${path.basename(filePath)} (${result.reason})`);
    }
  }
  log(`done removed=${removed} kept=${kept}`);
}

main();
