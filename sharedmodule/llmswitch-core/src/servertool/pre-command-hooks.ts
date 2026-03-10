import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ServerToolAutoHookTraceEvent } from './types.js';
import { isPreCommandScriptPathAllowed } from '../router/virtual-router/pre-command-file-resolver.js';

interface PreCommandHookRule {
  id: string;
  toolNames: Set<string>;
  cmdRegex?: RegExp;
  jqExpression?: string;
  shellCommand?: string;
  runtimeScriptPath?: string;
  timeoutMs: number;
  priority: number;
  order: number;
}

interface PreCommandHooksConfig {
  enabled: boolean;
  hooks: PreCommandHookRule[];
}

export interface PreCommandHookRunOptions {
  requestId: string;
  entryEndpoint: string;
  providerProtocol: string;
  toolName: string;
  toolCallId: string;
  toolArguments: string;
  preCommandState?: unknown;
}

export interface PreCommandHookRunResult {
  toolArguments: string;
  changed: boolean;
  traces: ServerToolAutoHookTraceEvent[];
}

const DEFAULT_PRE_COMMAND_HOOKS_FILE = path.join(
  os.homedir(),
  '.routecodex',
  'hooks',
  'pre-command-hooks.json'
);
const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_TOOLS = ['exec_command', 'shell', 'shell_command'];

let cachedConfig: {
  filePath: string;
  mtimeMs: number;
  size: number;
  config: PreCommandHooksConfig;
} | null = null;

export function runPreCommandHooks(options: PreCommandHookRunOptions): PreCommandHookRunResult {
  const runtimeRule = resolveRuntimePreCommandRule(options.preCommandState);
  const config = runtimeRule
    ? { enabled: true, hooks: [runtimeRule] }
    : loadPreCommandHooksConfig();
  if (!config.enabled || config.hooks.length === 0) {
    return {
      toolArguments: options.toolArguments,
      changed: false,
      traces: []
    };
  }

  const traces: ServerToolAutoHookTraceEvent[] = [];
  let changed = false;
  let currentArguments = options.toolArguments;
  let currentParsedArgs = parseToolArgumentsObject(currentArguments);
  let currentCommandText = extractCommandText(currentParsedArgs, currentArguments);
  const normalizedTool = normalizeToolName(options.toolName);

  for (const hook of config.hooks) {
    const traceBase = {
      hookId: hook.id,
      phase: 'pre_command',
      priority: hook.priority,
      queue: 'A_optional' as const,
      queueIndex: 0,
      queueTotal: config.hooks.length
    };

    if (!hook.toolNames.has(normalizedTool)) {
      traces.push({ ...traceBase, result: 'miss', reason: 'tool_mismatch' });
      continue;
    }
    if (hook.cmdRegex && !hook.cmdRegex.test(currentCommandText)) {
      traces.push({ ...traceBase, result: 'miss', reason: 'cmd_regex_mismatch' });
      continue;
    }

    try {
      let matched = false;
      if (hook.runtimeScriptPath && hook.runtimeScriptPath.trim()) {
        const runtimeOutput = runRuntimeScriptHook(
          hook.runtimeScriptPath,
          {
            requestId: options.requestId,
            entryEndpoint: options.entryEndpoint,
            providerProtocol: options.providerProtocol,
            toolName: normalizedTool,
            toolCallId: options.toolCallId,
            arguments: currentParsedArgs ?? { args_raw: currentArguments },
            command: currentCommandText,
            hookId: hook.id
          },
          hook.timeoutMs
        );

        if (typeof runtimeOutput === 'string' && runtimeOutput !== currentArguments) {
          changed = true;
          currentArguments = runtimeOutput;
          currentParsedArgs = parseToolArgumentsObject(currentArguments);
          currentCommandText = extractCommandText(currentParsedArgs, currentArguments);
        }
        matched = true;
      }

      if (hook.jqExpression && hook.jqExpression.trim()) {
        const jqInput = currentParsedArgs ?? { args_raw: currentArguments };
        const transformed = runJqTransform(hook.jqExpression, jqInput, hook.timeoutMs);
        currentParsedArgs = transformed;
        const nextArgs = JSON.stringify(transformed);
        if (nextArgs !== currentArguments) {
          changed = true;
          currentArguments = nextArgs;
          currentCommandText = extractCommandText(currentParsedArgs, currentArguments);
        }
        matched = true;
      }

      if (hook.shellCommand && hook.shellCommand.trim()) {
        runShellCommandHook(
          hook.shellCommand,
          {
            requestId: options.requestId,
            entryEndpoint: options.entryEndpoint,
            providerProtocol: options.providerProtocol,
            toolName: normalizedTool,
            toolCallId: options.toolCallId,
            arguments: currentParsedArgs ?? { args_raw: currentArguments },
            command: currentCommandText,
            hookId: hook.id
          },
          hook.timeoutMs
        );
        matched = true;
      }

      traces.push({
        ...traceBase,
        result: 'match',
        reason: matched ? (changed ? 'applied' : 'matched') : 'no_action'
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? 'unknown_error');
      traces.push({
        ...traceBase,
        result: 'error',
        reason: message
      });
    }
  }

  return {
    toolArguments: currentArguments,
    changed,
    traces
  };
}

export function resetPreCommandHooksCacheForTests(): void {
  cachedConfig = null;
}

function resolveRuntimePreCommandRule(rawState: unknown): PreCommandHookRule | null {
  if (!rawState || typeof rawState !== 'object' || Array.isArray(rawState)) {
    return null;
  }
  const record = rawState as Record<string, unknown>;
  const scriptPath = readString(record.preCommandScriptPath ?? record.scriptPath);
  if (!scriptPath) {
    return null;
  }
  if (!isPreCommandScriptPathAllowed(scriptPath)) {
    return null;
  }

  const timeoutMs = normalizeTimeoutMs(
    record.timeoutMs ?? record.timeout_ms ?? process.env.ROUTECODEX_PRE_COMMAND_TIMEOUT_MS
  );

  return {
    id: `runtime_precommand:${sanitizeHookId(path.basename(scriptPath) || 'script')}`,
    toolNames: new Set(DEFAULT_TOOLS),
    runtimeScriptPath: scriptPath,
    timeoutMs,
    priority: -1000,
    order: -1
  };
}

function resolvePreCommandHooksFilePath(): string {
  const configured =
    process.env.ROUTECODEX_PRE_COMMAND_HOOKS_FILE ||
    process.env.RCC_PRE_COMMAND_HOOKS_FILE ||
    process.env.LLMSWITCH_PRE_COMMAND_HOOKS_FILE;
  if (typeof configured === 'string' && configured.trim()) {
    return path.resolve(configured.trim());
  }
  return DEFAULT_PRE_COMMAND_HOOKS_FILE;
}

function loadPreCommandHooksConfig(): PreCommandHooksConfig {
  const filePath = resolvePreCommandHooksFilePath();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    cachedConfig = {
      filePath,
      mtimeMs: 0,
      size: 0,
      config: { enabled: false, hooks: [] }
    };
    return cachedConfig.config;
  }

  if (
    cachedConfig &&
    cachedConfig.filePath === filePath &&
    cachedConfig.mtimeMs === stat.mtimeMs &&
    cachedConfig.size === stat.size
  ) {
    return cachedConfig.config;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content) as unknown;
    const config = normalizePreCommandHooksConfig(parsed);
    cachedConfig = {
      filePath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      config
    };
    return config;
  } catch {
    cachedConfig = {
      filePath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      config: { enabled: false, hooks: [] }
    };
    return cachedConfig.config;
  }
}

