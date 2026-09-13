#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const v3Root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const manifestPath = resolve(v3Root, 'Cargo.toml');

export const v3TempDir = resolve(v3Root, 'build-control', 'temp');

// 门禁防挂死：每一步在独立进程组中运行并有硬超时。超时立刻 SIGTERM 整个
// 进程组，5 秒后升级 SIGKILL，门禁以错误返回——绝不无限等待。
const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;
const KILL_GRACE_MS = 5_000;

export class EnvironmentUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EnvironmentUnavailableError';
  }
}

export class GateFailureError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GateFailureError';
  }
}

function killProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

export async function run(command, args, options = {}) {
  const baseEnv = options.env ?? process.env;
  const env = { ...baseEnv, TMPDIR: v3TempDir, TMP: v3TempDir, TEMP: v3TempDir };
  mkdirSync(v3TempDir, { recursive: true });
  const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const label = `${command} ${args.join(' ')}`;
  const child = spawn(command, args, {
    cwd: options.cwd ?? v3Root,
    env,
    stdio: options.stdio ?? 'inherit',
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    detached: true,
  });
  let timedOut = false;
  const exited = new Promise((resolveExit) => {
    child.once('exit', (code, signal) =>
      resolveExit({ code: code ?? (signal ? -1 : 0), signal }),
    );
    child.once('error', (error) => resolveExit({ code: -2, error }));
  });
  const timer = setTimeout(() => {
    timedOut = true;
    killProcessGroup(child.pid, 'SIGTERM');
  }, timeoutMs);
  const outcome = await exited;
  clearTimeout(timer);
  if (timedOut) {
    if (outcome.signal) {
      setTimeout(() => killProcessGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS);
    }
    throw new GateFailureError(
      `${label} timed out after ${timeoutMs}ms and was killed (gate fail-fast: never hang)`,
    );
  }
  if (outcome.error) {
    throw new EnvironmentUnavailableError(`${label} unavailable: ${outcome.error.message}`);
  }
  if (outcome.code !== 0) {
    throw new GateFailureError(`${label} failed: exit ${outcome.code}`);
  }
  return outcome;
}

export async function runAll(entries) {
  const failures = [];
  const warnings = [];
  for (const entry of entries) {
    const label = entry.label ?? `${entry.command} ${(entry.args ?? []).join(' ')}`;
    try {
      await run(entry.command, entry.args ?? [], entry);
    } catch (error) {
      if (error instanceof EnvironmentUnavailableError && entry.optional === true) {
        warnings.push(`${label}: ${error.message}`);
      } else {
        failures.push(`${label}: ${error.message}`);
      }
    }
  }
  return { failures, warnings };
}
