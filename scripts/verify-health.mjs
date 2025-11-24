#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_PORT = 5560;
const DEFAULT_TIMEOUT_MS = 45000;
const baseDir = process.cwd();
const port = Number(process.env.ROUTECODEX_INSTALL_HEALTH_PORT || DEFAULT_PORT);
const timeoutMs = Number(process.env.ROUTECODEX_INSTALL_HEALTH_TIMEOUT || DEFAULT_TIMEOUT_MS);
const healthUrl = process.env.ROUTECODEX_INSTALL_HEALTH_URL || `http://127.0.0.1:${port}/health`;

const env = {
  ...process.env,
  ROUTECODEX_PORT: String(port),
  RCC_PORT: String(port),
  ROUTECODEX_BASEDIR: baseDir,
  RCC_BASEDIR: baseDir
};

const server = spawn(process.execPath, ['dist/index.js'], {
  cwd: baseDir,
  env,
  stdio: ['ignore', 'inherit', 'inherit']
});

async function waitForHealth() {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Server exited before health check completed (exit ${server.exitCode})`);
    }
    try {
      const res = await fetch(healthUrl, { cache: 'no-store' });
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        console.log(`✅ Health check passed (${healthUrl})`, body?.status || 'ok');
        return;
      }
    } catch (error) {
      // swallow and retry
    }
    await delay(1000);
  }
  throw new Error(`Health check timed out after ${timeoutMs}ms (URL: ${healthUrl})`);
}

(async () => {
  try {
    await waitForHealth();
  } catch (error) {
    server.kill('SIGINT');
    await once(server, 'exit').catch(() => {});
    console.error('❌ Health check failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
  server.kill('SIGINT');
  await once(server, 'exit').catch(() => {});
  console.log('🛑 Temporary server stopped after health check.');
  process.exit(0);
})();
