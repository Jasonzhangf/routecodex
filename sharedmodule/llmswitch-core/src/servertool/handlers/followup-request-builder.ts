import type { JsonObject } from '../../conversion/hub/types/json.js';
import {
  buildChatRequestFromResponses,
  captureResponsesContext
} from '../../conversion/responses/responses-openai-bridge.js';
import { cloneJson } from '../server-side-tools.js';
import { trimOpenAiMessagesForFollowup } from './followup-message-trimmer.js';
import type { ServerToolFollowupInjectionPlan } from '../types.js';

export type CapturedChatSeed = {
  model?: string;
  messages: JsonObject[];
  tools?: JsonObject[];
  parameters?: Record<string, unknown>;
};

function resolveFollowupModel(seedModel: unknown, adapterContext: unknown): string {
  if (typeof seedModel === 'string' && seedModel.trim()) {
    return seedModel.trim();
  }
  if (!adapterContext || typeof adapterContext !== 'object' || Array.isArray(adapterContext)) {
    return '';
  }
  const record = adapterContext as Record<string, unknown>;
  const candidates: unknown[] = [
    record.model,
    record.modelId,
    record.assignedModelId,
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
  // Back-compat: StandardizedRequest uses max_tokens; map to Responses max_output_tokens.
  if (record.max_output_tokens === undefined && record.max_tokens !== undefined) {
    out.max_output_tokens = record.max_tokens;
  }
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) continue;
    out[key] = record[key];
  }
  return Object.keys(out).length ? out : undefined;
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

  // Backward/compat: some hosts may have captured the raw /v1/responses payload.
  const rawInput = Array.isArray(record.input) ? (record.input as unknown[]) : null;
  if (rawInput) {
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

  return null;
}

export function normalizeFollowupParameters(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const cloned = cloneJson(value as Record<string, unknown>) as Record<string, unknown>;
  // Followup requests are always re-entered as a fresh hop:
  // - non-streaming (servertool orchestration enforces this)
  // - no inherited tool-selection hints, otherwise the resumed turn can be biased toward
  //   immediately calling tools again instead of consuming the tool outputs that were just injected.
  // Keep `parallel_tool_calls` inherited; provider compat can still disable it selectively.
  delete (cloned as { stream?: unknown }).stream;
  delete (cloned as { tool_choice?: unknown }).tool_choice;
  return Object.keys(cloned).length ? cloned : undefined;
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

function extractAssistantMessageFromChatLike(chatResponse: JsonObject): JsonObject | null {
  if (!chatResponse || typeof chatResponse !== 'object') {
    return null;
  }
  const choices = Array.isArray((chatResponse as { choices?: unknown }).choices)
    ? ((chatResponse as { choices: unknown[] }).choices as unknown[])
    : [];
  if (choices.length > 0) {
    const first = choices[0] && typeof choices[0] === 'object' && !Array.isArray(choices[0])
      ? (choices[0] as Record<string, unknown>)
      : null;
    const msg =
      first &&
      first.message &&
      typeof first.message === 'object' &&
      !Array.isArray(first.message)
        ? (first.message as Record<string, unknown>)
        : null;
    if (msg) {
      return cloneJson(msg as JsonObject);
    }
  }
  // Responses-like fallback: try output_text.
  const outputText = (chatResponse as { output_text?: unknown }).output_text;
  if (typeof outputText === 'string' && outputText.trim().length) {
    return { role: 'assistant', content: outputText.trim() } as JsonObject;
  }
  return null;
}

function buildToolMessagesFromToolOutputs(chatResponse: JsonObject): JsonObject[] {
  const toolOutputs = Array.isArray((chatResponse as { tool_outputs?: unknown }).tool_outputs)
    ? ((chatResponse as { tool_outputs: unknown[] }).tool_outputs as unknown[])
    : [];
  const messages: JsonObject[] = [];
  for (const entry of toolOutputs) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const toolCallId = typeof record.tool_call_id === 'string' ? record.tool_call_id : undefined;
    if (!toolCallId) continue;
    const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : 'tool';
    const rawContent = record.content;
    let contentText: string;
    if (typeof rawContent === 'string') {
      contentText = rawContent;
    } else {
      try {
        contentText = JSON.stringify(rawContent ?? {});
      } catch {
        contentText = String(rawContent ?? '');
      }
    }
    messages.push({
      role: 'tool',
      tool_call_id: toolCallId,
      name,
      content: contentText
    } as JsonObject);
  }
  return messages;
}

