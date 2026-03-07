import { Readable } from 'node:stream';

import { AnthropicMessagesLanguageModel } from '@ai-sdk/anthropic/internal';
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

import { stripInternalKeysDeep } from '../../../../utils/strip-internal-keys.js';
import type { UnknownObject } from '../../../../types/common-types.js';
import type { ProviderContext } from '../../api/provider-types.js';
import type { PreparedHttpRequest } from '../http-request-executor.js';

type UnknownRecord = Record<string, unknown>;
type AnthropicProviderOptions = Record<string, unknown>;

type ToolNameIndex = Map<string, string>;

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function pickString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function pickNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function pickBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

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

function convertToolResultOutput(
  content: unknown,
  isError: boolean
): LanguageModelV3ToolResultOutput {
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

function convertProviderOptions(rawBody: UnknownRecord): AnthropicProviderOptions | undefined {
  const thinking = asRecord(rawBody.thinking);
  const outputConfig = asRecord(rawBody.output_config ?? rawBody.outputConfig);
  const providerOptions: AnthropicProviderOptions = {};

  const thinkingType = pickString(thinking.type);
  if (thinkingType === 'adaptive') {
    providerOptions.thinking = { type: 'adaptive' };
  } else if (thinkingType === 'enabled') {
    providerOptions.thinking = {
      type: 'enabled',
      ...(pickNumber(thinking.budget_tokens ?? thinking.budgetTokens) !== undefined
        ? { budgetTokens: pickNumber(thinking.budget_tokens ?? thinking.budgetTokens) }
        : {})
    };
  } else if (thinkingType === 'disabled') {
    providerOptions.thinking = { type: 'disabled' };
  }

  const effort = pickString(outputConfig.effort);
  if (effort && ['low', 'medium', 'high', 'max'].includes(effort)) {
    providerOptions.effort = effort;
  }

  const speed = pickString(rawBody.speed);
  if (speed && ['fast', 'standard'].includes(speed)) {
    providerOptions.speed = speed;
  }

  const disableParallelToolUse = pickBoolean(
    rawBody.disable_parallel_tool_use ?? rawBody.disableParallelToolUse ?? asRecord(rawBody.tool_choice).disable_parallel_tool_use
  );
  if (disableParallelToolUse !== undefined) {
    providerOptions.disableParallelToolUse = disableParallelToolUse;
  }

  const container = rawBody.container;
  if (typeof container === 'string') {
    providerOptions.container = { id: container };
  } else if (container && typeof container === 'object' && !Array.isArray(container)) {
    const containerBag = asRecord(container);
    const id = pickString(containerBag.id);
    const skills = asArray(containerBag.skills)
      .map((entry) => asRecord(entry))
      .map((entry) => {
        const type = pickString(entry.type);
        const skillId = pickString(entry.skill_id ?? entry.skillId);
        if (!type || !skillId) {
          return null;
        }
        return {
          type: type === 'custom' ? 'custom' : 'anthropic',
          skillId,
          ...(pickString(entry.version) ? { version: pickString(entry.version) } : {})
        };
      })
      .filter(Boolean);
    if (id || skills.length > 0) {
      providerOptions.container = {
        ...(id ? { id } : {}),
        ...(skills.length > 0 ? { skills: skills as Array<Record<string, unknown>> } : {})
      };
    }
  }

  const mcpServers = asArray(rawBody.mcp_servers ?? rawBody.mcpServers)
    .map((entry) => asRecord(entry))
    .map((entry) => {
      const type = pickString(entry.type);
      const name = pickString(entry.name);
      const url = pickString(entry.url);
      if (type !== 'url' || !name || !url) {
        return null;
      }
      const toolConfiguration = asRecord(entry.tool_configuration ?? entry.toolConfiguration);
      return {
        type: 'url' as const,
        name,
        url,
        authorizationToken: pickString(entry.authorization_token ?? entry.authorizationToken) ?? null,
        ...(Object.keys(toolConfiguration).length > 0
          ? {
              toolConfiguration: {
                ...(pickBoolean(toolConfiguration.enabled) !== undefined
                  ? { enabled: pickBoolean(toolConfiguration.enabled) }
                  : {}),
                ...(Array.isArray(toolConfiguration.allowed_tools ?? toolConfiguration.allowedTools)
                  ? { allowedTools: asArray(toolConfiguration.allowed_tools ?? toolConfiguration.allowedTools).map(String) }
                  : {})
              }
            }
          : {})
      };
    })
    .filter(Boolean);
  if (mcpServers.length > 0) {
    providerOptions.mcpServers = mcpServers;
  }

  const contextManagement = asRecord(rawBody.context_management ?? rawBody.contextManagement);
  const edits = asArray(contextManagement.edits)
    .map((entry) => asRecord(entry))
    .map((entry) => {
      const type = pickString(entry.type);
      if (!type) {
        return null;
      }
      if (type === 'clear_tool_uses_20250919') {
        return {
          type,
          ...(entry.trigger && typeof entry.trigger === 'object' ? { trigger: entry.trigger } : {}),
          ...(entry.keep && typeof entry.keep === 'object' ? { keep: entry.keep } : {}),
          ...(entry.clear_at_least && typeof entry.clear_at_least === 'object'
            ? { clearAtLeast: entry.clear_at_least }
            : entry.clearAtLeast && typeof entry.clearAtLeast === 'object'
              ? { clearAtLeast: entry.clearAtLeast }
              : {}),
          ...(pickBoolean(entry.clear_tool_inputs ?? entry.clearToolInputs) !== undefined
            ? { clearToolInputs: pickBoolean(entry.clear_tool_inputs ?? entry.clearToolInputs) }
            : {}),
          ...(Array.isArray(entry.exclude_tools ?? entry.excludeTools)
            ? { excludeTools: asArray(entry.exclude_tools ?? entry.excludeTools).map(String) }
            : {})
        };
      }
      if (type === 'clear_thinking_20251015') {
        return {
          type,
          ...(entry.keep !== undefined ? { keep: entry.keep } : {})
        };
      }
      if (type === 'compact_20260112') {
        return {
          type,
          ...(entry.trigger && typeof entry.trigger === 'object' ? { trigger: entry.trigger } : {}),
          ...(pickBoolean(entry.pause_after_compaction ?? entry.pauseAfterCompaction) !== undefined
            ? { pauseAfterCompaction: pickBoolean(entry.pause_after_compaction ?? entry.pauseAfterCompaction) }
            : {}),
          ...(pickString(entry.instructions) ? { instructions: pickString(entry.instructions) } : {})
        };
      }
      return null;
    })
    .filter(Boolean);
  if (edits.length > 0) {
    providerOptions.contextManagement = { edits };
  }

  return Object.keys(providerOptions).length ? providerOptions : undefined;
}

function convertResponseFormat(rawBody: UnknownRecord): LanguageModelV3CallOptions['responseFormat'] | undefined {
  const outputConfig = asRecord(rawBody.output_config ?? rawBody.outputConfig);
  const format = asRecord(outputConfig.format);
  const type = pickString(format.type)?.toLowerCase();
  if (type !== 'json_schema') {
    return undefined;
  }
  const schema = format.schema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return undefined;
  }
  return {
    type: 'json',
    schema: schema as Record<string, unknown>,
    ...(pickString(format.name) ? { name: pickString(format.name) } : {}),
    ...(pickString(format.description) ? { description: pickString(format.description) } : {})
  };
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
    responseFormat: convertResponseFormat(body),
    providerOptions: (() => {
      const anthropic = convertProviderOptions(body);
      return anthropic
        ? ({ anthropic } as unknown as LanguageModelV3CallOptions['providerOptions'])
        : undefined;
    })()
  };
}

