import { Readable } from 'node:stream';

import { OpenAIChatLanguageModel } from '@ai-sdk/openai/internal';
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

type OpenAiProviderOptions = Record<string, unknown>;

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
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function pickBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function isOpenCodeZenProvider(context: ProviderContext): boolean {
  const providerId = pickString(context.providerId)?.toLowerCase();
  if (!providerId) {
    return false;
  }
  return providerId === 'opencode-zen' || providerId === 'opencode-zen-free' || providerId.startsWith('opencode-zen-');
}

function hasEnableThinkingFlag(body: UnknownRecord): boolean {
  if (body.enable_thinking !== undefined || body.enableThinking !== undefined) {
    return true;
  }
  const chatTemplateArgs = asRecord(body.chat_template_args ?? body.chatTemplateArgs);
  return chatTemplateArgs.enable_thinking !== undefined || chatTemplateArgs.enableThinking !== undefined;
}

export function applyOpenCodeZenThinkingDefaults(body: UnknownRecord, context: ProviderContext): UnknownRecord {
  if (!isOpenCodeZenProvider(context)) {
    return body;
  }
  if (hasEnableThinkingFlag(body)) {
    return body;
  }
  return {
    ...body,
    enable_thinking: true
  };
}

function toTextPart(text: string): LanguageModelV3TextPart {
  return { type: 'text', text };
}

function parseDataUrl(value: string): { mediaType: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/i.exec(value);
  if (!match) {
    return null;
  }
  return {
    mediaType: match[1] || 'application/octet-stream',
    data: match[2] || ''
  };
}

function toOpenAiFilePartFromImage(item: UnknownRecord): LanguageModelV3FilePart | null {
  const imageUrlNode = asRecord(item.image_url ?? item.imageUrl);
  const url = pickString(imageUrlNode.url ?? item.url);
  if (!url) {
    return null;
  }
  const detail = pickString(imageUrlNode.detail ?? item.detail);
  const dataUrl = parseDataUrl(url);
  const providerOptions = detail
    ? ({ openai: { imageDetail: detail } } as Record<string, unknown>)
    : undefined;
  if (dataUrl) {
    return {
      type: 'file',
      data: dataUrl.data,
      mediaType: dataUrl.mediaType,
      ...(providerOptions ? { providerOptions } : {})
    } as LanguageModelV3FilePart;
  }
  return {
    type: 'file',
    data: new URL(url),
    mediaType: 'image/*',
    ...(providerOptions ? { providerOptions } : {})
  } as LanguageModelV3FilePart;
}

function toOpenAiFilePartFromFile(item: UnknownRecord): LanguageModelV3FilePart | null {
  const file = asRecord(item.file);
  const fileId = pickString(file.file_id ?? file.fileId);
  if (fileId) {
    return {
      type: 'file',
      data: fileId,
      mediaType: 'application/pdf',
      filename: pickString(file.filename) ?? 'file.pdf'
    };
  }

  const fileData = pickString(file.file_data ?? file.fileData);
  if (!fileData) {
    return null;
  }
  const dataUrl = parseDataUrl(fileData);
  if (!dataUrl) {
    return null;
  }
  return {
    type: 'file',
    data: dataUrl.data,
    mediaType: dataUrl.mediaType,
    filename: pickString(file.filename) ?? 'file.bin'
  };
}

