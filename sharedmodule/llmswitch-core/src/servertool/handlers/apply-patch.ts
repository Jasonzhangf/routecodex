import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { JsonObject, JsonValue, ServerToolHandler, ServerToolHandlerContext, ToolCall } from '../types.js';
import { registerServerToolHandler } from '../registry.js';
import { resolveWorkingDirectoryFromAdapterContextOrFallback } from './memory/cache-writer.js';
import { runApplyPatchWithNative } from '../../router/virtual-router/engine-selection/native-chat-process-servertool-orchestration-semantics.js';

const FLOW_ID = 'apply_patch_flow';

type ApplyPatchPayload = {
  status: 'APPLY_PATCH_APPLIED' | 'APPLY_PATCH_FAILED';
  ok: boolean;
  filePath?: string;
  reason?: string;
  message?: string;
  nextAction?: string;
  summary?: string;
};

type CanonicalApplyPatchArgs = {
  filePath?: string;
  patch?: string;
};

type ApplyPatchExecutionResult = {
  payload: ApplyPatchPayload;
  canonicalArgs: CanonicalApplyPatchArgs;
};

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stringifyContent(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function stringifyCanonicalArgs(canonicalArgs: CanonicalApplyPatchArgs): string {
  return JSON.stringify({
    filePath: canonicalArgs.filePath ?? '',
    patch: canonicalArgs.patch ?? ''
  });
}

function injectApplyPatchToolOutput(base: JsonObject, toolCall: ToolCall, canonicalArgs: CanonicalApplyPatchArgs, content: ApplyPatchPayload): JsonObject {
  const cloned = cloneJson(base);
  const existingOutputs = Array.isArray((cloned as { tool_outputs?: unknown }).tool_outputs)
    ? ((cloned as { tool_outputs: JsonValue[] }).tool_outputs as JsonValue[])
    : [];
  (cloned as Record<string, unknown>).tool_outputs = [
    ...existingOutputs,
    {
      tool_call_id: toolCall.id,
      name: 'apply_patch',
      arguments: stringifyCanonicalArgs(canonicalArgs),
      content: stringifyContent(content)
    }
  ];
  stripApplyPatchToolCall(cloned, toolCall.id);
  return cloned;
}

function stripApplyPatchToolCall(base: JsonObject, toolCallId: string): void {
  const choices = Array.isArray((base as { choices?: unknown }).choices)
    ? ((base as { choices: unknown[] }).choices as unknown[])
    : [];
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object' || Array.isArray(choice)) continue;
    const choiceRow = choice as Record<string, unknown>;
    const message = choiceRow.message;
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
    const messageRow = message as Record<string, unknown>;
    const calls = Array.isArray(messageRow.tool_calls) ? messageRow.tool_calls as unknown[] : [];
    if (!calls.length) continue;
    const kept = calls.filter((call) => {
      if (!call || typeof call !== 'object' || Array.isArray(call)) return true;
      const row = call as Record<string, unknown>;
      const id = typeof row.id === 'string' ? row.id : typeof row.call_id === 'string' ? row.call_id : '';
      if (id !== toolCallId) return true;
      const fn = row.function;
      const name = fn && typeof fn === 'object' && !Array.isArray(fn)
        ? (fn as Record<string, unknown>).name
        : row.name;
      return name !== 'apply_patch';
    });
    if (kept.length) {
      messageRow.tool_calls = kept as JsonValue[];
    } else {
      delete messageRow.tool_calls;
    }
  }
}

function resolveSafeTargetPath(workspace: string, filePath: string): { ok: true; absPath: string; relPath: string } | { ok: false; payload: ApplyPatchPayload } {
  const rel = filePath.trim();
  if (!rel) {
    return { ok: false, payload: fail(undefined, 'PATH_MISSING', 'filePath is required.', 'Retry with workspace-relative filePath.') };
  }
  if (path.isAbsolute(rel)) {
    return { ok: false, payload: fail(rel, 'PATH_ABSOLUTE', 'Absolute filePath is not allowed.', 'Retry with a workspace-relative filePath.') };
  }
  const root = path.resolve(workspace);
  const absPath = path.resolve(root, rel);
  const relative = path.relative(root, absPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, payload: fail(rel, 'PATH_OUTSIDE_WORKSPACE', 'filePath resolves outside workspace.', 'Retry with a path inside the workspace.') };
  }
  return { ok: true, absPath, relPath: relative || path.basename(absPath) };
}

