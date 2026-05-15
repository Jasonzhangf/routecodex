import type { JsonObject, JsonValue } from '../../../conversion/hub/types/json.js';
import { cloneJson } from '../../server-side-tools.js';
import type { ServerToolFollowupInjectionOp, ServerToolFollowupInjectionPlan } from '../../types.js';
import { trimOpenAiMessagesForFollowup } from '../followup-message-trimmer.js';
import { REASONING_STOP_TOOL_DEF } from '../reasoning-stop-state.js';
import type { CapturedChatSeed } from './seed.js';
import { dropToolByFunctionName } from './seed.js';
import {
  buildToolMessagesFromToolOutputs,
  compactToolContentInMessages,
  extractAssistantMessageFromChatLike,
  injectSystemTextIntoMessages,
  injectVisionSummaryIntoMessages
} from './message-blocks.js';

export type FollowupBuilderState = {
  messages: JsonObject[];
  tools?: JsonObject[];
  parameters?: Record<string, unknown>;
};

export type FollowupBuilderContext = {
  chatResponse: JsonObject;
  includeReasoningStopTool: boolean;
};

type FollowupOpHandler<T extends ServerToolFollowupInjectionOp = ServerToolFollowupInjectionOp> = (
  state: FollowupBuilderState,
  op: T,
  context: FollowupBuilderContext
) => FollowupBuilderState | null;

type FollowupOpHandlerMap = {
  [K in ServerToolFollowupInjectionOp['op']]: FollowupOpHandler<Extract<ServerToolFollowupInjectionOp, { op: K }>>;
};

function readToolName(tool: unknown): string {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
    return '';
  }
  const record = tool as Record<string, unknown>;
  if (typeof record.name === 'string' && record.name.trim()) {
    return record.name.trim().toLowerCase();
  }
  const fn =
    record.function && typeof record.function === 'object' && !Array.isArray(record.function)
      ? (record.function as Record<string, unknown>)
      : undefined;
  return typeof fn?.name === 'string' && fn.name.trim()
    ? fn.name.trim().toLowerCase()
    : '';
}

export function shouldIncludeReasoningStopToolFromOps(
  ops: ServerToolFollowupInjectionPlan['ops'] | undefined
): boolean {
  if (!Array.isArray(ops) || ops.length === 0) {
    return false;
  }
  for (const op of ops) {
    if (!op || typeof op !== 'object') {
      continue;
    }
    if (op.op !== 'append_user_text' && op.op !== 'inject_system_text') {
      continue;
    }
    const text = typeof (op as { text?: unknown }).text === 'string'
      ? String((op as { text: string }).text).trim().toLowerCase()
      : '';
    if (text && (text.includes('reasoning.stop') || text.includes('stopless'))) {
      return true;
    }
  }
  return false;
}

export function hasReasoningStopTool(tools: JsonObject[] | undefined): boolean {
  return Boolean(
    Array.isArray(tools)
    && tools.some((tool) => {
      return readToolName(tool) === 'reasoning.stop';
    })
  );
}

export function stripToolsByCanonicalName(
  tools: JsonObject[] | undefined,
  dropNames: string[]
): JsonObject[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) {
    return tools;
  }
  const blocked = new Set(
    dropNames
      .map((value) => String(value ?? '').trim().toLowerCase())
      .filter(Boolean)
  );
  if (blocked.size === 0) {
    return tools;
  }
  return tools.filter((tool) => {
    const name = readToolName(tool);
    return !name || !blocked.has(name);
  });
}

function ensureStandardToolsIfMissing(
  current: JsonObject[] | undefined,
  options?: { includeReasoningStopTool?: boolean }
): JsonObject[] {
  const existing = Array.isArray(current) ? (cloneJson(current) as JsonObject[]) : [];
  if (!existing.length) {
    return existing;
  }
  const seen = new Set<string>();
  for (const tool of existing) {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) continue;
    const fn = (tool as any).function;
    const name = fn && typeof fn === 'object' && typeof fn.name === 'string' ? String(fn.name).trim() : '';
    if (name) seen.add(name);
  }
  if (options?.includeReasoningStopTool === true && !seen.has('reasoning.stop')) {
    existing.push(cloneJson(REASONING_STOP_TOOL_DEF) as JsonObject);
  }
  return existing;
}

function withParameters(state: FollowupBuilderState): FollowupBuilderState & { parameters: Record<string, unknown> } {
  if (state.parameters) {
    return state as FollowupBuilderState & { parameters: Record<string, unknown> };
  }
  return { ...state, parameters: {} };
}