function parseToolArguments(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value ?? {};
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
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
    if (normalized === 'required' || normalized === 'any') {
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
  if (type === 'required' || type === 'any') {
    return { type: 'required' };
  }
  if (type === 'function' || type === 'tool') {
    const fn = asRecord(record.function);
    const toolName = pickString(fn.name ?? record.name ?? record.toolName);
    return toolName ? { type: 'tool', toolName } : undefined;
  }
  return undefined;
}

function convertToolResultOutput(content: unknown): LanguageModelV3ToolResultOutput {
  if (typeof content === 'string') {
    return { type: 'text', value: content };
  }

  if (Array.isArray(content)) {
    const textChunks = content
      .map((part) => {
        const item = asRecord(part);
        return pickString(item.text ?? item.content);
      })
      .filter((value): value is string => Boolean(value));
    if (textChunks.length > 0) {
      return { type: 'text', value: textChunks.join('\n') };
    }
    return { type: 'json', value: content as any };
  }

  if (content && typeof content === 'object') {
    return { type: 'json', value: content as any };
  }

  return { type: 'text', value: content == null ? '' : String(content) };
}

function convertUserContent(content: unknown): Array<LanguageModelV3TextPart | LanguageModelV3FilePart> {
  if (typeof content === 'string') {
    return [toTextPart(content)];
  }
  const parts: Array<LanguageModelV3TextPart | LanguageModelV3FilePart> = [];
  for (const block of asArray(content)) {
    const item = asRecord(block);
    const type = pickString(item.type)?.toLowerCase();
    if (!type) {
      if (Object.keys(item).length > 0) {
        parts.push(toTextPart(JSON.stringify(item)));
      }
      continue;
    }
    if (type === 'text' || type === 'input_text') {
      const text = pickString(item.text);
      if (text) {
        parts.push(toTextPart(text));
      }
      continue;
    }
    if (type === 'image_url' || type === 'input_image') {
      const filePart = toOpenAiFilePartFromImage(item);
      if (filePart) {
        parts.push(filePart);
      }
      continue;
    }
    if (type === 'file') {
      const filePart = toOpenAiFilePartFromFile(item);
      if (filePart) {
        parts.push(filePart);
      }
      continue;
    }
  }
  return parts;
}

function convertAssistantContent(content: unknown, toolCalls: unknown): unknown[] {
  const parts: unknown[] = [];
  if (typeof content === 'string') {
    if (content.length > 0) {
      parts.push({ type: 'text', text: content });
    }
  } else {
    for (const block of asArray(content)) {
      const item = asRecord(block);
      const type = pickString(item.type)?.toLowerCase();
      if (type === 'text' || type === 'output_text') {
        const text = pickString(item.text ?? item.content);
        if (text) {
          parts.push({ type: 'text', text });
        }
      }
    }
  }

  for (const toolCall of asArray(toolCalls)) {
    const item = asRecord(toolCall);
    const id = pickString(item.id);
    const fn = asRecord(item.function);
    const toolName = pickString(fn.name);
    if (!id || !toolName) {
      continue;
    }
    parts.push({
      type: 'tool-call',
      toolCallId: id,
      toolName,
      input: parseToolArguments(fn.arguments)
    });
  }

  return parts;
}

function convertPrompt(rawBody: UnknownRecord): LanguageModelV3Prompt {
  const prompt: LanguageModelV3Prompt = [];

  for (const message of asArray(rawBody.messages)) {
    const bag = asRecord(message);
    const role = pickString(bag.role)?.toLowerCase();
    if (!role) {
      continue;
    }

    if (role === 'system' || role === 'developer') {
      const textParts = convertUserContent(bag.content)
        .filter((part): part is LanguageModelV3TextPart => part.type === 'text')
        .map((part) => part.text);
      if (textParts.length > 0) {
        prompt.push({
          role: 'system',
          content: textParts.join('\n')
        });
      }
      continue;
    }

    if (role === 'user') {
      const content = convertUserContent(bag.content);
      if (content.length > 0) {
        prompt.push({ role: 'user', content });
      }
      continue;
    }

    if (role === 'assistant') {
      const content = convertAssistantContent(bag.content, bag.tool_calls ?? bag.toolCalls);
      if (content.length > 0) {
        prompt.push({ role: 'assistant', content } as LanguageModelV3Message);
      }
      continue;
    }

    if (role === 'tool') {
      const toolCallId = pickString(bag.tool_call_id ?? bag.toolCallId);
      if (!toolCallId) {
        continue;
      }
      prompt.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId,
            toolName: 'tool',
            output: convertToolResultOutput(bag.content)
          }
        ]
      } as LanguageModelV3Message);
    }
  }
  return prompt;
}

