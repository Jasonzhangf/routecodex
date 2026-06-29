import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { JsonObject } from '../conversion/hub/types/json.js';
import type { ServerToolAutoHookTraceEvent } from './types.js';
import type {
  ServerSideToolEngineOptions,
  ToolCall
} from './types.js';
import {
  planPreCommandHookAttemptWithNative,
  planPreCommandHookCompletionWithNative,
  planPreCommandHookEventPayloadWithNative,
  planPreCommandHooksConfigWithNative,
  parsePreCommandJqStdoutWithNative,
  parsePreCommandRuntimeScriptStdoutWithNative,
  planRuntimePreCommandRuleWithNative,
  type PreCommandHookRulePlan
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import { isPreCommandScriptPathAllowedWithNative } from '../native/router-hotpath/native-virtual-router-routing-instructions-semantics.js';
import { resolveRccPath } from '../runtime/user-data-paths.js';
import { readProviderProtocolFromAnyBoundMetadataCenter } from './metadata-center-carrier.js';

export const SERVERTOOL_PRE_COMMAND_HOOKS_FEATURE_ID = 'feature_id: hub.servertool_pre_command_hooks';

interface PreCommandHooksConfig {
  enabled: boolean;
  hooks: PreCommandHookRulePlan[];
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
  resolveRccPath(),
  'hooks',
  'pre-command-hooks.json'
);

let cachedConfig: {
  filePath: string;
  mtimeMs: number;
  size: number;
  config: PreCommandHooksConfig;
} | null = null;

export function applyPreCommandHooksToToolCall(args: {
  options: ServerSideToolEngineOptions;
  toolCall: ToolCall;
  runtimePreCommandState?: JsonObject;
  bases?: JsonObject[];
  patchToolCallArgumentsById?: (chatResponse: JsonObject, toolCallId: string, argumentsText: string) => void;
}): void {
  const providerProtocol =
    readProviderProtocolFromAnyBoundMetadataCenter(args.options.adapterContext as Record<string, unknown>);
  if (!providerProtocol) {
    throw new Error('Servertool pre-command hooks require metadata center runtime_control.providerProtocol');
  }
  const preHookResult = runPreCommandHooks({
    requestId: args.options.requestId,
    entryEndpoint: args.options.entryEndpoint,
    providerProtocol,
    toolName: args.toolCall.name,
    toolCallId: args.toolCall.id,
    toolArguments: args.toolCall.arguments,
    preCommandState: args.runtimePreCommandState
  });
  for (const trace of preHookResult.traces) {
    args.options.onAutoHookTrace?.(trace);
  }
  if (!preHookResult.changed || preHookResult.toolArguments === args.toolCall.arguments) {
    return;
  }
  args.toolCall.arguments = preHookResult.toolArguments;
  if (!args.bases?.length || !args.patchToolCallArgumentsById) {
    return;
  }
  for (const base of args.bases) {
    args.patchToolCallArgumentsById(base, args.toolCall.id, preHookResult.toolArguments);
  }
}

export function applyPreCommandHooksToToolCalls(args: {
  options: ServerSideToolEngineOptions;
  toolCalls: ToolCall[];
  runtimePreCommandState?: JsonObject;
  bases: JsonObject[];
  patchToolCallArgumentsById: (chatResponse: JsonObject, toolCallId: string, argumentsText: string) => void;
}): void {
  for (const toolCall of args.toolCalls) {
    applyPreCommandHooksToToolCall({
      options: args.options,
      toolCall,
      runtimePreCommandState: args.runtimePreCommandState,
      bases: args.bases,
      patchToolCallArgumentsById: args.patchToolCallArgumentsById
    });
  }
}

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
  for (const [index, hook] of config.hooks.entries()) {
    const attemptPlan = planPreCommandHookAttemptWithNative({
      hook,
      requestId: options.requestId,
      entryEndpoint: options.entryEndpoint,
      providerProtocol: options.providerProtocol,
      toolName: options.toolName,
      toolCallId: options.toolCallId,
      toolArguments: currentArguments,
      queueIndex: index,
      queueTotal: config.hooks.length
    });
    if (attemptPlan.action === 'skip') {
      traces.push(attemptPlan.traceEvent as ServerToolAutoHookTraceEvent);
      continue;
    }
    const execution = attemptPlan.execution;
    if (!execution) {
      throw new Error('pre_command_hook_execute_missing_plan');
    }

    try {
      let matched = false;
      let hookChanged = false;
      const eventPlan = () => planPreCommandHookEventPayloadWithNative({
        requestId: options.requestId,
        entryEndpoint: options.entryEndpoint,
        providerProtocol: options.providerProtocol,
        toolName: options.toolName,
        toolCallId: options.toolCallId,
        toolArguments: currentArguments,
        hookId: execution.hookId
      });
      if (execution.runtimeScriptPath) {
        const payloadPlan = eventPlan();
        const runtimeOutput = runRuntimeScriptHook(
          execution.runtimeScriptPath,
          payloadPlan.eventPayload,
          execution.timeoutMs
        );

        if (typeof runtimeOutput === 'string' && runtimeOutput !== currentArguments) {
          changed = true;
          hookChanged = true;
          currentArguments = runtimeOutput;
        }
        matched = true;
      }

      if (execution.jqExpression) {
        const transformed = runJqTransform(execution.jqExpression, eventPlan().jqInput, execution.timeoutMs);
        const nextArgs = JSON.stringify(transformed);
        if (nextArgs !== currentArguments) {
          changed = true;
          hookChanged = true;
          currentArguments = nextArgs;
        }
        matched = true;
      }

      if (execution.shellCommand) {
        const payloadPlan = eventPlan();
        runShellCommandHook(
          execution.shellCommand,
          payloadPlan.eventPayload,
          execution.timeoutMs
        );
        matched = true;
      }

      traces.push(
        planPreCommandHookCompletionWithNative({
          hookId: execution.hookId,
          priority: hook.priority,
          queueIndex: index,
          queueTotal: config.hooks.length,
          matched,
          changed: hookChanged
        }).traceEvent as ServerToolAutoHookTraceEvent
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? 'unknown_error');
      const completionPlan = planPreCommandHookCompletionWithNative({
        hookId: execution.hookId,
        priority: hook.priority,
        queueIndex: index,
        queueTotal: config.hooks.length,
        matched: true,
        changed: false,
        errorMessage: message
      });
      traces.push(completionPlan.traceEvent as ServerToolAutoHookTraceEvent);
      if (completionPlan.action === 'fail_fast') {
        throw error;
      }
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

function resolveRuntimePreCommandRule(rawState: unknown): PreCommandHookRulePlan | null {
  if (!rawState || typeof rawState !== 'object' || Array.isArray(rawState)) {
    return null;
  }
  const record = rawState as Record<string, unknown>;
  const scriptPath = readString(record.preCommandScriptPath ?? record.scriptPath);
  if (!scriptPath) {
    return null;
  }
  const plan = planRuntimePreCommandRuleWithNative({
    rawState,
    envTimeoutMs: process.env.ROUTECODEX_PRE_COMMAND_TIMEOUT_MS,
    scriptPathAllowed: isPreCommandScriptPathAllowedWithNative(scriptPath)
  });
  return plan;
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
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw new Error(`[servertool-pre-command] config stat failed file=${filePath} reason=${errorMessage(error)}`);
    }
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
  } catch (error) {
    throw new Error(`[servertool-pre-command] config load failed file=${filePath} reason=${errorMessage(error)}`);
  }
}

function normalizePreCommandHooksConfig(raw: unknown): PreCommandHooksConfig {
  const plan = planPreCommandHooksConfigWithNative(raw);
  return {
    enabled: plan.enabled,
    hooks: plan.hooks
  };
}

function readString(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

function isMissingFileError(error: unknown): boolean {
  return typeof (error as { code?: unknown } | null)?.code === 'string'
    && (error as { code: string }).code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'unknown_error');
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

  return parsePreCommandJqStdoutWithNative({
    stdout: typeof result.stdout === 'string' ? result.stdout : ''
  });
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

  const parsePlan = parsePreCommandRuntimeScriptStdoutWithNative({
    stdout: typeof result.stdout === 'string' ? result.stdout : ''
  });
  return parsePlan.action === 'replace_arguments' ? parsePlan.toolArguments : undefined;
}
