#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), '..', '..');

const tests = [
  ['loop-rt-chat', path.join(root, 'scripts', 'tests', 'loop-rt-chat.mjs')],
  ['loop-rt-responses', path.join(root, 'scripts', 'tests', 'loop-rt-responses.mjs')],
  ['loop-rt-anthropic', path.join(root, 'scripts', 'tests', 'loop-rt-anthropic.mjs')]
];

function runOne([label, file]) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { stdio: 'inherit' });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed with code ${code}`));
    });
    child.on('error', reject);
  });
}

try {
  for (const t of tests) {
    console.log(`\n▶ Running ${t[0]}...`);
    // eslint-disable-next-line no-await-in-loop
    await runOne(t);
  }
  console.log('\n✅ All SSE loopback tests passed');
} catch (e) {
  console.error('❌ SSE loopback tests failed:', e);
  process.exit(1);
}

