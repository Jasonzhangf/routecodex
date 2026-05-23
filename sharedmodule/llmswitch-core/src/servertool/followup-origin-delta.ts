import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject, JsonValue } from '../conversion/hub/types/json.js';
import type { ServerToolFollowupInjectionOp, ServerToolFollowupInjectionPlan } from './types.js';
import { loadOriginSnapshot } from './origin-request-store.js';
import { extractCapturedToolOutputs } from '../conversion/hub/operation-table/semantic-mappers/responses-submit-tool-outputs.js';
import { dropToolByFunctionName, extractCapturedChatSeed } from './followup-seed.js';
import { resolveServertoolPersistentScopeKey } from './state-scope.js';

export type FollowupOriginSeed = {
  model?: string;
  messages: JsonObject[];
  tools?: JsonObject[];
  parameters?: Record<string, unknown>;
};

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readTextPart(entry: unknown): string {
  const record = asRecord(entry);
  if (!record) {
    return '';
  }
  if (typeof record.text === 'string') {
    return record.text;
  }
  if (typeof record.output_text === 'string') {
    return record.output_text;
  }
  return '';
}

export function extractAssistantFollowupMessage(finalChatResponse: JsonObject): JsonObject | null {
  const record = finalChatResponse as Record<string, unknown>;
  const choices = Array.isArray(record.choices) ? (record.choices as Array<Record<string, unknown>>) : [];
  const firstChoice =
    choices[0] && typeof choices[0] === 'object' && !Array.isArray(choices[0]) ? choices[0] : undefined;
  const choiceMessage =
    firstChoice?.message && typeof firstChoice.message === 'object' && !Array.isArray(firstChoice.message)
      ? (firstChoice.message as Record<string, unknown>)
      : undefined;
  if (choiceMessage && typeof choiceMessage.role === 'string') {
    return cloneJson(choiceMessage as unknown as JsonObject);
  }

  const output = Array.isArray(record.output) ? (record.output as Array<Record<string, unknown>>) : [];
  const assistantOutput = output.find((item) => item && typeof item === 'object' && item.role === 'assistant');
  if (!assistantOutput) {
    return null;
  }
  const content = Array.isArray(assistantOutput.content) ? assistantOutput.content : [];
  const textParts = content.map(readTextPart).filter((entry) => entry.trim().length > 0);
  if (textParts.length > 0) {
    return { role: 'assistant', content: textParts.join('') };
  }
  return null;
}

export function loadFollowupOriginSeed(adapterContext: AdapterContext): FollowupOriginSeed | null {
  const record = asRecord(adapterContext);
  const captured = record?.capturedChatRequest;
  const directSeed = extractCapturedChatSeed(captured);
  if (directSeed && Array.isArray(directSeed.messages) && directSeed.messages.length > 0) {
    return {
      ...(directSeed.model ? { model: directSeed.model } : {}),
      messages: cloneJson(directSeed.messages),
      ...(directSeed.tools ? { tools: cloneJson(directSeed.tools) } : {}),
      ...(directSeed.parameters ? { parameters: cloneJson(directSeed.parameters) } : {})
    };
  }
  const scope = resolveServertoolPersistentScopeKey(adapterContext);
  if (!scope) {
    return null;
  }
  const snapshot = loadOriginSnapshot(scope);
  if (!snapshot) {
    return null;
  }
  if (snapshot.capturedChatRequest) {
    const rebuilt = extractCapturedChatSeed(snapshot.capturedChatRequest);
    if (rebuilt && Array.isArray(rebuilt.messages) && rebuilt.messages.length > 0) {
      return {
        ...(rebuilt.model ? { model: rebuilt.model } : {}),
        messages: cloneJson(rebuilt.messages),
        ...(rebuilt.tools ? { tools: cloneJson(rebuilt.tools) } : {}),
        ...(rebuilt.parameters ? { parameters: cloneJson(rebuilt.parameters) } : {})
      };
    }
  }
  if (!Array.isArray(snapshot.messages) || snapshot.messages.length === 0) {
    return null;
  }
  return {
    ...(typeof snapshot.model === 'string' && snapshot.model.trim() ? { model: snapshot.model.trim() } : {}),
    messages: cloneJson(snapshot.messages),
    ...(Array.isArray(snapshot.tools) ? { tools: cloneJson(snapshot.tools) } : {}),
    ...(snapshot.parameters ? { parameters: cloneJson(snapshot.parameters as Record<string, unknown>) } : {})
  };
}

