#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const v3Root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const manifestPath = resolve(v3Root, 'Cargo.toml');

export const v3TempDir = resolve(v3Root, 'build-control', 'temp');

export function run(command, args, options = {}) {
  const baseEnv = options.env ?? process.env;
  const env = { ...baseEnv, TMPDIR: v3TempDir, TMP: v3TempDir, TEMP: v3TempDir };
  mkdirSync(v3TempDir, { recursive: true });
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? v3Root,
    env,
    stdio: options.stdio ?? 'inherit',
    encoding: options.encoding,
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed: ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`,
    );
  }
  return result;
}
