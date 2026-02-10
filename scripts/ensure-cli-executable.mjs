#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

if (process.platform === 'win32') {
  process.exit(0);
}

function ensureExecutable(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return;
  }
  try {
    const stat = fs.statSync(filePath);
    const nextMode = stat.mode | 0o111;
    fs.chmodSync(filePath, nextMode);
  } catch {
    // ignore best-effort chmod failures
  }
}

function getCommandOutput(command) {
  try {
    return execSync(command, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

function ensureLocalCli() {
  const cliPath = path.join(process.cwd(), 'dist', 'cli.js');
  ensureExecutable(cliPath);
}

function ensureGlobalBinTarget(binName) {
  const prefix = getCommandOutput('npm config get prefix');
  if (!prefix) {
    return;
  }

  const binPath = path.join(prefix, 'bin', binName);
  if (fs.existsSync(binPath)) {
    try {
      const realTarget = fs.realpathSync(binPath);
      ensureExecutable(realTarget);
    } catch {
      ensureExecutable(binPath);
    }
  }

  const globalRoot = getCommandOutput('npm root -g');
  if (!globalRoot) {
    return;
  }

  const packageName = binName === 'rcc' ? '@jsonstudio/rcc' : 'routecodex';
  const globalCliPath = path.join(globalRoot, packageName, 'dist', 'cli.js');
  ensureExecutable(globalCliPath);
}

ensureLocalCli();
ensureGlobalBinTarget('routecodex');
ensureGlobalBinTarget('rcc');