function appendUserText(messages: JsonObject[], text: string): void {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  messages.push({ role: 'user', content: trimmed });
}

function injectSystemText(messages: JsonObject[], text: string): void {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  messages.push({ role: 'system', content: trimmed });
}

function appendAssistantMessage(messages: JsonObject[], finalChatResponse: JsonObject, required?: boolean): boolean {
  const message = extractAssistantFollowupMessage(finalChatResponse);
  if (!message) {
    return required !== true;
  }
  messages.push(message);
  return true;
}

function extractChatToolOutputs(finalChatResponse: JsonObject): Array<{ tool_call_id?: string; name?: string; arguments?: string; output: unknown }> {
  const outputs = Array.isArray((finalChatResponse as Record<string, unknown>).tool_outputs)
    ? ((finalChatResponse as Record<string, unknown>).tool_outputs as unknown[])
    : [];
  const out: Array<{ tool_call_id?: string; name?: string; arguments?: string; output: unknown }> = [];
  for (const entry of outputs) {
    const record = asRecord(entry);
    if (!record) continue;
    const toolCallId = typeof record.tool_call_id === 'string' && record.tool_call_id.trim()
      ? record.tool_call_id.trim()
      : undefined;
    const content = Object.prototype.hasOwnProperty.call(record, 'content') ? record.content : record.output;
    const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : undefined;
    const argumentsText = typeof record.arguments === 'string' ? record.arguments : undefined;
    out.push({
      ...(toolCallId ? { tool_call_id: toolCallId } : {}),
      ...(name ? { name } : {}),
      ...(argumentsText !== undefined ? { arguments: argumentsText } : {}),
      output: content
    });
  }
  return out;
}

function appendToolMessagesFromToolOutputs(messages: JsonObject[], adapterContext: AdapterContext, finalChatResponse: JsonObject, required?: boolean): boolean {
  const record = asRecord(adapterContext);
  const responsesContext = asRecord(record?.responsesContext) as any;
  const outputsFromResponses = extractCapturedToolOutputs(responsesContext);
  const chatOutputs = outputsFromResponses.length ? [] : extractChatToolOutputs(finalChatResponse);
  const outputs = outputsFromResponses.length ? outputsFromResponses : chatOutputs;
  if (!outputs.length) {
    return required !== true;
  }
  if (chatOutputs.length) {
    const toolCalls = chatOutputs
      .map((entry) => {
        const toolCallId = typeof entry.tool_call_id === 'string' && entry.tool_call_id.trim() ? entry.tool_call_id.trim() : '';
        const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : 'tool';
        if (!toolCallId) return null;
        return {
          id: toolCallId,
          type: 'function',
          function: {
            name,
            arguments: typeof entry.arguments === 'string' ? entry.arguments : '{}'
          }
        } as JsonObject;
      })
      .filter((entry): entry is JsonObject => Boolean(entry));
    if (toolCalls.length) {
      messages.push({ role: 'assistant', content: null, tool_calls: toolCalls } as JsonObject);
    }
  }
  for (const entry of outputs) {
    const toolCallId = typeof entry.tool_call_id === 'string' && entry.tool_call_id.trim() ? entry.tool_call_id.trim() : undefined;
    messages.push({
      role: 'tool',
      ...(toolCallId ? { tool_call_id: toolCallId } : {}),
      content: typeof entry.output === 'string' ? entry.output : JSON.stringify(entry.output ?? '')
    });
  }
  return true;
}

function compactToolContent(messages: JsonObject[], maxChars: number): void {
  const safeMax = Math.max(1, Math.floor(maxChars));
  for (const message of messages) {
    const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
    if (role !== 'tool') {
      continue;
    }
    if (typeof message.content === 'string' && message.content.length > safeMax) {
      message.content = `${message.content.slice(0, safeMax)}…`;
    }
  }
}

function trimOpenAiMessages(messages: JsonObject[], maxNonSystemMessages: number): JsonObject[] {
  const safeMax = Math.max(1, Math.floor(maxNonSystemMessages));
  const systemMessages = messages.filter((message) => String(message.role || '').trim().toLowerCase() === 'system');
  const nonSystemMessages = messages.filter((message) => String(message.role || '').trim().toLowerCase() !== 'system');
  if (nonSystemMessages.length <= safeMax) {
    return messages;
  }
  return [...systemMessages, ...nonSystemMessages.slice(nonSystemMessages.length - safeMax)];
}

