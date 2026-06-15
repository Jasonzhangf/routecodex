import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  colorizeVirtualRouterHitLogLine,
  extractLeadingAnsiColor,
  stripAnsiCodes
} from '../../utils/request-log-color.js';

export interface PortRequestContext {
  localPort?: number;
  matchedPort?: number;
  routingPolicyGroup?: string;
  logNamespace?: string;
}

const storage = new AsyncLocalStorage<PortRequestContext>();
let installed = false;
const fileDescriptors = new Map<number, number>();

function resolveLogRoot(): string | null {
  const raw = process.env.ROUTECODEX_PORT_LOG_ROOT ?? process.env.RCC_PORT_LOG_ROOT;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return trimmed ? path.resolve(trimmed) : null;
}

function resolvePort(context: PortRequestContext | undefined): number | undefined {
  const port = context?.matchedPort ?? context?.localPort;
  return typeof port === 'number' && Number.isFinite(port) && port > 0 ? Math.floor(port) : undefined;
}

function writePortLine(port: number, line: string): boolean {
  const root = resolveLogRoot();
  if (!root) {
    return false;
  }
  try {
    fs.mkdirSync(path.join(root, String(port)), { recursive: true });
    let fd = fileDescriptors.get(port);
    if (typeof fd !== 'number') {
      fd = fs.openSync(path.join(root, String(port), `server-${port}.log`), 'a');
      fileDescriptors.set(port, fd);
    }
    fs.writeSync(fd, `${line}\n`);
    return true;
  } catch {
    return false;
  }
}

function stringifyArg(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function resolvePortPrefix(context: PortRequestContext | undefined, port: number | undefined): string {
  if (!context || !port) {
    return '';
  }
  const group = typeof context.routingPolicyGroup === 'string' && context.routingPolicyGroup.trim()
    ? ` group:${context.routingPolicyGroup.trim()}`
    : '';
  return `[port:${port}${group}]`;
}

function prefixArgsWithPort(args: unknown[], prefix: string): unknown[] {
  if (!prefix) {
    return args;
  }
  if (args.length === 0) {
    return [prefix];
  }
  const first = args[0];
  if (typeof first === 'string') {
    const lineColor = extractLeadingAnsiColor(first);
    if (lineColor) {
      const plainPrefix = stripAnsiCodes(prefix);
      return [`${lineColor}${plainPrefix} ${first}\x1b[0m`, ...args.slice(1)];
    }
    return [`${prefix} ${first}`, ...args.slice(1)];
  }
  return [prefix, ...args];
}

export function installPortLogConsoleRouter(): void {
  if (installed) {
    return;
  }
  installed = true;
  const originalLog = console.log.bind(console);
  const originalInfo = console.info.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);
  const wrap = (original: (...args: unknown[]) => void) => (...args: unknown[]) => {
    const context = storage.getStore();
    const port = resolvePort(context);
    const prefix = resolvePortPrefix(context, port);
    const routedArgs =
      args.length === 1 && typeof args[0] === 'string'
        ? [colorizeVirtualRouterHitLogLine(args[0])]
        : args;
    const prefixedArgs = prefixArgsWithPort(routedArgs, prefix);
    if (port) {
      writePortLine(port, prefixedArgs.map(stringifyArg).join(' '));
    }
    original(...prefixedArgs);
  };
  console.log = wrap(originalLog) as typeof console.log;
  console.info = wrap(originalInfo) as typeof console.info;
  console.warn = wrap(originalWarn) as typeof console.warn;
  console.error = wrap(originalError) as typeof console.error;
}

export function runWithPortRequestContext<T>(context: PortRequestContext | undefined, fn: () => T): T {
  if (!context || !resolvePort(context)) {
    return fn();
  }
  return storage.run(context, fn);
}

export function getCurrentPortRequestContext(): PortRequestContext | undefined {
  return storage.getStore();
}

export function closePortLogConsoleRouterFiles(): void {
  for (const fd of fileDescriptors.values()) {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore close errors during shutdown/test cleanup
    }
  }
  fileDescriptors.clear();
}