function injectVisionSummaryIntoMessages(source: JsonObject[], summary: string): JsonObject[] {
  const messages = Array.isArray(source) ? (cloneJson(source) as JsonObject[]) : [];
  let injected = false;
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    const nextParts: unknown[] = [];
    let removed = false;
    for (const part of content) {
      if (part && typeof part === 'object') {
        const typeValue = typeof (part as { type?: unknown }).type === 'string'
          ? String((part as { type?: unknown }).type).toLowerCase()
          : '';
        if (typeValue.includes('image')) {
          removed = true;
          nextParts.push({ type: 'text', text: '[Image omitted]' });
          continue;
        }
      }
      nextParts.push(part);
    }
    if (removed) {
      nextParts.push({
        type: 'text',
        text: `[Vision] ${summary}`
      });
      (message as Record<string, unknown>).content = nextParts;
      injected = true;
    }
  }

  if (!injected) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (!msg || typeof msg !== 'object') continue;
      const role = typeof (msg as { role?: unknown }).role === 'string'
        ? String((msg as { role?: unknown }).role).toLowerCase()
        : '';
      if (role !== 'user') continue;
      const content = (msg as { content?: unknown }).content;
      if (Array.isArray(content)) {
        content.push({
          type: 'text',
          text: `[Vision] ${summary}`
        });
        injected = true;
        break;
      }
      if (typeof content === 'string' && content.length) {
        (msg as Record<string, unknown>).content = `${content}\n[Vision] ${summary}`;
      } else {
        (msg as Record<string, unknown>).content = `[Vision] ${summary}`;
      }
      injected = true;
      break;
    }
  }

  if (!injected) {
    messages.push({
      role: 'user',
      content: `[Vision] ${summary}`
    } as JsonObject);
  }

  return messages;
}

function injectSystemTextIntoMessages(source: JsonObject[], text: string): JsonObject[] {
  const messages = Array.isArray(source) ? (cloneJson(source) as JsonObject[]) : [];
  const content = typeof text === 'string' ? text : '';
  if (!content.trim().length) {
    return messages;
  }
  const sys: JsonObject = { role: 'system', content } as JsonObject;
  let insertAt = 0;
  while (insertAt < messages.length) {
    const msg = messages[insertAt];
    const role =
      msg && typeof msg === 'object' && !Array.isArray(msg) && typeof (msg as { role?: unknown }).role === 'string'
        ? String((msg as { role?: unknown }).role).trim().toLowerCase()
        : '';
    if (role === 'system') {
      insertAt += 1;
      continue;
    }
    break;
  }
  messages.splice(insertAt, 0, sys);
  return messages;
}

function compactToolContentValue(value: unknown, maxChars: number): string {
  const text =
    typeof value === 'string'
      ? value
      : (() => {
          try {
            return JSON.stringify(value ?? '');
          } catch {
            return String(value ?? '');
          }
        })();
  if (text.length <= maxChars) {
    return text;
  }
  const keepHead = Math.max(24, Math.floor(maxChars * 0.45));
  const keepTail = Math.max(24, Math.floor(maxChars * 0.35));
  const omitted = Math.max(0, text.length - keepHead - keepTail);
  const head = text.slice(0, keepHead);
  const tail = text.slice(text.length - keepTail);
  return head + '\n...[tool_output_compacted omitted=' + String(omitted) + ']...\n' + tail;
}

function compactToolContentInMessages(source: JsonObject[], options: { maxChars: number }): JsonObject[] {
  const maxChars = Number.isFinite(options.maxChars) ? Math.max(64, Math.floor(options.maxChars)) : 1200;
  const messages = Array.isArray(source) ? (cloneJson(source) as JsonObject[]) : [];
  for (const message of messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      continue;
    }
    const role =
      typeof (message as { role?: unknown }).role === 'string'
        ? String((message as { role?: unknown }).role).trim().toLowerCase()
        : '';
    if (role !== 'tool') {
      continue;
    }
    const content = (message as { content?: unknown }).content;
    (message as Record<string, unknown>).content = compactToolContentValue(content, maxChars);
  }
  return messages;
}

function shouldIncludeReasoningStopToolFromOps(ops: ServerToolFollowupInjectionPlan['ops'] | undefined): boolean {
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
    if (!text) {
      continue;
    }
    if (text.includes('reasoning.stop') || text.includes('stopless')) {
      return true;
    }
  }
  return false;
}

