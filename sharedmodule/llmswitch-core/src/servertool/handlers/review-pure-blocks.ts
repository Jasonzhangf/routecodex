import type { JsonObject } from '../../conversion/hub/types/json.js';
import type { ToolCall } from '../types.js';
import { sanitizeFollowupText } from './followup-sanitize.js';
import { cloneJson } from '../server-side-tools.js';
import { dropToolByFunctionName, type CapturedChatSeed } from '../followup-seed.js';

export interface ReviewToolArgs {
  goal?: string;
  focus?: string;
  cwd?: string;
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = sanitizeFollowupText(value);
  return trimmed || undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseReviewToolArguments(toolCall: ToolCall): ReviewToolArgs {
  const raw = typeof toolCall.arguments === 'string' ? toolCall.arguments.trim() : '';
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      ...(readTrimmedString(parsed.goal) ? { goal: readTrimmedString(parsed.goal) } : {}),
      ...(readTrimmedString(parsed.focus) ? { focus: readTrimmedString(parsed.focus) } : {}),
      ...(readTrimmedString(parsed.cwd ?? parsed.workdir ?? parsed.workingDirectory)
        ? { cwd: readTrimmedString(parsed.cwd ?? parsed.workdir ?? parsed.workingDirectory) }
        : {})
    };
  } catch {
    return {};
  }
}

function readWorkingDirectoryFromRecord(record: Record<string, unknown> | undefined): string | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of ['cwd', 'workdir', 'workingDirectory', 'clientWorkdir']) {
    const value = readTrimmedString(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function resolveReviewWorkingDirectory(args: ReviewToolArgs, adapterContext: unknown): string | undefined {
  const explicit = readTrimmedString(args.cwd);
  if (explicit) {
    return explicit;
  }
  const contextRecord = asRecord(adapterContext);
  return (
    readWorkingDirectoryFromRecord(contextRecord)
    || readWorkingDirectoryFromRecord(asRecord(contextRecord?.metadata))
    || readWorkingDirectoryFromRecord(asRecord(contextRecord?.__rt))
    || undefined
  );
}

export function extractLatestUserRequestText(seed: CapturedChatSeed | null): string {
  const messages = Array.isArray(seed?.messages) ? seed!.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      continue;
    }
    const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
    if (role !== 'user') {
      continue;
    }
    const content = message.content;
    if (typeof content === 'string') {
      const sanitized = sanitizeFollowupText(content);
      if (sanitized) {
        return sanitized;
      }
      continue;
    }
    if (!Array.isArray(content)) {
      continue;
    }
    const texts: string[] = [];
    for (const part of content) {
      const row = asRecord(part);
      const text = readTrimmedString(row?.text ?? row?.content ?? row?.input_text ?? row?.output_text);
      if (text) {
        texts.push(text);
      }
    }
    const joined = sanitizeFollowupText(texts.join('\n'));
    if (joined) {
      return joined;
    }
  }
  return '';
}

export function buildReviewFollowupText(args: {
  goal?: string;
  focus?: string;
  requestText?: string;
  aiSuggestion?: string;
}): string {
  const lines: string[] = [
    '严格代码 review：必须先根据本次请求逐条核验代码、测试、构建和完成证据，再决定下一步。',
    '状态：queued for servertool reenter。'
  ];
  const goal = readTrimmedString(args.goal);
  if (goal) {
    lines.push(`当前目标：${goal}`);
  }
  const focus = readTrimmedString(args.focus);
  if (focus) {
    lines.push(`重点检查：${focus}`);
  }
  const requestText = readTrimmedString(args.requestText);
  if (requestText) {
    lines.push(`原始请求：${requestText}`);
  }
  const aiSuggestion = readTrimmedString(args.aiSuggestion);
  if (aiSuggestion) {
    lines.push(`AI review 建议：${aiSuggestion}`);
  }
  return lines.join('\n\n').trim();
}

export function buildReviewFollowupPayload(args: {
  seed: CapturedChatSeed | null;
  followupText: string;
}): JsonObject {
  const messages = Array.isArray(args.seed?.messages)
    ? (cloneJson(args.seed!.messages) as JsonObject[])
    : [];
  messages.push({
    role: 'user',
    content: args.followupText
  } as JsonObject);
  const payload: JsonObject = {
    messages
  };
  if (typeof args.seed?.model === 'string' && args.seed.model.trim()) {
    payload.model = args.seed.model.trim();
  }
  if (args.seed?.parameters && typeof args.seed.parameters === 'object') {
    payload.parameters = cloneJson(args.seed.parameters) as unknown as JsonObject;
  }
  const tools = dropToolByFunctionName(args.seed?.tools, 'review');
  if (Array.isArray(tools) && tools.length > 0) {
    payload.tools = cloneJson(tools);
  }
  return payload;
}

export function injectReviewToolOutput(args: {
  base: JsonObject;
  toolCall: ToolCall;
  workdir?: string;
}): JsonObject {
  const cloned = cloneJson(args.base);
  const existingOutputs = Array.isArray((cloned as { tool_outputs?: unknown }).tool_outputs)
    ? (((cloned as { tool_outputs: unknown[] }).tool_outputs) as unknown[])
    : [];
  (cloned as Record<string, unknown>).tool_outputs = [
    ...existingOutputs,
    {
      tool_call_id: args.toolCall.id,
      name: 'review',
      content: JSON.stringify({
        ok: true,
        queued: true,
        flowId: 'review_flow',
        ...(args.workdir ? { workdir: args.workdir } : {})
      })
    }
  ];
  const choices = Array.isArray((cloned as { choices?: unknown }).choices)
    ? (((cloned as { choices: unknown[] }).choices) as unknown[])
    : [];
  for (const choice of choices) {
    const choiceRow =
      choice && typeof choice === 'object' && !Array.isArray(choice)
        ? (choice as Record<string, unknown>)
        : null;
    const message =
      choiceRow?.message && typeof choiceRow.message === 'object' && !Array.isArray(choiceRow.message)
        ? (choiceRow.message as Record<string, unknown>)
        : null;
    if (!message || !Array.isArray(message.tool_calls)) {
      continue;
    }
    const keptCalls = message.tool_calls.filter((entry) => {
      const record = asRecord(entry);
      const id = typeof record?.id === 'string' ? record.id.trim() : '';
      return id !== args.toolCall.id;
    });
    if (keptCalls.length > 0) {
      message.tool_calls = keptCalls;
      continue;
    }
    delete message.tool_calls;
  }
  return cloned;
}
