#!/usr/bin/env node
/**
 * Shared V4 build-domain helpers.
 *
 * v4Root is resolved from this module's own location (import.meta.url), never
 * from process.cwd(), so every canonical entrypoint behaves identically from
 * `cd v4`, the repository root dispatcher, or an unrelated working directory.
 */
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const v4Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function run(command, options = {}) {
  const cwd = options.cwd ?? v4Root;
  try {
    execSync(command, { cwd, stdio: 'inherit', env: process.env });
  } catch (error) {
    const message = error?.status
      ? `command failed with exit ${error.status}: ${command}`
      : `command failed: ${command}: ${error?.message ?? error}`;
    throw new Error(message);
  }
}

export function runIndependent(entries) {
  if (!Array.isArray(entries)) throw new TypeError('independent entries must be an array');
  const failures = [];
  for (const entry of entries) {
    const command = typeof entry === 'string' ? entry : entry?.command;
    const label = typeof entry === 'string' ? entry : entry?.label ?? command;
    if (typeof command !== 'string' || command.length === 0) {
      throw new TypeError('independent entry command must be a non-empty string');
    }
    try {
      run(command, entry?.options);
    } catch (error) {
      failures.push({ label, message: error?.message ?? String(error) });
    }
  }
  return failures;
}

export function reportIndependentFailures(scope, failures) {
  if (failures.length === 0) return;
  console.error(`[v4 ${scope}] FATAL ${failures.length} independent check(s) failed`);
  for (const failure of failures) console.error(`- ${failure.label}: ${failure.message}`);
}

export function runCapture(command, options = {}) {
  const cwd = options.cwd ?? v4Root;
  return execSync(command, { cwd, encoding: 'utf8', env: process.env });
}