const FOLLOWUP_OP_HANDLERS: FollowupOpHandlerMap = {
  replace_tools: (state, op) => ({
    ...state,
    tools: Array.isArray(op.tools) ? (cloneJson(op.tools) as JsonObject[]) : []
  }),
  preserve_tools: (state) => state,
  ensure_standard_tools: (state, _op, context) => ({
    ...state,
    tools: ensureStandardToolsIfMissing(state.tools, {
      includeReasoningStopTool: context.includeReasoningStopTool
    })
  }),
  force_tool_choice: (state, op) => {
    const next = withParameters(state);
    if (op.value === undefined) {
      delete (next.parameters as { tool_choice?: unknown }).tool_choice;
      return next;
    }
    (next.parameters as { tool_choice?: unknown }).tool_choice = cloneJson(op.value as JsonValue);
    if (
      op.value &&
      typeof op.value === 'object' &&
      !Array.isArray(op.value) &&
      typeof (op.value as { type?: unknown }).type === 'string' &&
      String((op.value as { type?: unknown }).type).trim().toLowerCase() === 'function'
    ) {
      (next.parameters as { parallel_tool_calls?: unknown }).parallel_tool_calls = false;
    }
    return next;
  },
  append_assistant_message: (state, op, context) => {
    const msg = extractAssistantMessageFromChatLike(context.chatResponse);
    if (!msg) {
      return op.required === false ? state : null;
    }
    return { ...state, messages: [...state.messages, msg] };
  },
  append_tool_messages_from_tool_outputs: (state, op, context) => {
    const toolMessages = buildToolMessagesFromToolOutputs(context.chatResponse);
    if (!toolMessages.length) {
      return op.required === false ? state : null;
    }
    return { ...state, messages: [...state.messages, ...toolMessages] };
  },
  inject_system_text: (state, op) => {
    const text = typeof op.text === 'string' ? op.text.trim() : '';
    return text ? { ...state, messages: injectSystemTextIntoMessages(state.messages, text) } : state;
  },
  append_user_text: (state, op) => {
    const text = typeof op.text === 'string' ? op.text : '';
    return text.trim().length
      ? { ...state, messages: [...state.messages, { role: 'user', content: text } as JsonObject] }
      : state;
  },
  drop_tool_by_name: (state, op) => {
    const name = typeof op.name === 'string' ? op.name.trim() : '';
    return name ? { ...state, tools: dropToolByFunctionName(state.tools, name) } : state;
  },
  inject_vision_summary: (state, op) => {
    const summary = typeof op.summary === 'string' ? op.summary.trim() : '';
    return summary ? { ...state, messages: injectVisionSummaryIntoMessages(state.messages, summary) } : state;
  },
  trim_openai_messages: (state, op) => ({
    ...state,
    messages: trimOpenAiMessagesForFollowup(state.messages, {
      maxNonSystemMessages: typeof op.maxNonSystemMessages === 'number' ? op.maxNonSystemMessages : 16
    })
  }),
  append_tool_if_missing: (state, op) => {
    const toolName = typeof op.toolName === 'string' ? op.toolName.trim() : '';
    if (!toolName || !op.toolDefinition || typeof op.toolDefinition !== 'object' || Array.isArray(op.toolDefinition)) {
      return state;
    }
    const exists = Array.isArray(state.tools) && state.tools.some((tool) => {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return false;
      const fn = (tool as any).function;
      const name = fn && typeof fn === 'object' && typeof fn.name === 'string'
        ? String(fn.name).trim()
        : '';
      return name === toolName;
    });
    return exists
      ? state
      : {
          ...state,
          tools: [...(Array.isArray(state.tools) ? state.tools : []), cloneJson(op.toolDefinition) as JsonObject]
        };
  },
  compact_tool_content: (state, op) => ({
    ...state,
    messages: compactToolContentInMessages(state.messages, {
      maxChars: typeof op.maxChars === 'number' ? Math.max(64, Math.floor(op.maxChars)) : 1200
    })
  })
};

export function applyFollowupInjectionOps(args: {
  state: FollowupBuilderState;
  ops: ServerToolFollowupInjectionPlan['ops'];
  context: FollowupBuilderContext;
}): FollowupBuilderState | null {
  let current = args.state;
  for (const op of args.ops) {
    if (!op || typeof op !== 'object') continue;
    const handler = FOLLOWUP_OP_HANDLERS[op.op] as FollowupOpHandler<ServerToolFollowupInjectionOp>;
    if (!handler) continue;
    const next = handler(current, op as ServerToolFollowupInjectionOp, args.context);
    if (!next) return null;
    current = next;
  }
  return current;
}

export function resolveFollowupInjectionOpsForNative(args: {
  ops: Array<Record<string, unknown>>;
  seed: CapturedChatSeed;
  allowReasoningStopTool?: boolean;
}): Array<Record<string, unknown>> {
  return args.ops.map((op) => {
    if (!op || typeof op !== 'object') {
      return op;
    }
    const opName = typeof op.op === 'string' ? String(op.op).trim() : '';
    if (opName !== 'ensure_standard_tools') {
      return op;
    }
    const hasReasoningStopMention = args.ops.some((entry) => {
      const entryName = typeof entry?.op === 'string' ? String(entry.op).trim() : '';
      if (entryName !== 'append_user_text' && entryName !== 'inject_system_text') {
        return false;
      }
      const text = typeof entry?.text === 'string' ? entry.text.trim().toLowerCase() : '';
      return text.includes('reasoning.stop') || text.includes('stopless');
    });
    return {
      ...op,
      includeReasoningStopTool:
        args.allowReasoningStopTool !== false
        && (hasReasoningStopMention || hasReasoningStopTool(args.seed.tools)),
      reasoningStopToolDefinition: REASONING_STOP_TOOL_DEF
    };
  });
}
