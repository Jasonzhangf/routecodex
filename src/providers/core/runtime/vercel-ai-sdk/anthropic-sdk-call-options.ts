import type {
  LanguageModelV3CallOptions,
  LanguageModelV3FilePart,
  LanguageModelV3FunctionTool,
  LanguageModelV3Message,
  LanguageModelV3Prompt,
  LanguageModelV3TextPart,
  LanguageModelV3ToolChoice,
  LanguageModelV3ToolResultOutput
} from '@ai-sdk/provider';

import {
  asArray,
  asRecord,
  pickBoolean,
  pickNumber,
  pickString,
  type UnknownRecord
} from './anthropic-sdk-transport-shared.js';
import {
  convertAnthropicProviderOptions,
  convertAnthropicResponseFormat
} from './anthropic-sdk-provider-options.js';

type ToolNameIndex = Map<string, string>;

function normalizeToolChoice(value: unknown): LanguageModelV3ToolChoice | undefined {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return undefined;
    }
    if (normalized === 'auto') {
      return { type: 'auto' };
    }
    if (normalized === 'none') {
      return { type: 'none' };
    }
    if (normalized === 'any' || normalized === 'required') {
      return { type: 'required' };
    }
    return { type: 'tool', toolName: value.trim() };
  }

  const record = asRecord(value);
  const type = pickString(record.type)?.toLowerCase();
  if (!type) {
    return undefined;
  }
  if (type === 'auto') {
    return { type: 'auto' };
  }
  if (type === 'none') {
    return { type: 'none' };
  }
  if (type === 'any' || type === 'required') {
    return { type: 'required' };
  }
  if (type === 'tool') {
    const toolName = pickString(record.name ?? record.toolName);
    return toolName ? { type: 'tool', toolName } : undefined;
  }
  return { type: 'tool', toolName: type };
}

function buildToolNameIndex(messages: unknown[]): ToolNameIndex {
  const index = new Map<string, string>();
  for (const message of messages) {
    const bag = asRecord(message);
    for (const block of asArray(bag.content)) {
      const item = asRecord(block);
      const type = pickString(item.type)?.toLowerCase();
      if (type !== 'tool_use' && type !== 'server_tool_use') {
        continue;
      }
      const toolId = pickString(item.id);
      const toolName = pickString(item.name);
      if (toolId && toolName) {
        index.set(toolId, toolName);
      }
    }
  }
  return index;
}

function toDataContent(source: UnknownRecord): { data: string | URL; mediaType: string; filename?: string } | null {
  const sourceType = pickString(source.type)?.toLowerCase();
  if (!sourceType) {
    return null;
  }
  const mediaType = pickString(source.media_type ?? source.mediaType) ?? 'application/octet-stream';
  const filename = pickString(source.filename ?? source.name);
  if (sourceType === 'base64') {
    const data = pickString(source.data);
    if (!data) {
      return null;
    }
    return { data, mediaType, ...(filename ? { filename } : {}) };
  }
  if (sourceType === 'url') {
    const url = pickString(source.url);
    if (!url) {
      return null;
    }
    return { data: new URL(url), mediaType, ...(filename ? { filename } : {}) };
  }
  return null;
}

function toFilePart(block: UnknownRecord): LanguageModelV3FilePart | null {
  const source = asRecord(block.source);
  const normalized = toDataContent(source);
  if (!normalized) {
    return null;
  }
  return {
    type: 'file',
    data: normalized.data,
    mediaType: normalized.mediaType,
    ...(normalized.filename ? { filename: normalized.filename } : {})
  };
}

function toTextPart(text: string): LanguageModelV3TextPart {
  return { type: 'text', text };
}

function convertToolResultOutput(content: unknown, isError: boolean): LanguageModelV3ToolResultOutput {
  if (typeof content === 'string') {
    return isError
      ? { type: 'error-text', value: content }
      : { type: 'text', value: content };
  }

  if (Array.isArray(content)) {
    const value: Array<Record<string, unknown>> = [];
    for (const block of content) {
      const item = asRecord(block);
      const type = pickString(item.type)?.toLowerCase();
      if (type === 'text') {
        const text = pickString(item.text);
        if (text) {
          value.push({ type: 'text', text });
        }
        continue;
      }
      if (type === 'image') {
        const source = toDataContent(asRecord(item.source));
        if (!source) {
          continue;
        }
        if (typeof source.data === 'string') {
          value.push({ type: 'image-data', data: source.data, mediaType: source.mediaType });
        } else {
          value.push({ type: 'image-url', url: source.data.toString() });
        }
        continue;
      }
      if (type === 'document') {
        const source = toDataContent(asRecord(item.source));
        if (!source) {
          continue;
        }
        if (typeof source.data === 'string') {
          value.push({
            type: 'file-data',
            data: source.data,
            mediaType: source.mediaType,
            ...(source.filename ? { filename: source.filename } : {})
          });
        } else {
          value.push({ type: 'file-url', url: source.data.toString() });
        }
      }
    }
    if (value.length > 0) {
      return { type: 'content', value: value as any };
    }
  }

  if (content && typeof content === 'object') {
    return isError
      ? { type: 'error-json', value: content as any }
      : { type: 'json', value: content as any };
  }

  const fallback = content == null ? '' : String(content);
  return isError
    ? { type: 'error-text', value: fallback }
    : { type: 'text', value: fallback };
}

