import type { JsonObject } from '../../../../../types/json.js';
import { isShellLikeToolNameTokenWithNative } from '../../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';

const SHELL_LIKE_TOOL_NAMES = new Set(['exec_command', 'shell_command', 'shell', 'bash', 'terminal']);

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readStringArrayCommand(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const tokens = value
    .map((item) => (item == null ? '' : String(item).trim()))
    .filter((item) => item.length > 0);
  return tokens.length ? tokens.join(' ') : undefined;
}

function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return {};
  }
  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readCommandFromArgs(args: Record<string, unknown>): string | undefined {
  const input = isRecord(args.input) ? (args.input as Record<string, unknown>) : undefined;
  const direct =
    readTrimmedString(args.cmd) ??
    readTrimmedString(args.command) ??
    readTrimmedString(args.script) ??
    readTrimmedString(args.toon) ??
    readStringArrayCommand(args.cmd) ??
    readStringArrayCommand(args.command);
  if (direct) {
    return direct;
  }
  if (!input) {
    return undefined;
  }
  return (
    readTrimmedString(input.cmd) ??
    readTrimmedString(input.command) ??
    readTrimmedString(input.script) ??
    readStringArrayCommand(input.cmd) ??
    readStringArrayCommand(input.command)
  );
}

function readWorkdirFromArgs(args: Record<string, unknown>): string | undefined {
  const input = isRecord(args.input) ? (args.input as Record<string, unknown>) : undefined;
  return (
    readTrimmedString(args.workdir) ??
    readTrimmedString(args.cwd) ??
    readTrimmedString(args.workDir) ??
    readTrimmedString(input?.workdir) ??
    readTrimmedString(input?.cwd)
  );
}

function collectRequestedToolNames(payload: JsonObject): Set<string> {
  const names = new Set<string>();
  const root = payload as Record<string, unknown>;
  const tools = Array.isArray(root.tools) ? root.tools : [];
  for (const tool of tools) {
    if (!isRecord(tool)) continue;
    const fn = isRecord(tool.function) ? (tool.function as Record<string, unknown>) : undefined;
    const name = readTrimmedString(fn?.name) ?? readTrimmedString((tool as Record<string, unknown>).name);
    if (name) {
      names.add(name);
    }
  }
  return names;
}

function resolveShellLikeToolName(rawName: string, requestedToolNames: Set<string>): string {
  if (requestedToolNames.size === 0) {
    return rawName;
  }
  if (requestedToolNames.has(rawName)) {
    return rawName;
  }
  if (requestedToolNames.has('exec_command')) {
    return 'exec_command';
  }
  if (requestedToolNames.has('shell_command')) {
    return 'shell_command';
  }
  return rawName;
}

export function normalizeShellLikeToolCallsBeforeGovernanceFallback(payload: JsonObject): void {
  const root = payload as Record<string, unknown>;
  const messages = Array.isArray(root.messages) ? root.messages : [];
  if (!messages.length) {
    return;
  }
  const requestedToolNames = collectRequestedToolNames(payload);

  for (const message of messages) {
    if (!isRecord(message)) continue;
    const role = readTrimmedString(message.role)?.toLowerCase();
    if (role !== 'assistant') continue;
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (!toolCalls.length) continue;

    for (const call of toolCalls) {
      if (!isRecord(call)) continue;
      const fn = isRecord(call.function) ? (call.function as Record<string, unknown>) : undefined;
      if (!fn) continue;
      const rawName = readTrimmedString(fn.name);
      if (!rawName) continue;
      const isShellLike = isShellLikeToolNameTokenWithNative(rawName);
      if (!isShellLike) continue;

      const resolvedName = resolveShellLikeToolName(rawName, requestedToolNames);
      if (resolvedName !== rawName) {
        fn.name = resolvedName;
      }

      const parsedArgs = parseJsonRecord(fn.arguments);
      const args = parsedArgs ?? {};
      const cmd = readCommandFromArgs(args);
      if (!cmd) {
        continue;
      }

      const nextArgs: Record<string, unknown> = {
        ...args,
        cmd,
        command: cmd
      };
      const workdir = readWorkdirFromArgs(args);
      if (workdir) {
        nextArgs.workdir = workdir;
      }
      if (Object.prototype.hasOwnProperty.call(nextArgs, 'toon')) {
        delete nextArgs.toon;
      }

      try {
        fn.arguments = JSON.stringify(nextArgs);
      } catch {
        fn.arguments = JSON.stringify({ cmd, command: cmd, ...(workdir ? { workdir } : {}) });
      }
    }
  }
}
