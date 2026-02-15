import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DeepSeekErrorCode } from '../contracts/deepseek-provider-contract.js';

export type DeepSeekSessionPowError = Error & {
  code?: string;
  statusCode?: number;
  status?: number;
  upstreamCode?: string;
  details?: Record<string, unknown>;
};

export function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

export function normalizeInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : NaN;
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const floored = Math.floor(parsed);
  if (floored < min) {
    return min;
  }
  if (floored > max) {
    return max;
  }
  return floored;
}

export function createDeepSeekSessionPowError(params: {
  code: DeepSeekErrorCode;
  message: string;
  statusCode?: number;
  upstreamCode?: string;
  details?: Record<string, unknown>;
}): DeepSeekSessionPowError {
  const error = new Error(params.message) as DeepSeekSessionPowError;
  error.code = params.code;
  if (typeof params.statusCode === 'number') {
    error.statusCode = params.statusCode;
    error.status = params.statusCode;
  }
  if (typeof params.upstreamCode === 'string' && params.upstreamCode.trim()) {
    error.upstreamCode = params.upstreamCode.trim();
  }
  if (params.details) {
    error.details = params.details;
  }
  return error;
}

export function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function resolveBuiltInPowSolverPath(currentModuleUrl: string): string | undefined {
  const currentDir = path.dirname(fileURLToPath(currentModuleUrl));
  const candidates = [
    path.resolve(currentDir, '../../../scripts/deepseek/pow-solver.mjs'),
    path.resolve(currentDir, '../../../../scripts/deepseek/pow-solver.mjs'),
    path.resolve(process.cwd(), 'dist/scripts/deepseek/pow-solver.mjs'),
    path.resolve(process.cwd(), 'scripts/deepseek/pow-solver.mjs')
  ];
  return firstExistingPath(candidates);
}

export function resolveBuiltInPowWasmPath(currentModuleUrl: string): string | undefined {
  const currentDir = path.dirname(fileURLToPath(currentModuleUrl));
  const candidates = [
    path.resolve(currentDir, '../../../scripts/deepseek/sha3_wasm_bg.7b9ca65ddd.wasm'),
    path.resolve(currentDir, '../../../../scripts/deepseek/sha3_wasm_bg.7b9ca65ddd.wasm'),
    path.resolve(process.cwd(), 'dist/scripts/deepseek/sha3_wasm_bg.7b9ca65ddd.wasm'),
    path.resolve(process.cwd(), 'scripts/deepseek/sha3_wasm_bg.7b9ca65ddd.wasm')
  ];
  return firstExistingPath(candidates);
}

function firstExistingPath(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // ignore
    }
  }
  return undefined;
}

export function resolvePathWithFallback(
  preferredPath: string | undefined,
  builtInPath: string | undefined
): string | undefined {
  const preferred = normalizeString(preferredPath);
  if (preferred) {
    try {
      if (fs.existsSync(preferred)) {
        return preferred;
      }
    } catch {
      // ignore
    }
  }
  return builtInPath;
}
