#!/usr/bin/env node

/**
 * Post-build response chain verification
 * Runs:
 *   1. Chat SSE roundtrip
 *   2. Responses conversion roundtrip
 * Fails fast if any step fails.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), '..', '..');

const tests = [
  { label: 'chat-sse-roundtrip (synthetic)', command: process.execPath, args: [path.join(projectRoot, 'scripts', 'tests', 'sse-node-roundtrip.mjs')] },
  { label: 'chat-sse-roundtrip (golden)', command: process.execPath, args: [path.join(projectRoot, 'scripts', 'tests', 'chat-golden-roundtrip.mjs')] },
  { label: 'responses-roundtrip (fixtures)', command: process.execPath, args: [path.join(projectRoot, 'scripts', 'tests', 'responses-roundtrip.mjs')] },
  { label: 'responses-sse-roundtrip (golden)', command: process.execPath, args: [path.join(projectRoot, 'scripts', 'tests', 'responses-golden-roundtrip.mjs')] },
  { label: 'anthropic-roundtrip (fixtures)', command: process.execPath, args: [path.join(projectRoot, 'scripts', 'tests', 'anthropic-roundtrip.mjs')] }
];

async function runTest({ label, command, args }) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', cwd: projectRoot });
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${label} terminated with signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${label} failed with exit code ${code}`));
        return;
      }
      resolve();
    });
    child.on('error', (error) => reject(error));
  });
}

try {
  for (const test of tests) {
    console.log(`\n▶ Running ${test.label}...`);
    await runTest(test);
  }
  console.log('\n✅ Response chain verification completed successfully');
} catch (error) {
  console.error('❌ Response chain verification failed:', error);
  process.exitCode = 1;
}
