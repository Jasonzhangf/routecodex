#!/usr/bin/env node

/**
 * Wrapper around install-verify:
 * - Ensures default mode is `responses`
 * - Allows existing CLI flags to pass through unchanged
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);
const hasModeFlag = args.some((arg, idx) => arg === '--mode' && typeof args[idx + 1] === 'string');
// 默认改为同时验证 Chat + Responses（可以通过 --mode chat/responses/both/all 覆盖）
const forwarded = hasModeFlag ? args : [...args, '--mode', 'both'];

const target = path.join(__dirname, 'install-verify.mjs');
const childProcess = (await import('node:child_process')).spawn;
const child = childProcess(process.execPath, [target, ...forwarded], {
  stdio: 'inherit',
  env: process.env,
  cwd: process.cwd()
});
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