function convertTools(rawBody: UnknownRecord): LanguageModelV3FunctionTool[] | undefined {
  const tools = asArray(rawBody.tools)
    .map((entry) => asRecord(entry))
    .map((tool) => {
      const type = pickString(tool.type)?.toLowerCase();
      const fn = asRecord(tool.function);
      const name = pickString(fn.name);
      if ((type && type !== 'function') || !name) {
        return null;
      }
      return {
        type: 'function' as const,
        name,
        ...(pickString(fn.description) ? { description: pickString(fn.description) } : {}),
        inputSchema: (fn.parameters ?? fn.input_schema ?? fn.inputSchema ?? {}) as Record<string, unknown>
      } as unknown as LanguageModelV3FunctionTool;
    })
    .filter((tool): tool is LanguageModelV3FunctionTool => tool !== null);
  return tools.length ? tools : undefined;
}

function convertResponseFormat(
  rawBody: UnknownRecord,
  openaiProviderOptions: OpenAiProviderOptions
): LanguageModelV3CallOptions['responseFormat'] | undefined {
  const format = asRecord(rawBody.response_format ?? rawBody.responseFormat);
  const type = pickString(format.type)?.toLowerCase();
  if (!type) {
    return undefined;
  }
  if (type === 'json_object') {
    return { type: 'json' };
  }
  if (type !== 'json_schema') {
    return undefined;
  }
  const jsonSchema = asRecord(format.json_schema ?? format.jsonSchema);
  const schema = jsonSchema.schema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return undefined;
  }
  const strict = pickBoolean(jsonSchema.strict);
  if (strict !== undefined) {
    openaiProviderOptions.strictJsonSchema = strict;
  }
  return {
    type: 'json',
    schema: schema as Record<string, unknown>,
    ...(pickString(jsonSchema.name) ? { name: pickString(jsonSchema.name) } : {}),
    ...(pickString(jsonSchema.description) ? { description: pickString(jsonSchema.description) } : {})
  };
}

export function buildOpenAiSdkChatCallOptions(
  body: UnknownRecord,
  requestHeaders: Record<string, string>
): LanguageModelV3CallOptions {
  const prompt = convertPrompt(body);
  const openaiProviderOptions: OpenAiProviderOptions = {
    systemMessageMode: 'system'
  };

  const reasoningEffort =
    pickString(body.reasoning_effort ?? body.reasoningEffort) ??
    pickString(asRecord(body.reasoning).effort);
  if (reasoningEffort && ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(reasoningEffort)) {
    openaiProviderOptions.reasoningEffort = reasoningEffort;
    openaiProviderOptions.forceReasoning = true;
  }

  const parallelToolCalls = pickBoolean(body.parallel_tool_calls ?? body.parallelToolCalls);
  if (parallelToolCalls !== undefined) {
    openaiProviderOptions.parallelToolCalls = parallelToolCalls;
  }
  const user = pickString(body.user);
  if (user) {
    openaiProviderOptions.user = user;
  }
  const maxCompletionTokens = pickNumber(body.max_completion_tokens ?? body.maxCompletionTokens);
  if (maxCompletionTokens !== undefined) {
    openaiProviderOptions.maxCompletionTokens = maxCompletionTokens;
  }
  const store = pickBoolean(body.store);
  if (store !== undefined) {
    openaiProviderOptions.store = store;
  }
  const metadata = body.metadata;
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    openaiProviderOptions.metadata = stripInternalKeysDeep(metadata as UnknownRecord);
  }
  const prediction = body.prediction;
  if (prediction && typeof prediction === 'object' && !Array.isArray(prediction)) {
    openaiProviderOptions.prediction = stripInternalKeysDeep(prediction as UnknownRecord);
  }
  const serviceTier = pickString(body.service_tier ?? body.serviceTier);
  if (serviceTier && ['auto', 'flex', 'priority', 'default'].includes(serviceTier)) {
    openaiProviderOptions.serviceTier = serviceTier;
  }
  const promptCacheKey = pickString(body.prompt_cache_key ?? body.promptCacheKey);
  if (promptCacheKey) {
    openaiProviderOptions.promptCacheKey = promptCacheKey;
  }
  const promptCacheRetention = pickString(body.prompt_cache_retention ?? body.promptCacheRetention);
  if (promptCacheRetention && ['in_memory', '24h'].includes(promptCacheRetention)) {
    openaiProviderOptions.promptCacheRetention = promptCacheRetention;
  }
  const safetyIdentifier = pickString(body.safety_identifier ?? body.safetyIdentifier);
  if (safetyIdentifier) {
    openaiProviderOptions.safetyIdentifier = safetyIdentifier;
  }
  const textVerbosity = pickString(body.verbosity ?? body.text_verbosity ?? body.textVerbosity);
  if (textVerbosity && ['low', 'medium', 'high'].includes(textVerbosity)) {
    openaiProviderOptions.textVerbosity = textVerbosity;
  }
  const logitBias = body.logit_bias ?? body.logitBias;
  if (logitBias && typeof logitBias === 'object' && !Array.isArray(logitBias)) {
    openaiProviderOptions.logitBias = logitBias;
  }
  const logprobs = body.logprobs;
  const topLogprobs = pickNumber(body.top_logprobs ?? body.topLogprobs);
  if (typeof logprobs === 'boolean' || typeof logprobs === 'number') {
    openaiProviderOptions.logprobs = logprobs;
  } else if (topLogprobs !== undefined) {
    openaiProviderOptions.logprobs = topLogprobs;
  }

  const responseFormat = convertResponseFormat(body, openaiProviderOptions);

  return {
    prompt,
    headers: requestHeaders,
    maxOutputTokens: pickNumber(body.max_tokens ?? body.maxTokens),
    temperature: pickNumber(body.temperature),
    topP: pickNumber(body.top_p ?? body.topP),
    frequencyPenalty: pickNumber(body.frequency_penalty ?? body.frequencyPenalty),
    presencePenalty: pickNumber(body.presence_penalty ?? body.presencePenalty),
    stopSequences: (() => {
      const stop = body.stop;
      if (typeof stop === 'string') {
        return [stop];
      }
      if (Array.isArray(stop)) {
        return stop.map(String);
      }
      return undefined;
    })(),
    seed: pickNumber(body.seed),
    tools: convertTools(body),
    toolChoice: normalizeToolChoice(body.tool_choice ?? body.toolChoice),
    responseFormat,
    providerOptions: Object.keys(openaiProviderOptions).length
      ? ({ openai: openaiProviderOptions } as unknown as LanguageModelV3CallOptions['providerOptions'])
      : undefined
  };
}