function convertMessageContent(
  role: string,
  content: unknown,
  toolNameIndex: ToolNameIndex
): { role: 'system' | 'user' | 'assistant' | 'tool'; content: unknown }[] {
  if (role === 'system') {
    if (typeof content === 'string') {
      return [{ role: 'system', content }];
    }
    const parts = asArray(content)
      .map((block) => pickString(asRecord(block).text))
      .filter((value): value is string => Boolean(value));
    return parts.length ? [{ role: 'system', content: parts.join('\n') }] : [];
  }

  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : asArray(content);
  const assistantParts: unknown[] = [];
  const userParts: Array<LanguageModelV3TextPart | LanguageModelV3FilePart> = [];
  const toolParts: unknown[] = [];

  for (const block of blocks) {
    const item = asRecord(block);
    const type = pickString(item.type)?.toLowerCase();
    if (!type) {
      continue;
    }
    if (type === 'text') {
      const text = pickString(item.text);
      if (!text) {
        continue;
      }
      if (role === 'assistant') {
        assistantParts.push({ type: 'text', text });
      } else {
        userParts.push(toTextPart(text));
      }
      continue;
    }
    if (type === 'image' || type === 'document') {
      const filePart = toFilePart(item);
      if (!filePart) {
        continue;
      }
      if (role === 'assistant') {
        assistantParts.push(filePart);
      } else {
        userParts.push(filePart);
      }
      continue;
    }
    if (type === 'thinking') {
      if (role === 'assistant') {
        assistantParts.push({
          type: 'reasoning',
          text: pickString(item.thinking) ?? '',
          providerOptions: item.signature
            ? { anthropic: { signature: item.signature } }
            : undefined
        });
      }
      continue;
    }
    if (type === 'redacted_thinking') {
      if (role === 'assistant') {
        assistantParts.push({
          type: 'reasoning',
          text: '',
          providerOptions: { anthropic: { redactedData: pickString(item.data) ?? '' } }
        });
      }
      continue;
    }
    if (type === 'tool_use' || type === 'server_tool_use') {
      const toolCallId = pickString(item.id);
      const toolName = pickString(item.name);
      if (!toolCallId || !toolName) {
        continue;
      }
      assistantParts.push({
        type: 'tool-call',
        toolCallId,
        toolName,
        input: item.input ?? {},
        providerExecuted: pickBoolean(item.provider_executed ?? item.providerExecuted)
      });
      continue;
    }
    if (type === 'tool_result') {
      const toolCallId = pickString(item.tool_use_id ?? item.toolCallId);
      if (!toolCallId) {
        continue;
      }
      toolParts.push({
        type: 'tool-result',
        toolCallId,
        toolName: toolNameIndex.get(toolCallId) ?? 'tool',
        output: convertToolResultOutput(item.content, item.is_error === true)
      });
    }
  }

  const output: { role: 'system' | 'user' | 'assistant' | 'tool'; content: unknown }[] = [];
  if (toolParts.length > 0) {
    output.push({ role: 'tool', content: toolParts });
  }
  if (role === 'assistant' && assistantParts.length > 0) {
    output.push({ role: 'assistant', content: assistantParts });
  }
  if (role !== 'assistant' && userParts.length > 0) {
    output.push({ role: 'user', content: userParts });
  }
  return output;
}

function convertPrompt(rawBody: UnknownRecord): LanguageModelV3Prompt {
  const prompt: LanguageModelV3Prompt = [];
  const toolNameIndex = buildToolNameIndex(asArray(rawBody.messages));

  const system = rawBody.system;
  if (typeof system === 'string') {
    prompt.push({ role: 'system', content: system });
  } else if (Array.isArray(system)) {
    const text = system
      .map((block) => pickString(asRecord(block).text))
      .filter((value): value is string => Boolean(value))
      .join('\n');
    if (text) {
      prompt.push({ role: 'system', content: text });
    }
  }

  for (const message of asArray(rawBody.messages)) {
    const bag = asRecord(message);
    const role = pickString(bag.role)?.toLowerCase();
    if (!role) {
      continue;
    }
    for (const converted of convertMessageContent(role, bag.content, toolNameIndex)) {
      prompt.push(converted as LanguageModelV3Message);
    }
  }

  return prompt;
}

function convertTools(rawBody: UnknownRecord): LanguageModelV3FunctionTool[] | undefined {
  const tools = asArray(rawBody.tools)
    .map((entry) => asRecord(entry))
    .map((tool) => {
      const name = pickString(tool.name);
      if (!name) {
        return null;
      }
      return {
        type: 'function' as const,
        name,
        ...(pickString(tool.description) ? { description: pickString(tool.description) } : {}),
        inputSchema: (tool.input_schema ?? tool.inputSchema ?? {}) as Record<string, unknown>
      } as unknown as LanguageModelV3FunctionTool;
    })
    .filter((tool): tool is LanguageModelV3FunctionTool => tool !== null);
  return tools.length ? tools : undefined;
}

export function buildAnthropicSdkCallOptions(
  body: UnknownRecord,
  requestHeaders: Record<string, string>
): LanguageModelV3CallOptions {
  return {
    prompt: convertPrompt(body),
    headers: requestHeaders,
    maxOutputTokens: pickNumber(body.max_tokens ?? body.maxTokens),
    temperature: pickNumber(body.temperature),
    topP: pickNumber(body.top_p ?? body.topP),
    topK: pickNumber(body.top_k ?? body.topK),
    stopSequences: asArray(body.stop_sequences ?? body.stopSequences).map(String),
    tools: convertTools(body),
    toolChoice: normalizeToolChoice(body.tool_choice ?? body.toolChoice),
    responseFormat: convertAnthropicResponseFormat(body),
    providerOptions: (() => {
      const anthropic = convertAnthropicProviderOptions(body);
      return anthropic
        ? ({ anthropic } as unknown as LanguageModelV3CallOptions['providerOptions'])
        : undefined;
    })()
  };
}
