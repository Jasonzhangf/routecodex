#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

export async function createTempConfig(builder, port) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-runner-'));
  const file = path.join(dir, 'config.json');
  const payload = typeof builder === 'function' ? builder(port) : builder;
  await fs.writeFile(file, JSON.stringify(payload, null, 2), 'utf-8');
  return { dir, file };
}

export function startServer({ env = {} }) {
  const executable = path.join(PROJECT_ROOT, 'dist', 'index.js');
  const child = spawn(process.execPath, [executable], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => process.stdout.write(chunk));
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  return child;
}

export async function stopServer(child) {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  child.kill('SIGKILL');
}
