import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { JsonObject, JsonValue, ServerToolHandler, ServerToolHandlerContext, ToolCall } from '../types.js';
import { registerServerToolHandler } from '../registry.js';
import { resolveWorkingDirectoryFromAdapterContextOrFallback } from './memory/cache-writer.js';
import { buildServertoolToolOutputPayloadWithNative, runApplyPatchWithNative } from '../../router/virtual-router/engine-selection/native-chat-process-servertool-orchestration-semantics.js';

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
  return buildServertoolToolOutputPayloadWithNative({
    base,
    toolCallId: toolCall.id,
    toolName: 'apply_patch',
    arguments: stringifyCanonicalArgs(canonicalArgs),
    content: stringifyContent(content),
    stripToolCallName: 'apply_patch'
  }) as JsonObject;
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

function extractFilePathFromNativePatchInput(rawArgs: string): string | undefined {
  try {
    const parsed = JSON.parse(rawArgs);
    const input = typeof parsed?.input === 'string' ? parsed.input : '';
    if (!input) return undefined;
    const match = input.match(/\*\*\*\s+Update\s+File:\s+(.+)$/m)
      || input.match(/\*\*\*\s+Add\s+File:\s+(.+)$/m);
    return match?.[1]?.trim();
  } catch {
    return undefined;
  }
}

function extractCanonicalArgsFromMalformedText(raw: string): CanonicalApplyPatchArgs {
  const text = String(raw || '');
  const filePathMatch = text.match(/"filePath"\s*:\s*"([^"]+)"/i);
  const patchMatch = text.match(/"patch"\s*:\s*"([\s\S]*?)"(?=\s*,\s*"|\s*\}$|\s*,\s*$)/i);
  const decode = (v: string) => v.replace(/\\n/g, '\n').replace(/\\"/g, '"');
  return {
    ...(filePathMatch?.[1] ? { filePath: filePathMatch[1] } : {}),
    ...(patchMatch?.[1] ? { patch: decode(patchMatch[1]) } : {})
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
    const fallbackPath = extractFilePathFromNativePatchInput(
      typeof toolCall.arguments === 'string' ? toolCall.arguments : '{}'
    );
    if (fallbackPath) {
      canonicalArgs.filePath = fallbackPath;
    }
  }
  if ((!canonicalArgs.filePath || canonicalArgs.filePath === ':') && typeof toolCall.arguments === 'string') {
    const repaired = extractCanonicalArgsFromMalformedText(toolCall.arguments);
    if (repaired.filePath) canonicalArgs.filePath = repaired.filePath;
    if (repaired.patch) canonicalArgs.patch = repaired.patch;
  }

  if (!canonicalArgs.filePath) {
    return { payload: fail(undefined, 'PATH_MISSING', 'filePath is required.', `Retry with workspace-relative filePath. Create file: ${JSON.stringify({ filePath: 'tmp/example.txt', patch: '+ hello' })}`), canonicalArgs };
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
  const canonicalToolArgs = JSON.stringify({
    filePath: canonicalArgs.filePath,
    patch: canonicalArgs.patch
  });
  const applyResult = runApplyPatchWithNative({
    toolCallId: toolCall.id,
    toolCallArguments: canonicalToolArgs,
    workspace,
    fileContent: current
  });

  if (!applyResult.ok) {
    const payload = applyResult.payload as unknown as ApplyPatchPayload;
    if (payload.reason === 'FILE_NOT_FOUND') {
      payload.nextAction = `Create file: ${JSON.stringify({ filePath: resolved.relPath, patch: '+ hello' })}; Update existing file: ${JSON.stringify({ filePath: resolved.relPath, patch: '- old\\n+ new' })}`;
    }
    return { payload, canonicalArgs };
  }

  // Phase 5: Write file (I/O)
  try {
    await fsp.mkdir(path.dirname(resolved.absPath), { recursive: true });
    let patchedContent = exists
      ? (applyResult.patchedContent ?? '')
      : String(applyResult.patchedContent ?? '').replace(/^\n/, '');
    if (patchedContent.endsWith('\n\n')) {
      patchedContent = patchedContent.replace(/\n+$/g, '\n');
    }
    await fsp.writeFile(resolved.absPath, patchedContent, 'utf8');
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