function buildStandardFollowupTools(options?: { includeReasoningStopTool?: boolean }): JsonObject[] {
  // Keep this list minimal and stable. Used only as a best-effort fallback when a followup hop
  // would otherwise have no tools at all (which can cause tool-based clients to "break" mid-session).
  const tools: JsonObject[] = [
    {
      type: 'function',
      function: {
        name: 'shell',
        description: 'Runs a shell command and returns its output.',
        parameters: {
          type: 'object',
          properties: {
            command: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
            workdir: { type: 'string' }
          },
          required: ['command'],
          additionalProperties: false
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'exec_command',
        description: 'Execute a command in a PTY and return output.',
        parameters: {
          type: 'object',
          properties: {
            cmd: { type: 'string' },
            workdir: { type: 'string' },
            timeout_ms: { type: 'number' },
            max_output_tokens: { type: 'number' },
            yield_time_ms: { type: 'number' }
          },
          required: ['cmd'],
          additionalProperties: false
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'review',
        description:
          'Independent reviewer handoff. Reviewer must first verify code against the current request (target files + relevant tests/commands + evidence), then provide actionable suggestions. Do not stop immediately after this tool.',
        parameters: {
          type: 'object',
          properties: {
            goal: { type: 'string' },
            context: { type: 'string' },
            focus: { type: 'string' }
          },
          required: ['goal', 'context', 'focus'],
          additionalProperties: false
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'apply_patch',
        description: 'Apply a patch to repository files.',
        parameters: {
          type: 'object',
          properties: {
            patch: { type: 'string' }
          },
          required: ['patch'],
          additionalProperties: false
        }
      }
    }
  ] as unknown as JsonObject[];
  if (options?.includeReasoningStopTool === true) {
    tools.push({
      type: 'function',
      function: {
        name: 'reasoning.stop',
        description:
          'Structured stop self-check gate. Stop is allowed only when either: (A) task is completed with completion_evidence; or (B) all feasible attempts are exhausted and blocked, with cannot_complete_reason + blocking_evidence + attempts_exhausted=true. Required: task_goal, is_completed. If not completed but a concrete next action exists, fill next_step and continue instead of stopping.',
        parameters: {
          type: 'object',
          properties: {
            task_goal: { type: 'string' },
            is_completed: { type: 'boolean' },
            completion_evidence: { type: 'string' },
            cannot_complete_reason: { type: 'string' },
            blocking_evidence: { type: 'string' },
            attempts_exhausted: { type: 'boolean' },
            next_step: { type: 'string' }
          },
          required: ['task_goal', 'is_completed'],
          additionalProperties: false
        }
      }
    } as unknown as JsonObject);
  }
  return tools;
}

function ensureStandardToolsIfMissing(
  current: JsonObject[] | undefined,
  options?: { includeReasoningStopTool?: boolean }
): JsonObject[] {
  const existing = Array.isArray(current) ? (cloneJson(current) as JsonObject[]) : [];
  const seen = new Set<string>();
  for (const tool of existing) {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) continue;
    const fn = (tool as any).function;
    const name = fn && typeof fn === 'object' && typeof fn.name === 'string' ? String(fn.name).trim() : '';
    if (name) seen.add(name);
  }
  for (const tool of buildStandardFollowupTools(options)) {
    const fn = (tool as any).function;
    const name = fn && typeof fn === 'object' && typeof fn.name === 'string' ? String(fn.name).trim() : '';
    if (!name) continue;
    if (seen.has(name)) continue;
    existing.push(tool);
    seen.add(name);
  }
  return existing;
}

/**
 * Build a canonical followup request body from injection ops.
 *
 * Important: this returns a protocol-agnostic "chat-like" payload:
 * { model, messages, tools?, parameters? }
 *
 * The followup is expected to re-enter HubPipeline at the chat-process entry,
 * so we must not convert to /v1/responses or /v1/messages here.
 */
export function buildServerToolFollowupChatPayloadFromInjection(args: {
  adapterContext: unknown;
  chatResponse: JsonObject;
  injection: ServerToolFollowupInjectionPlan;
}): JsonObject | null {
  const captured =
    args.adapterContext && typeof args.adapterContext === 'object'
      ? ((args.adapterContext as { capturedChatRequest?: unknown }).capturedChatRequest as unknown)
      : undefined;
  const seed = extractCapturedChatSeed(captured);
  if (!seed) {
    return null;
  }
  const followupModel = resolveFollowupModel(seed.model, args.adapterContext);
  if (!followupModel) {
    return null;
  }

  let messages: JsonObject[] = Array.isArray(seed.messages) ? (cloneJson(seed.messages) as JsonObject[]) : [];
  const ops = Array.isArray(args.injection?.ops) ? args.injection.ops : [];
  // Followup is a normal request hop: inherit tool schema from the captured request and
  // let compat/tool-governance apply standard sanitization rules.
  let tools: JsonObject[] | undefined = Array.isArray(seed.tools) ? (cloneJson(seed.tools) as JsonObject[]) : undefined;
  const includeReasoningStopTool =
    shouldIncludeReasoningStopToolFromOps(ops)
    || Boolean(
      Array.isArray(tools)
      && tools.some((tool) => {
        if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
          return false;
        }
        const fn = (tool as any).function;
        const name = fn && typeof fn === 'object' && typeof fn.name === 'string'
          ? String(fn.name).trim().toLowerCase()
          : '';
        return name === 'reasoning.stop';
      })
    );
  const parameters = seed.parameters ? (cloneJson(seed.parameters) as Record<string, unknown>) : undefined;

  for (const op of ops) {
    if (!op || typeof op !== 'object') continue;
    if (op.op === 'preserve_tools') {
      // No-op: tools are preserved by default. Kept for backward compatibility.
      continue;
    }
    if (op.op === 'ensure_standard_tools') {
      tools = ensureStandardToolsIfMissing(tools, { includeReasoningStopTool });
      continue;
    }
    if (op.op === 'trim_openai_messages') {
      const maxNonSystemMessages =
        typeof (op as { maxNonSystemMessages?: unknown }).maxNonSystemMessages === 'number'
          ? (op as { maxNonSystemMessages: number }).maxNonSystemMessages
          : 16;
      messages = trimOpenAiMessagesForFollowup(messages, { maxNonSystemMessages });
      continue;
    }
    if (op.op === 'compact_tool_content') {
      const maxChars =
        typeof (op as { maxChars?: unknown }).maxChars === 'number'
          ? Math.max(64, Math.floor((op as { maxChars: number }).maxChars))
          : 1200;
     messages = compactToolContentInMessages(messages, { maxChars });
     continue;
   }
    if (op.op === 'append_tool_if_missing') {
      const toolName = typeof (op as { toolName?: unknown }).toolName === 'string'
        ? String((op as { toolName: string }).toolName).trim()
        : '';
      const toolDef = (op as { toolDefinition?: unknown }).toolDefinition;
      if (!toolName || !toolDef || typeof toolDef !== 'object' || Array.isArray(toolDef)) {
        continue;
      }
      // Check if tool already exists
      const exists = Array.isArray(tools) && tools.some((t) => {
        if (!t || typeof t !== 'object' || Array.isArray(t)) return false;
        const fn = (t as any).function;
        const name = fn && typeof fn === 'object' && typeof fn.name === 'string'
          ? String(fn.name).trim()
          : '';
        return name === toolName;
      });
      if (!exists) {
        if (!Array.isArray(tools)) {
          tools = [];
        }
        tools.push(toolDef as JsonObject);
      }
      continue;
    }
   if (op.op === 'append_assistant_message') {
      const required = (op as { required?: unknown }).required !== false;
      const msg = extractAssistantMessageFromChatLike(args.chatResponse);
      if (!msg) {
        if (required) return null;
        continue;
      }
      messages.push(msg);
      continue;
    }
    if (op.op === 'append_tool_messages_from_tool_outputs') {
      const required = (op as { required?: unknown }).required !== false;
      const toolMessages = buildToolMessagesFromToolOutputs(args.chatResponse);
      if (!toolMessages.length) {
        if (required) return null;
        continue;
      }
      messages.push(...toolMessages);
      continue;
    }
    if (op.op === 'inject_system_text') {
      const text = typeof (op as { text?: unknown }).text === 'string' ? String((op as { text: string }).text) : '';
      if (text.trim().length) {
        messages = injectSystemTextIntoMessages(messages, text.trim());
      }
      continue;
    }
    if (op.op === 'append_user_text') {
      const text = typeof (op as { text?: unknown }).text === 'string' ? String((op as { text: string }).text) : '';
      if (text.trim().length) {
        messages.push({ role: 'user', content: text } as JsonObject);
      }
      continue;
    }
    if (op.op === 'drop_tool_by_name') {
      const name = typeof (op as { name?: unknown }).name === 'string' ? String((op as { name: string }).name) : '';
      if (name.trim().length) {
        tools = dropToolByFunctionName(tools, name.trim());
      }
      continue;
    }
    if (op.op === 'inject_vision_summary') {
      const summary =
        typeof (op as { summary?: unknown }).summary === 'string' ? String((op as { summary: string }).summary) : '';
      if (summary.trim().length) {
        messages = injectVisionSummaryIntoMessages(messages, summary.trim());
      }
      continue;
    }
  }

  return {
    model: followupModel,
    messages,
    ...(tools ? { tools } : {}),
    ...(parameters ? { parameters } : {})
  } as JsonObject;
}