function fail(filePath: string | undefined, reason: string, message: string, nextAction: string): ApplyPatchPayload {
  return {
    status: 'APPLY_PATCH_FAILED',
    ok: false,
    ...(filePath ? { filePath } : {}),
    reason,
    message,
    nextAction
  };
}

async function executeApplyPatch(ctx: ServerToolHandlerContext, toolCall: ToolCall): Promise<ApplyPatchExecutionResult> {
  const workspace = resolveWorkingDirectoryFromAdapterContextOrFallback(ctx.adapterContext as Record<string, unknown>);
  if (!workspace) {
    return { payload: fail(undefined, 'WORKSPACE_MISSING', 'No workspace cwd is available.', 'Retry after providing cwd metadata.'), canonicalArgs: {} };
  }

  // Phase 1: Native parse + normalize (pure logic)
  const nativeResult = runApplyPatchWithNative({
    toolCallId: toolCall.id,
    toolCallArguments: typeof toolCall.arguments === 'string' ? toolCall.arguments : '{}',
    workspace
  });

  const canonicalArgs: CanonicalApplyPatchArgs = {
    filePath: String(nativeResult.canonicalArgs?.filePath ?? ''),
    patch: String(nativeResult.canonicalArgs?.patch ?? '')
  };

  if (!canonicalArgs.filePath) {
    return { payload: fail(undefined, 'PATH_MISSING', 'filePath is required.', 'Retry with workspace-relative filePath.'), canonicalArgs };
  }

  // Phase 2: TS path safety check
  const resolved = resolveSafeTargetPath(workspace, canonicalArgs.filePath);
  if (!resolved.ok) {
    return { payload: (resolved as { payload: ApplyPatchPayload }).payload, canonicalArgs };
  }

  if (!canonicalArgs.patch?.trim()) {
    return { payload: fail(resolved.relPath, 'PATCH_EMPTY', 'patch is required.', `Retry with line-edit patch entries.`), canonicalArgs };
  }

  // Phase 3: File I/O
  let current = '';
  let exists = true;
  try {
    current = await fsp.readFile(resolved.absPath, 'utf8');
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code !== 'ENOENT') {
      return { payload: fail(resolved.relPath, 'IO_ERROR', String((error as Error)?.message || error), 'Retry with a valid filePath.'), canonicalArgs };
    }
    exists = false;
    current = '';
  }

  // Phase 4: Native apply patch (pure logic)
  const applyResult = runApplyPatchWithNative({
    toolCallId: toolCall.id,
    toolCallArguments: typeof toolCall.arguments === 'string' ? toolCall.arguments : '{}',
    workspace,
    fileContent: current
  });

  if (!applyResult.ok) {
    return { payload: applyResult.payload as unknown as ApplyPatchPayload, canonicalArgs };
  }

  // Phase 5: Write file (I/O)
  try {
    await fsp.mkdir(path.dirname(resolved.absPath), { recursive: true });
    await fsp.writeFile(resolved.absPath, applyResult.patchedContent ?? '', 'utf8');
  } catch (error) {
    return { payload: fail(resolved.relPath, 'IO_ERROR', String((error as Error)?.message || error), 'Fix filesystem error and retry.'), canonicalArgs };
  }

  return {
    payload: {
      status: 'APPLY_PATCH_APPLIED',
      ok: true,
      filePath: resolved.relPath,
      summary: String(applyResult.payload?.summary ?? 'Patch applied.')
    },
    canonicalArgs
  };
}

const handler: ServerToolHandler = async (ctx: ServerToolHandlerContext) => {
  const toolCall = ctx.toolCall;
  if (!toolCall || toolCall.name !== 'apply_patch') {
    return null;
  }
  return {
    flowId: FLOW_ID,
    finalize: async () => {
      const { payload, canonicalArgs } = await executeApplyPatch(ctx, toolCall);
      const patched = injectApplyPatchToolOutput(ctx.base, toolCall, canonicalArgs, payload);
      return {
        chatResponse: patched,
        execution: {
          flowId: FLOW_ID,
          followup: {
            requestIdSuffix: ':apply_patch_followup',
            entryEndpoint: ctx.entryEndpoint,
            injection: {
              ops: [
                { op: 'append_tool_messages_from_tool_outputs', required: true }
              ]
            }
          }
        }
      };
    }
  };
};

registerServerToolHandler('apply_patch', handler);