function normalizePreCommandHooksConfig(raw: unknown): PreCommandHooksConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { enabled: false, hooks: [] };
  }
  const record = raw as Record<string, unknown>;
  const enabled = record.enabled !== false;
  if (!enabled) {
    return { enabled: false, hooks: [] };
  }

  const hooksRaw = Array.isArray(record.hooks) ? record.hooks : [];
  const hooks: PreCommandHookRule[] = [];
  for (let idx = 0; idx < hooksRaw.length; idx += 1) {
    const normalized = normalizePreCommandHookRule(hooksRaw[idx], idx);
    if (normalized) {
      hooks.push(normalized);
    }
  }

  hooks.sort((left, right) => {
    if (left.priority !== right.priority) {
      return left.priority - right.priority;
    }
    if (left.order !== right.order) {
      return left.order - right.order;
    }
    return left.id.localeCompare(right.id);
  });

  return {
    enabled: true,
    hooks
  };
}

function normalizePreCommandHookRule(raw: unknown, order: number): PreCommandHookRule | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (record.enabled === false) {
    return null;
  }

  const id = normalizeHookId(record.id, order);
  const toolNames = normalizeToolSet(record.tool ?? record.tools);
  const cmdRegex = parseRegex(record.cmdRegex ?? record.commandRegex ?? record.matchCommand);
  const jqExpression = readString(record.jq ?? record.jqTransform ?? record.expression);
  const shellCommand = readString(record.shell ?? record.command);
  const hasAction = Boolean(jqExpression || shellCommand);
  if (!hasAction) {
    return null;
  }

  const timeoutMs = normalizeTimeoutMs(record.timeoutMs ?? record.timeout_ms);
  const priority = normalizePriority(record.priority);

  return {
    id,
    toolNames,
    cmdRegex,
    jqExpression,
    shellCommand,
    timeoutMs,
    priority,
    order
  };
}

function sanitizeHookId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

function normalizeHookId(value: unknown, order: number): string {
  const text = readString(value);
  if (!text) {
    return `pre_command_hook_${order + 1}`;
  }
  return sanitizeHookId(text);
}

function normalizeToolName(value: string): string {
  return (value || '').trim().toLowerCase();
}

