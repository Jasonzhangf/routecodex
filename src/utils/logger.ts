import { inspect } from 'node:util';
import { DebugUtilsStatic } from './debug-utils.js';

type NumericOption = number | undefined;

export interface ConsoleFormatOptions {
  maxLength?: number;
  maxDepth?: number;
  maxArrayLength?: number;
  maxStringLength?: number;
}

const DEFAULT_MAX_LENGTH = 1600;
const DEFAULT_SANITIZE_DEPTH = 4;
const DEFAULT_SANITIZE_ARRAY_LENGTH = 20;
const DEFAULT_SANITIZE_STRING_LENGTH = 512;

function clampStringLength(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  const visible = Math.max(0, maxLength - 32);
  const head = value.slice(0, visible);
  const omitted = value.length - visible;
  return `${head}...[truncated ${omitted} chars]`;
}

function resolveNumber(value: NumericOption, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function sanitizeValue(value: unknown, options: ConsoleFormatOptions): unknown {
  return DebugUtilsStatic.sanitizeData(value, {
    maxDepth: resolveNumber(options.maxDepth, DEFAULT_SANITIZE_DEPTH),
    maxArrayLength: resolveNumber(options.maxArrayLength, DEFAULT_SANITIZE_ARRAY_LENGTH),
    maxStringLength: resolveNumber(options.maxStringLength, DEFAULT_SANITIZE_STRING_LENGTH)
  });
}

export function formatValueForConsole(value: unknown, options: ConsoleFormatOptions = {}): string {
  const maxLength = resolveNumber(options.maxLength, DEFAULT_MAX_LENGTH);
  try {
    const sanitized = sanitizeValue(value, options);
    const asString =
      typeof sanitized === 'string'
        ? sanitized
        : inspect(sanitized, {
            depth: resolveNumber(options.maxDepth, DEFAULT_SANITIZE_DEPTH),
            maxArrayLength: resolveNumber(options.maxArrayLength, DEFAULT_SANITIZE_ARRAY_LENGTH),
            maxStringLength: resolveNumber(options.maxStringLength, DEFAULT_SANITIZE_STRING_LENGTH),
            breakLength: 100,
            compact: 3
          });
    return clampStringLength(asString, maxLength);
  } catch {
    const fallbackText =
      typeof value === 'string'
        ? value
        : inspect(value, { depth: 2, breakLength: 80, compact: 3 });
    return clampStringLength(fallbackText, maxLength);
  }
}

export function logSanitizedError(label: string, error: unknown, options?: ConsoleFormatOptions): void {
  try {
    console.error(label, formatValueForConsole(error, options));
  } catch {
    console.error(label, error);
  }
}
