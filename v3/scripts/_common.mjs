#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const v3Root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const manifestPath = resolve(v3Root, 'Cargo.toml');

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? v3Root,
    env: options.env ?? process.env,
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
