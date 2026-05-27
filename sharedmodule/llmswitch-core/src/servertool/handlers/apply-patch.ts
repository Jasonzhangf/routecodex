import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { JsonObject, JsonValue, ServerToolHandler, ServerToolHandlerContext, ToolCall } from '../types.js';
import { registerServerToolHandler } from '../registry.js';
import { resolveWorkingDirectoryFromAdapterContextOrFallback } from './memory/cache-writer.js';

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

function readRawToolArguments(toolCall: ToolCall): string {
  return typeof toolCall.arguments === 'string' ? toolCall.arguments : '{}';
}

function parseJsonStringLiteral(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
}

function readRawStringField(raw: string, names: string[]): string | undefined {
  for (const name of names) {
    const pattern = new RegExp(`"${name}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 's');
    const match = raw.match(pattern);
    if (match?.[1] !== undefined) {
      const value = parseJsonStringLiteral(match[1]);
      if (value.trim()) return value;
    }
  }
  return undefined;
}

function recoverToolArgumentsFromRaw(raw: string): Record<string, unknown> {
  const recovered: Record<string, unknown> = {};
  const filePath = readRawStringField(raw, ['filePath', 'file_path', 'path']);
  const patch = readRawStringField(raw, ['patch', 'input', 'diff', 'changes']);
  if (filePath !== undefined) recovered.filePath = filePath;
  if (patch !== undefined) recovered.patch = patch;
  return recovered;
}

function parseToolArguments(toolCall: ToolCall): Record<string, unknown> {
  const raw = readRawToolArguments(toolCall);
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return recoverToolArgumentsFromRaw(raw);
  }
}

function stringifyContent(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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

function applyPatchUsageGuide(filePath = 'tmp/example.txt'): string {
  const safePath = filePath && filePath.trim() ? filePath.trim() : 'tmp/example.txt';
  return [
    `Call apply_patch again with JSON only: {"filePath":"${safePath}","patch":"+ hello"}`,
    'Create file: {"filePath":"tmp/new.txt","patch":"+ first line\\n+ second line"}',
    'Append to existing file: {"filePath":"tmp/existing.txt","patch":"+ appended line"}',
    'Update existing file: {"filePath":"src/main.ts","patch":"- exact old line\\n+ replacement line"}',
    'Use apply_patch itself for the next file edit.'
  ].join(' ');
}

function resolveSafeTargetPath(workspace: string, filePath: string): { ok: true; absPath: string; relPath: string } | { ok: false; payload: ApplyPatchPayload } {
  const rel = filePath.trim();
  if (!rel) {
    return { ok: false, payload: fail(undefined, 'PATH_MISSING', 'filePath is required.', `Retry with workspace-relative filePath. ${applyPatchUsageGuide()}`) };
  }
  if (path.isAbsolute(rel)) {
    return { ok: false, payload: fail(rel, 'PATH_ABSOLUTE', 'Absolute filePath is not allowed.', `Retry with a workspace-relative filePath. ${applyPatchUsageGuide(path.basename(rel))}`) };
  }
  const root = path.resolve(workspace);
  const absPath = path.resolve(root, rel);
  const relative = path.relative(root, absPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, payload: fail(rel, 'PATH_OUTSIDE_WORKSPACE', 'filePath resolves outside workspace.', `Retry with a path inside the workspace. ${applyPatchUsageGuide(path.basename(rel))}`) };
  }
  return { ok: true, absPath, relPath: relative || path.basename(absPath) };
}

type LineEditHunk = { remove: string[]; add: string[] };

function parseLineEditPatch(raw: string): { ok: true; hunks: LineEditHunk[]; removed: number; added: number } | { ok: false; reason: string; message: string } {
  const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = text.split('\n').filter((line, index, arr) => !(index === arr.length - 1 && line === ''));
  if (!rows.length) {
    return { ok: false, reason: 'PATCH_EMPTY', message: 'patch is empty.' };
  }
  const hunks: LineEditHunk[] = [];
  let current: LineEditHunk = { remove: [], add: [] };
  let removed = 0;
  let added = 0;
  const flush = (): void => {
    if (current.remove.length || current.add.length) {
      hunks.push(current);
      current = { remove: [], add: [] };
    }
  };
  for (const line of rows) {
    if (line.startsWith('- ')) {
      if (current.add.length > 0) flush();
      current.remove.push(line.slice(2));
      removed += 1;
      continue;
    }
    if (line.startsWith('+ ')) {
      current.add.push(line.slice(2));
      added += 1;
      continue;
    }
    if (line === '-') {
      if (current.add.length > 0) flush();
      current.remove.push('');
      removed += 1;
      continue;
    }
    if (line === '+') {
      current.add.push('');
      added += 1;
      continue;
    }
    return {
      ok: false,
      reason: 'PATCH_INVALID',
      message: 'patch must contain only line-edit entries beginning with "- " or "+ ".'
    };
  }
  flush();
  if (removed === 0 && added === 0) {
    return { ok: false, reason: 'PATCH_EMPTY', message: 'patch has no edit entries.' };
  }
  return { ok: true, hunks, removed, added };
}

function splitContentLines(content: string): string[] {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = normalized.split('\n');
  if (rows.length > 0 && rows[rows.length - 1] === '') {
    rows.pop();
  }
  return rows;
}

function preserveTrailingNewline(original: string, lines: string[]): string {
  const body = lines.join('\n');
  return original.length === 0 || original.endsWith('\n') ? `${body}\n` : body;
}

function findSubsequence(source: string[], needle: string[]): number {
  if (!needle.length) return source.length;
  outer: for (let start = 0; start <= source.length - needle.length; start += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (source[start + offset] !== needle[offset]) {
        continue outer;
      }
    }
    return start;
  }
  return -1;
}

function applyLineEditPatch(targetContent: string, hunks: LineEditHunk[]): { ok: true; content: string } | { ok: false; reason: string; message: string } {
  const lines = splitContentLines(targetContent);
  for (const hunk of hunks) {
    if (!hunk.remove.length) {
      lines.push(...hunk.add);
      continue;
    }
    const index = findSubsequence(lines, hunk.remove);
    if (index < 0) {
      return { ok: false, reason: 'PATCH_CONTEXT_NOT_FOUND', message: 'Removed line sequence was not found in target file.' };
    }
    lines.splice(index, hunk.remove.length, ...hunk.add);
  }
  return { ok: true, content: preserveTrailingNewline(targetContent, lines) };
}

function isApplyPatchFailureResult(payload: ApplyPatchPayload): payload is Extract<ApplyPatchPayload, { ok: false }> {
  return payload.ok === false;
}

function isSafeTargetPathFailureResult(
  result: { ok: true; absPath: string; relPath: string } | { ok: false; payload: ApplyPatchPayload }
): result is { ok: false; payload: ApplyPatchPayload } {
  return result.ok === false;
}

function isParseLineEditFailureResult(
  result: { ok: true; hunks: LineEditHunk[]; removed: number; added: number } | { ok: false; reason: string; message: string }
): result is { ok: false; reason: string; message: string } {
  return result.ok === false;
}

function isApplyLineEditFailureResult(
  result: { ok: true; content: string } | { ok: false; reason: string; message: string }
): result is { ok: false; reason: string; message: string } {
  return result.ok === false;
}


function readPatchText(args: Record<string, unknown>): string {
  const candidates = [args.patch, args.input, args.diff, args.changes];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return '';
}

function stripOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('`') && trimmed.endsWith('`'))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function resolvePatchFilePath(args: Record<string, unknown>, rawPatch: string): string {
  const direct = typeof args.filePath === 'string'
    ? args.filePath
    : typeof args.file_path === 'string'
      ? args.file_path
      : typeof args.path === 'string'
        ? args.path
        : '';
  if (direct.trim()) {
    return stripOuterQuotes(direct);
  }
  const text = rawPatch.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const patterns = [
    /^\*\*\*\s+(?:Add|Update|Delete) File:\s+(.+)$/mi,
    /^---\s+(?:a\/)?(.+)$/mi,
    /^\+\+\+\s+(?:b\/)?(.+)$/mi
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const captured = match?.[1];
    if (captured) {
      const value = stripOuterQuotes(captured);
      if (value && value !== '/dev/null') {
        return value;
      }
    }
  }
  return '';
}

function normalizeWorkspaceRelativePath(workspace: string, filePath: string): string {
  const raw = stripOuterQuotes(filePath);
  if (!path.isAbsolute(raw)) {
    return raw;
  }
  const root = path.resolve(workspace);
  const relative = path.relative(root, path.resolve(raw));
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative;
  }
  return raw;
}

function normalizePatchLine(raw: string): string {
  if (raw.startsWith('+') && !raw.startsWith('+++')) {
    return raw === '+' || raw.startsWith('+ ') ? raw : `+ ${raw.slice(1)}`;
  }
  if (raw.startsWith('-') && !raw.startsWith('---')) {
    return raw === '-' || raw.startsWith('- ') ? raw : `- ${raw.slice(1)}`;
  }
  return raw;
}

function extractFencedPatchText(text: string): string | null {
  const fence = text.match(/```(?:diff|patch|text)?\s*\n([\s\S]*?)\n```/i);
  if (!fence?.[1]) {
    return null;
  }
  return fence[1];
}

function normalizeLineEditBlock(text: string): { ok: true; patch: string } | { ok: false } {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').map(normalizePatchLine);
  const rows = normalized.filter((line) => line.trim().length > 0);
  const allLineEdit = rows.length > 0 && rows.every((line) =>
    line === '+' || line === '-' || line.startsWith('+ ') || line.startsWith('- ')
  );
  return allLineEdit ? { ok: true, patch: normalized.join('\n') } : { ok: false };
}

function convertNativePatchToLineEdit(rawPatch: string, targetPath: string): string {
  const text = rawPatch.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!text.includes('*** Begin Patch')) {
    const direct = normalizeLineEditBlock(text);
    if (direct.ok) {
      return direct.patch;
    }
    const fenced = extractFencedPatchText(text);
    if (fenced !== null) {
      const fencedLineEdit = normalizeLineEditBlock(fenced);
      if (fencedLineEdit.ok) {
        return fencedLineEdit.patch;
      }
    }
    return text.split('\n').map(normalizePatchLine).join('\n');
  }
  const lines = text.split('\n');
  const out: string[] = [];
  let active = false;
  let selected = !targetPath.trim();
  for (const line of lines) {
    const header = line.match(/^\*\*\*\s+(?:Add|Update|Delete) File:\s+(.+)$/);
    if (header) {
      active = true;
      const headerPath = stripOuterQuotes(header[1] || '');
      selected = !targetPath.trim() || headerPath === targetPath || headerPath.endsWith(`/${targetPath}`);
      continue;
    }
    if (!active) continue;
    if (line.startsWith('*** End Patch')) break;
    if (line.startsWith('*** ')) {
      active = false;
      selected = false;
      continue;
    }
    if (!selected) continue;
    if (line.startsWith('@@')) continue;
    if (line.startsWith(' ')) {
      continue;
    }
    if ((line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---'))) {
      out.push(normalizePatchLine(line));
    }
  }
  return out.join('\n');
}

async function executeApplyPatch(ctx: ServerToolHandlerContext, toolCall: ToolCall): Promise<ApplyPatchExecutionResult> {
  const args = parseToolArguments(toolCall);
  const rawPatch = readPatchText(args);
  const canonicalArgs: CanonicalApplyPatchArgs = { patch: rawPatch };
  const workspace = resolveWorkingDirectoryFromAdapterContextOrFallback(ctx.adapterContext as Record<string, unknown>);
  if (!workspace) {
    return { payload: fail(undefined, 'WORKSPACE_MISSING', 'No workspace cwd is available for apply_patch servertool.', 'Retry after providing cwd metadata.'), canonicalArgs };
  }
  const filePath = normalizeWorkspaceRelativePath(workspace, resolvePatchFilePath(args, rawPatch));
  canonicalArgs.filePath = filePath;
  const resolved = resolveSafeTargetPath(workspace, filePath);
  if (isSafeTargetPathFailureResult(resolved)) {
    return { payload: resolved.payload, canonicalArgs };
  }
  const patch = convertNativePatchToLineEdit(rawPatch, resolved.relPath);
  canonicalArgs.filePath = resolved.relPath;
  canonicalArgs.patch = patch;
  if (!patch.trim()) {
    return { payload: fail(resolved.relPath, 'PATCH_EMPTY', 'patch is required.', `Retry with minimal line-edit patch entries. ${applyPatchUsageGuide(resolved.relPath)}`), canonicalArgs };
  }

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
  const parsed = parseLineEditPatch(patch);
  if (isParseLineEditFailureResult(parsed)) {
    return { payload: fail(resolved.relPath, parsed.reason, parsed.message, `Retry with only line-edit entries. ${applyPatchUsageGuide(resolved.relPath)}`), canonicalArgs };
  }
  if (!exists && parsed.hunks.some((hunk) => hunk.remove.length > 0)) {
    return { payload: fail(resolved.relPath, 'FILE_NOT_FOUND', 'Target file does not exist for a removal/update patch.', applyPatchUsageGuide(resolved.relPath)), canonicalArgs };
  }
  const applied = applyLineEditPatch(current, parsed.hunks);
  if (isApplyLineEditFailureResult(applied)) {
    return { payload: fail(resolved.relPath, applied.reason, applied.message, `Retry with line-edit patch entries that match the current target file. ${applyPatchUsageGuide(resolved.relPath)}`), canonicalArgs };
  }
  try {
    await fsp.mkdir(path.dirname(resolved.absPath), { recursive: true });
    await fsp.writeFile(resolved.absPath, applied.content, 'utf8');
  } catch (error) {
    return { payload: fail(resolved.relPath, 'IO_ERROR', String((error as Error)?.message || error), 'Fix filesystem error and retry.'), canonicalArgs };
  }
  return {
    payload: {
      status: 'APPLY_PATCH_APPLIED',
      ok: true,
      filePath: resolved.relPath,
      summary: `Replaced ${parsed.removed} removed line(s) with ${parsed.added} added line(s).`
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
