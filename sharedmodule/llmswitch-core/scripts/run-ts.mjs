#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function resolveLocalModule(specifier) {
  try {
    return require.resolve(specifier, { paths: [process.cwd()] });
  } catch {
    return null;
  }
}

function printUsage() {
  // eslint-disable-next-line no-console
  console.error('Usage: node scripts/run-ts.mjs <entry.ts> [args...]');
}

const args = process.argv.slice(2);
if (!args.length) {
  printUsage();
  process.exit(1);
}

const entry = args[0];
const rest = args.slice(1);

const tsxPath = resolveLocalModule('tsx/dist/cli.mjs') || resolveLocalModule('tsx');
if (tsxPath) {
  const result = spawnSync(process.execPath, [tsxPath, entry, ...rest], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: process.env
  });
  process.exit(result.status ?? 1);
}

const tsNodeLoader = resolveLocalModule('ts-node/esm');
if (tsNodeLoader) {
  const result = spawnSync(process.execPath, ['--loader', tsNodeLoader, entry, ...rest], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: { ...process.env, TS_NODE_PREFER_TS_EXTS: '1' }
  });
  process.exit(result.status ?? 1);
}

const fallback = spawnSync('ts-node', ['--esm', '--prefer-ts-exts', entry, ...rest], {
  stdio: 'inherit',
  cwd: process.cwd(),
  env: process.env,
  shell: true
});
if (fallback.status !== null) {
  process.exit(fallback.status ?? 1);
}

const entryPath = path.resolve(entry);
// eslint-disable-next-line no-console
console.error(
  `No TypeScript runner found. Tried local tsx/ts-node loader and global ts-node.\n` +
  `Entry: ${entryPath}`
);
process.exit(1);
