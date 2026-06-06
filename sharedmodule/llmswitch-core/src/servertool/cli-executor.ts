import type { JsonObject } from '../conversion/hub/types/json.js';

export interface ServertoolCliExecutionResult {
  ok: boolean;
  kind: string;
  tool: string;
  summary: string;
  continuationPrompt?: string;
  repeatCount?: number;
  maxRepeats?: number;
  injectedPromptPreview?: string;
  result?: unknown;
}

export async function executeServertoolCliCommand(args: {
  toolName: string;
  input: JsonObject;
}): Promise<ServertoolCliExecutionResult> {
  const toolName = normalizeToolName(args.toolName);
  if (toolName === 'stop_message_auto') {
    const continuationPrompt = readNonEmptyString(args.input.continuationPrompt);
    const repeatCount = readNonNegativeInteger(args.input.repeatCount);
    const maxRepeats = readNonNegativeInteger(args.input.maxRepeats);
    const summary = typeof args.input.stdoutPreview === 'string' && args.input.stdoutPreview.trim()
      ? args.input.stdoutPreview.trim()
      : 'servertool continuation ready';
    return {
      ok: true,
      kind: 'stop_message_auto',
      tool: toolName,
      summary,
      ...(continuationPrompt ? { continuationPrompt } : {}),
      ...(repeatCount !== undefined ? { repeatCount } : {}),
      ...(maxRepeats !== undefined ? { maxRepeats } : {}),
      ...(continuationPrompt ? { injectedPromptPreview: continuationPrompt.slice(0, 240) } : {})
    };
  }
  if (toolName === 'servertool_fixture') {
    return {
      ok: true,
      kind: 'fixture',
      tool: toolName,
      summary: 'servertool_fixture execution requested',
      result: args.input
    };
  }
  throw new Error(`[servertool.cli] unsupported tool: ${toolName}`);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.floor(value);
  return normalized >= 0 ? normalized : undefined;
}

export function parseServertoolCliInputJson(inputJson: string | undefined): JsonObject {
  const raw = typeof inputJson === 'string' && inputJson.trim() ? inputJson.trim() : '{}';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as JsonObject;
    }
  } catch {
    throw new Error('[servertool.cli] --input-json must be a JSON object');
  }
  throw new Error('[servertool.cli] --input-json must be a JSON object');
}

function normalizeToolName(toolName: string): string {
  const normalized = toolName.trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(normalized)) {
    throw new Error(`[servertool.cli] invalid tool name: ${toolName}`);
  }
  return normalized;
}