export function mergePreservedOpenAiRequestFields(rawBody: UnknownRecord, builtBody: UnknownRecord): UnknownRecord {
  const merged = { ...builtBody };
  for (const [key, value] of Object.entries(rawBody)) {
    if (key.startsWith('__')) {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(merged, key)) {
      continue;
    }
    merged[key] = stripInternalKeysDeep(value);
  }
  return merged;
}

function responseHeadersToRecord(headers: Headers): Record<string, string> | undefined {
  const entries = Array.from(headers.entries());
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

export class VercelAiSdkOpenAiTransport {
  async executePreparedRequest(
    requestInfo: PreparedHttpRequest,
    context: ProviderContext
  ): Promise<unknown> {
    const rawBody = applyOpenCodeZenThinkingDefaults(asRecord(requestInfo.body), context);
    const modelId = pickString(rawBody.model);
    if (!modelId) {
      throw new Error('provider-runtime-error: missing model from openai sdk transport');
    }

    const model = new OpenAIChatLanguageModel(modelId as never, {
      provider: 'openai.chat',
      headers: () => ({}),
      url: () => requestInfo.targetUrl
    } as never) as any;

    const callOptions = buildOpenAiSdkChatCallOptions(rawBody, requestInfo.headers);
    const argsResult = await model.getArgs(callOptions);
    const body = mergePreservedOpenAiRequestFields(rawBody, asRecord(argsResult.args));

    const response = await fetch(requestInfo.targetUrl, {
      method: 'POST',
      headers: requestInfo.headers,
      body: JSON.stringify(body),
      ...(requestInfo.abortSignal ? { signal: requestInfo.abortSignal } : {})
    });

    if (!response.ok) {
      throw buildHttpError(response.status, await response.text());
    }

    const responseHeaders = responseHeadersToRecord(response.headers);
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