function appendToolIfMissing(tools: JsonObject[] | undefined, toolName: string, toolDefinition: JsonObject): JsonObject[] {
  const name = toolName.trim();
  const next = Array.isArray(tools) ? cloneJson(tools) : [];
  const exists = next.some((tool) => {
    const fn = asRecord(tool.function);
    const current = typeof fn?.name === 'string' ? fn.name.trim() : (typeof tool.name === 'string' ? tool.name.trim() : '');
    return current === name;
  });
  if (!exists) {
    next.push(cloneJson(toolDefinition));
  }
  return next;
}

function rebuildVisionFollowup(messages: JsonObject[], summary: string, originalPrompt?: string): JsonObject[] {
  const next = messages.filter((message) => String(message.role || '').trim().toLowerCase() === 'system');
  if (originalPrompt && originalPrompt.trim()) {
    next.push({ role: 'user', content: originalPrompt.trim() });
  }
  next.push({ role: 'user', content: summary.trim() });
  return next;
}

function applySingleDeltaOp(args: {
  op: ServerToolFollowupInjectionOp;
  payload: JsonObject;
  adapterContext: AdapterContext;
  finalChatResponse: JsonObject;
}): boolean {
  const payloadRecord = args.payload as Record<string, unknown>;
  const messages = Array.isArray(payloadRecord.messages) ? (payloadRecord.messages as JsonObject[]) : [];
  switch (args.op.op) {
    case 'append_assistant_message':
      return appendAssistantMessage(messages, args.finalChatResponse, args.op.required);
    case 'append_tool_messages_from_tool_outputs':
      return appendToolMessagesFromToolOutputs(messages, args.adapterContext, args.finalChatResponse, args.op.required);
    case 'append_user_text':
      appendUserText(messages, args.op.text);
      return true;
    case 'inject_system_text':
      injectSystemText(messages, args.op.text);
      return true;
    case 'preserve_tools':
      return true;
    case 'ensure_standard_tools':
      return true;
    case 'replace_tools':
      payloadRecord.tools = cloneJson(args.op.tools);
      return true;
    case 'force_tool_choice':
      payloadRecord.tool_choice = cloneJson(args.op.value as JsonValue);
      return true;
    case 'drop_tool_by_name':
      if (Array.isArray(payloadRecord.tools)) {
        payloadRecord.tools = dropToolByFunctionName(payloadRecord.tools as JsonObject[], args.op.name) ?? [];
      }
      return true;
    case 'inject_vision_summary':
      appendUserText(messages, args.op.summary);
      return true;
    case 'rebuild_vision_followup':
      payloadRecord.messages = rebuildVisionFollowup(messages, args.op.summary, args.op.originalPrompt);
      return true;
    case 'trim_openai_messages':
      payloadRecord.messages = trimOpenAiMessages(messages, args.op.maxNonSystemMessages);
      return true;
    case 'append_tool_if_missing':
      payloadRecord.tools = appendToolIfMissing(
        Array.isArray(payloadRecord.tools) ? (payloadRecord.tools as JsonObject[]) : undefined,
        args.op.toolName,
        args.op.toolDefinition
      );
      return true;
    case 'compact_tool_content':
      compactToolContent(messages, args.op.maxChars);
      return true;
    default:
      return true;
  }
}

export function applyFollowupDeltaPlan(args: {
  adapterContext: AdapterContext;
  finalChatResponse: JsonObject;
  seed: FollowupOriginSeed;
  injection: ServerToolFollowupInjectionPlan;
}): JsonObject | null {
  const payload: JsonObject = {
    messages: cloneJson(args.seed.messages)
  };
  if (args.seed.model) {
    payload.model = args.seed.model;
  }
  if (Array.isArray(args.seed.tools) && args.seed.tools.length > 0) {
    payload.tools = cloneJson(args.seed.tools);
  }
  if (args.seed.parameters && typeof args.seed.parameters === 'object') {
    payload.parameters = cloneJson(args.seed.parameters) as unknown as JsonObject;
  }
  const ops = Array.isArray(args.injection.ops) ? args.injection.ops : [];
  for (const op of ops) {
    if (!applySingleDeltaOp({
      op,
      payload,
      adapterContext: args.adapterContext,
      finalChatResponse: args.finalChatResponse
    })) {
      return null;
    }
  }
  return payload;
}