function normalizeToolSet(raw: unknown): Set<string> {
  const out = new Set<string>();
  const push = (value: unknown): void => {
    if (typeof value !== 'string') {
      return;
    }
    const normalized = normalizeToolName(value);
    if (normalized) {
      out.add(normalized);
    }
  };

  if (Array.isArray(raw)) {
    for (const item of raw) {
      push(item);
    }
  } else {
    push(raw);
  }

  if (out.size === 0) {
    for (const tool of DEFAULT_TOOLS) {
      out.add(tool);
    }
  }

  return out;
}

function parseRegex(raw: unknown): RegExp | undefined {
  if (typeof raw !== 'string' || !raw.trim()) {
    return undefined;
  }
  const value = raw.trim();
  const slashMatch = value.match(/^\/(.*)\/([a-z]*)$/i);
  if (slashMatch) {
    const pattern = slashMatch[1];
    const flags = slashMatch[2] || 'i';
    try {
      return new RegExp(pattern, flags);
    } catch {
      return undefined;
    }
  }
  try {
    return new RegExp(value, 'i');
  } catch {
    return undefined;
  }
}

function normalizeTimeoutMs(raw: unknown): number {
  const num = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(num) || num <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.floor(Math.min(num, 30_000));
}

function normalizePriority(raw: unknown): number {
  const num = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(num)) {
    return 100;
  }
  return Math.floor(num);
}

function readString(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

function parseToolArgumentsObject(raw: string): Record<string, unknown> | null {
  if (typeof raw !== 'string' || !raw.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractCommandText(args: Record<string, unknown> | null, rawArgs: string): string {
  if (args && typeof args.cmd === 'string' && args.cmd.trim()) {
    return args.cmd.trim();
  }
  if (args && typeof args.command === 'string' && args.command.trim()) {
    return args.command.trim();
  }
  if (typeof rawArgs === 'string' && rawArgs.trim()) {
    return rawArgs.trim();
  }
  return '';
}

function runJqTransform(
  expression: string,
  input: Record<string, unknown>,
  timeoutMs: number
): Record<string, unknown> {
  const result = spawnSync('jq', ['-c', expression], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024
  });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error('jq_not_found');
    }
    throw new Error(`jq_error:${result.error.message}`);
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    throw new Error(`jq_failed:${stderr || result.status}`);
  }

  const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  if (!stdout) {
    throw new Error('jq_empty_output');
  }
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const payload = lines.length > 0 ? lines[lines.length - 1] : stdout;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error('jq_invalid_json_output');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('jq_non_object_output');
  }
  return parsed as Record<string, unknown>;
}

function runShellCommandHook(command: string, eventPayload: Record<string, unknown>, timeoutMs: number): void {
  const result = spawnSync(command, {
    shell: true,
    timeout: timeoutMs,
    encoding: 'utf8',
    input: JSON.stringify(eventPayload),
    env: {
      ...process.env,
      ROUTECODEX_PRE_COMMAND_HOOK_EVENT: JSON.stringify(eventPayload)
    }
  });

  if (result.error) {
    throw new Error(`shell_hook_error:${result.error.message}`);
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    throw new Error(`shell_hook_failed:${stderr || result.status}`);
  }
}

function runRuntimeScriptHook(
  scriptPath: string,
  eventPayload: Record<string, unknown>,
  timeoutMs: number
): string | undefined {
  const payloadText = JSON.stringify(eventPayload);
  let result = spawnSync(scriptPath, [], {
    timeout: timeoutMs,
    encoding: 'utf8',
    input: payloadText,
    env: {
      ...process.env,
      ROUTECODEX_PRE_COMMAND_HOOK_EVENT: payloadText
    }
  });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if ((code === 'EACCES' || code === 'ENOEXEC') && process.platform !== 'win32') {
      result = spawnSync('/bin/bash', [scriptPath], {
        timeout: timeoutMs,
        encoding: 'utf8',
        input: payloadText,
        env: {
          ...process.env,
          ROUTECODEX_PRE_COMMAND_HOOK_EVENT: payloadText
        }
      });
    }
  }

  if (result.error) {
    throw new Error(`runtime_precommand_error:${result.error.message}`);
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    throw new Error(`runtime_precommand_failed:${stderr || result.status}`);
  }

  const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  if (!stdout) {
    return undefined;
  }
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const payload = lines.length > 0 ? lines[lines.length - 1] : stdout;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    const fallback = payload.replace(/\\"/g, '"').trim();
    const unwrapped =
      fallback.startsWith('"') && fallback.endsWith('"') && fallback.length > 1
        ? fallback.slice(1, -1)
        : fallback;
    try {
      parsed = JSON.parse(unwrapped);
    } catch {
      throw new Error('runtime_precommand_invalid_json:' + payload.slice(0, 200));
    }
  }

  if (typeof parsed === 'string' && parsed.trim()) {
    return parsed;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record.toolArguments === 'string' && record.toolArguments.trim()) {
    return record.toolArguments;
  }
  if (Object.prototype.hasOwnProperty.call(record, 'arguments')) {
    const argValue = record.arguments;
    if (typeof argValue === 'string') {
      return argValue;
    }
    if (argValue && typeof argValue === 'object' && !Array.isArray(argValue)) {
      return JSON.stringify(argValue);
    }
  }

  return JSON.stringify(record);
}