function mergePreservedRequestFields(rawBody: UnknownRecord, builtBody: UnknownRecord): UnknownRecord {
  const next = { ...builtBody };
  const metadata = rawBody.metadata;
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    next.metadata = stripInternalKeysDeep(metadata as UnknownRecord);
  }
  return next;
}

function buildSyntheticAnthropicMessage(rawBody: UnknownRecord, result: UnknownRecord): UnknownObject {
  return {
    id: (result.response as UnknownRecord | undefined)?.id ?? `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: pickString(rawBody.model) ?? 'unknown',
    content: [],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 0,
      output_tokens: 0
    }
  };
}

function responseHeadersToRecord(headers: unknown): Record<string, string> | undefined {
  if (!headers || typeof headers !== 'object') {
    return undefined;
  }
  const entries = Object.entries(headers as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  if (!entries.length) {
    return undefined;
  }
  return Object.fromEntries(entries);
}

function buildHttpError(status: number, responseText: string): Error & {
  statusCode: number;
  status: number;
  response: { status: number; data: { error: { message: string; code: string } } };
} {
  const error = new Error(`HTTP ${status}: ${responseText}`) as Error & {
    statusCode: number;
    status: number;
    response: { status: number; data: { error: { message: string; code: string } } };
  };
  error.statusCode = status;
  error.status = status;
  error.response = {
    status,
    data: {
      error: {
        message: responseText,
        code: `HTTP_${status}`
      }
    }
  };
  return error;
}

function buildInvalidJsonError(responseText: string): Error & {
  statusCode: number;
  status: number;
  response: { status: number; data: { error: { message: string; code: string } } };
} {
  const error = new Error('Invalid JSON response') as Error & {
    statusCode: number;
    status: number;
    response: { status: number; data: { error: { message: string; code: string } } };
  };
  error.statusCode = 200;
  error.status = 200;
  error.response = {
    status: 200,
    data: {
      error: {
        message: responseText,
        code: 'HTTP_200'
      }
    }
  };
  return error;
}

export class VercelAiSdkAnthropicTransport {
  async executePreparedRequest(
    requestInfo: PreparedHttpRequest,
    _context: ProviderContext
  ): Promise<unknown> {
    const rawBody = asRecord(requestInfo.body);
    const modelId = pickString(rawBody.model);
    if (!modelId) {
      throw new Error('provider-runtime-error: missing model from anthropic sdk transport');
    }

    const model = new AnthropicMessagesLanguageModel(modelId, {
      provider: 'anthropic.messages',
      baseURL: requestInfo.targetUrl,
      headers: () => ({}),
      buildRequestUrl: () => requestInfo.targetUrl,
      transformRequestBody: (body: Record<string, unknown>) => mergePreservedRequestFields(rawBody, body)
    } as never) as any;

    const callOptions = buildAnthropicSdkCallOptions(rawBody, requestInfo.headers);
    const argsResult = await model.getArgs({
      ...callOptions,
      stream: requestInfo.wantsSse,
      userSuppliedBetas: await model.getBetasFromHeaders(callOptions.headers)
    });
    const args = asRecord(argsResult.args);
    const betas = argsResult.betas instanceof Set ? argsResult.betas : new Set<string>();
    const url = model.buildRequestUrl(requestInfo.wantsSse);
    const headers = await model.getHeaders({ betas, headers: callOptions.headers });
    const body = model.transformRequestBody(args, betas);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw buildHttpError(response.status, await response.text());
    }

    const responseHeaders = responseHeadersToRecord(Object.fromEntries(response.headers.entries()));
    if (requestInfo.wantsSse) {
      if (!response.body) {
        throw buildHttpError(502, 'missing upstream SSE body');
      }
      return {
        __sse_responses: Readable.fromWeb(response.body as never),
        ...(responseHeaders ? { headers: responseHeaders } : {})
      };
    }

    const responseText = await response.text();
    let responseBody: UnknownObject;
    try {
      responseBody = JSON.parse(responseText) as UnknownObject;
    } catch {
      throw buildInvalidJsonError(responseText);
    }
    return {
      data: responseBody,
      status: response.status,
      ...(responseHeaders ? { headers: responseHeaders } : {})
    };
  }
}
