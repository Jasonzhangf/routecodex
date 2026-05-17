import type { JsonObject } from '../../conversion/hub/types/json.js';
import type { ServerToolHandler, ServerToolHandlerContext, ServerToolHandlerPlan, ToolCall } from '../types.js';
import { registerServerToolHandler } from '../registry.js';
import { cloneJson } from '../server-side-tools.js';
import { appendToolOutput as coreAppendToolOutput } from '../orchestration-blocks.js';

const TOOL_NAME = 'apply_patch';
const FLOW_ID = 'apply_patch_read_before_retry_guard';
const ERROR_CODE = 'APPLY_PATCH_REQUIRES_READ_BEFORE_RETRY';

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readToolCallName(node: Record<string, unknown>): string {
  const direct = typeof node.name === 'string' ? node.name.trim() : '';
  if (direct) {
    return direct.toLowerCase();
  }
  const fn =
    node.function && typeof node.function === 'object' && !Array.isArray(node.function)
      ? (node.function as Record<string, unknown>)
      : undefined;
  return typeof fn?.name === 'string' ? fn.name.trim().toLowerCase() : '';
}

function readToolCallArguments(node: Record<string, unknown>): string {
  const direct = typeof node.arguments === 'string' ? node.arguments : '';
  if (direct) {
    return direct;
  }
  const fn =
    node.function && typeof node.function === 'object' && !Array.isArray(node.function)
      ? (node.function as Record<string, unknown>)
      : undefined;
  return typeof fn?.arguments === 'string' ? fn.arguments : '';
}

function extractCommandFromToolCall(node: Record<string, unknown>): string {
  const name = readToolCallName(node);
  if (!['exec_command', 'shell', 'shell_command', 'bash'].includes(name)) {
    return '';
  }
  const args = parseJsonObject(readToolCallArguments(node));
  if (!args) {
    return '';
  }
  if (typeof args.cmd === 'string' && args.cmd.trim()) {
    return args.cmd.trim();
  }
  if (typeof args.command === 'string' && args.command.trim()) {
    return args.command.trim();
  }
  if (Array.isArray(args.command)) {
    return args.command.map((entry) => String(entry ?? '')).join(' ').trim();
  }
  return '';
}

function looksLikeReadCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes('nl -ba ') ||
    normalized.includes('sed -n ') ||
    normalized.includes('cat ') ||
    normalized.includes('head ') ||
    normalized.includes('tail ') ||
    normalized.includes('rg ') ||
    normalized.includes('awk ') ||
    normalized.includes('python ')
  );
}

function hasRecentApplyPatchFailureWithoutRead(ctx: ServerToolHandlerContext): boolean {
  const captured =
    ctx.adapterContext && typeof ctx.adapterContext === 'object'
      ? ((ctx.adapterContext as Record<string, unknown>).capturedChatRequest as unknown)
      : undefined;
  const messages = Array.isArray((captured as { messages?: unknown[] } | undefined)?.messages)
    ? ((captured as { messages: unknown[] }).messages ?? [])
    : [];
  let failureSeen = false;
  for (const message of messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      continue;
    }
    const row = message as Record<string, unknown>;
    const role = typeof row.role === 'string' ? row.role.trim().toLowerCase() : '';
    if (role === 'tool') {
      const name = typeof row.name === 'string' ? row.name.trim().toLowerCase() : '';
      const content = typeof row.content === 'string' ? row.content.toLowerCase() : '';
      if (name === TOOL_NAME && content.includes('apply_patch verification failed')) {
        failureSeen = true;
        continue;
      }
    }
    if (!failureSeen) {
      continue;
    }
    const toolCalls = Array.isArray(row.tool_calls) ? (row.tool_calls as unknown[]) : [];
    for (const toolCall of toolCalls) {
      if (!toolCall || typeof toolCall !== 'object' || Array.isArray(toolCall)) {
        continue;
      }
      const command = extractCommandFromToolCall(toolCall as Record<string, unknown>);
      if (looksLikeReadCommand(command)) {
        return false;
      }
    }
  }
  if (failureSeen) {
    return true;
  }
  try {
    const serialized = JSON.stringify(captured ?? {});
    const failureIdx = serialized.toLowerCase().lastIndexOf('apply_patch verification failed');
    if (failureIdx < 0) {
      return false;
    }
    const tail = serialized.slice(failureIdx).toLowerCase();
    if (
      tail.includes('nl -ba ') ||
      tail.includes('sed -n ') ||
      tail.includes('cat ') ||
      tail.includes('head ') ||
      tail.includes('tail ') ||
      tail.includes('rg ') ||
      tail.includes('awk ') ||
      tail.includes('python ')
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function appendToolOutput(base: JsonObject, toolCall: ToolCall, content: Record<string, unknown>): JsonObject {
  const cloned = cloneJson(base) as JsonObject;
  coreAppendToolOutput(cloned, toolCall.id, TOOL_NAME, JSON.stringify(content));
  return cloned;
}

const handler: ServerToolHandler = async (ctx: ServerToolHandlerContext): Promise<ServerToolHandlerPlan | null> => {
  const toolCall = ctx.toolCall;
  if (!toolCall || toolCall.name !== TOOL_NAME) {
    return null;
  }
  if (!hasRecentApplyPatchFailureWithoutRead(ctx)) {
    return null;
  }
  return {
    flowId: FLOW_ID,
    finalize: async () => ({
      chatResponse: appendToolOutput(ctx.base, toolCall, {
        ok: false,
        code: ERROR_CODE,
        message:
          'A previous apply_patch failed and no file-read step was observed afterwards. Before retrying apply_patch, first read the latest target file content (for example with `nl -ba <file>`), then rebuild a smaller patch from the real current file.'
      }),
      execution: {
        flowId: FLOW_ID,
        followup: {
          requestIdSuffix: ':apply_patch_read_before_retry',
          entryEndpoint: ctx.entryEndpoint,
          injection: {
            ops: [
              { op: 'preserve_tools' },
              { op: 'append_tool_messages_from_tool_outputs', required: true },
              {
                op: 'inject_system_text',
                text:
                  'MANDATORY NEXT ACTION: the previous apply_patch failed and no file-read step was observed afterwards. Before any new apply_patch, first use exec_command to read the exact latest file content for the target path (for example `nl -ba <file>`), then rebuild a smaller patch from that real content. Keep the existing tool list unchanged.'
              }
            ]
          },
          metadata: {
            clientInjectSource: 'servertool.apply_patch_read_before_retry'
          }
        }
      }
    })
  };
};

registerServerToolHandler(TOOL_NAME, handler);
