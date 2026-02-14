/**
 * Log Filter Installation
 *
 * Minimal runtime log filter for reducing noise in production.
 */

import { createRequire } from 'node:module';

type NodeGlobalWithRequire = typeof globalThis & {
  require?: ReturnType<typeof createRequire>;
};

type UnknownRecord = Record<string, unknown>;

function resolveBoolFromEnv(value: unknown, fallback: boolean): boolean {
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function isMinimalRuntimeLogEnabled(): boolean {
  const env = process.env.ROUTECODEX_MINIMAL_RUNTIME_LOG ?? process.env.RCC_MINIMAL_RUNTIME_LOG;
  return resolveBoolFromEnv(env, false);
}

function installMinimalRuntimeLogFilter(): void {
  if (!isMinimalRuntimeLogEnabled()) {
    return;
  }
  const g = globalThis as NodeGlobalWithRequire;
  const nodeRequire = g.require ?? createRequire(import.meta.url);
  const events = nodeRequire('events') as { defaultMaxListeners?: number };
  if (typeof events?.defaultMaxListeners === 'number' && events.defaultMaxListeners < 20) {
    events.defaultMaxListeners = 20;
  }

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  const noisyPatterns = [
    /LiveviewFileReader/i,
    /Liveview.*reading/i,
    /SessionProfiler/i,
    /sendMessageAcquiring/i,
    /acquiring.*sendMessage/i,
    /sse-request:/i
  ];

  function shouldSuppress(chunk: unknown): boolean {
    if (typeof chunk !== 'string') return false;
    return noisyPatterns.some((p) => p.test(chunk));
  }

  process.stdout.write = ((chunk: unknown, encoding?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void) => {
    if (shouldSuppress(chunk)) {
      if (typeof cb === 'function') {
        cb(null);
      } else if (typeof encoding === 'function') {
        encoding(null);
      }
      return true;
    }
    if (typeof encoding === 'function') {
      return originalStdoutWrite(chunk as string, encoding as ((err?: Error | null) => void));
    }
    return originalStdoutWrite(chunk as string, encoding as BufferEncoding | undefined, cb);
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: unknown, encoding?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void) => {
    if (shouldSuppress(chunk)) {
      if (typeof cb === 'function') {
        cb(null);
      } else if (typeof encoding === 'function') {
        encoding(null);
      }
      return true;
    }
    if (typeof encoding === 'function') {
      return originalStderrWrite(chunk as string, encoding as ((err?: Error | null) => void));
    }
    return originalStderrWrite(chunk as string, encoding as BufferEncoding | undefined, cb);
  }) as typeof process.stderr.write;
}

export { installMinimalRuntimeLogFilter, isMinimalRuntimeLogEnabled, resolveBoolFromEnv };
export type { NodeGlobalWithRequire, UnknownRecord };
