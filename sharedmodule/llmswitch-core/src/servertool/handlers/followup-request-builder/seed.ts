import type { JsonObject } from '../../../conversion/hub/types/json.js';
import {
  buildChatRequestFromResponses,
  captureResponsesContext
} from '../../../conversion/responses/responses-openai-bridge.js';
import { cloneJson } from '../../server-side-tools.js';

export type CapturedChatSeed = {
  model?: string;
  messages: JsonObject[];
  tools?: JsonObject[];
  parameters?: Record<string, unknown>;
};

export function resolveFollowupModel(seedModel: unknown, adapterContext: unknown): string {
  if (!adapterContext || typeof adapterContext !== 'object' || Array.isArray(adapterContext)) {
    return typeof seedModel === 'string' && seedModel.trim() ? seedModel.trim() : '';
  }
  const record = adapterContext as Record<string, unknown>;
  const candidates: unknown[] = [
    record.assignedModelId,
    record.modelId,
    seedModel,
    record.model,
    record.originalModelId
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function extractResponsesTopLevelParameters(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const allowed = new Set([
    'temperature',
    'top_p',
    'max_output_tokens',
    'seed',
    'logit_bias',
    'user',
    'parallel_tool_calls',
    'tool_choice',
    'response_format',
    'stream'
  ]);
  const out: Record<string, unknown> = {};
  if (record.max_output_tokens === undefined && record.max_tokens !== undefined) {
    out.max_output_tokens = record.max_tokens;
  }
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) continue;
    out[key] = record[key];
  }
  return Object.keys(out).length ? out : undefined;
}

export function normalizeFollowupParameters(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const cloned = cloneJson(value as Record<string, unknown>) as Record<string, unknown>;
  delete (cloned as { stream?: unknown }).stream;
  delete (cloned as { tool_choice?: unknown }).tool_choice;
  return Object.keys(cloned).length ? cloned : undefined;
}

export function stripInheritedFollowupOutputBudget(
  parameters: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    return undefined;
  }
  const sanitized = cloneJson(parameters) as Record<string, unknown>;
  delete (sanitized as { max_tokens?: unknown }).max_tokens;
  delete (sanitized as { max_output_tokens?: unknown }).max_output_tokens;
  return Object.keys(sanitized).length ? sanitized : undefined;
}

function normalizeModelIdentity(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function sanitizeFollowupParametersForResolvedModel(args: {
  parameters: Record<string, unknown> | undefined;
  seedModel: unknown;
  followupModel: string;
}): Record<string, unknown> | undefined {
  if (!args.parameters || typeof args.parameters !== 'object' || Array.isArray(args.parameters)) {
    return undefined;
  }
  const sanitized = stripInheritedFollowupOutputBudget(args.parameters);
  const seedModel = normalizeModelIdentity(args.seedModel);
  const followupModel = normalizeModelIdentity(args.followupModel);
  if (!seedModel || !followupModel) {
    return sanitized;
  }
  return sanitized;
}

export function extractCapturedChatSeed(source: unknown): CapturedChatSeed | null {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return null;
  }
  const record = source as Record<string, unknown>;
  const model = typeof record.model === 'string' && record.model.trim().length ? record.model.trim() : undefined;

  const rawMessages = Array.isArray(record.messages) ? (record.messages as JsonObject[]) : null;
  if (rawMessages) {
    const tools = Array.isArray(record.tools) ? (cloneJson(record.tools as JsonObject[]) as JsonObject[]) : undefined;
    const parameters = normalizeFollowupParameters(record.parameters ?? extractResponsesTopLevelParameters(record));
    return {
      ...(model ? { model } : {}),
      messages: cloneJson(rawMessages) as JsonObject[],
      ...(tools ? { tools } : {}),
      ...(parameters ? { parameters } : {})
    };
  }

  const rawInput = Array.isArray(record.input) ? (record.input as unknown[]) : null;
  if (!rawInput) {
    return null;
  }
  try {
    const ctx = captureResponsesContext(record as Record<string, unknown>);
    if (!ctx.isResponsesPayload) {
      return null;
    }
    const rebuilt = buildChatRequestFromResponses(record as Record<string, unknown>, ctx).request as Record<
      string,
      unknown
    >;
    const rebuiltModel =
      typeof rebuilt.model === 'string' && rebuilt.model.trim().length ? String(rebuilt.model).trim() : model;
    const rebuiltMessages = Array.isArray(rebuilt.messages) ? (rebuilt.messages as JsonObject[]) : [];
    const rebuiltTools = Array.isArray(rebuilt.tools) ? (rebuilt.tools as JsonObject[]) : undefined;
    const parameters = normalizeFollowupParameters(
      record.parameters ?? rebuilt.parameters ?? extractResponsesTopLevelParameters(record)
    );
    return {
      ...(rebuiltModel ? { model: rebuiltModel } : {}),
      messages: cloneJson(rebuiltMessages) as JsonObject[],
      ...(rebuiltTools ? { tools: cloneJson(rebuiltTools) as JsonObject[] } : {}),
      ...(parameters ? { parameters } : {})
    };
  } catch {
    return null;
  }
}

export function dropToolByFunctionName(tools: JsonObject[] | undefined, dropName: string): JsonObject[] | undefined {
  const name = typeof dropName === 'string' ? dropName.trim() : '';
  if (!tools || !tools.length || !name) {
    return tools;
  }
  return tools.filter((tool) => {
    if (!tool || typeof tool !== 'object') return false;
    const fn = (tool as { function?: unknown }).function;
    const toolName =
      fn && typeof (fn as { name?: unknown }).name === 'string' ? ((fn as { name: string }).name as string) : '';
    if (!toolName) return true;
    return toolName !== name;
  });
}
