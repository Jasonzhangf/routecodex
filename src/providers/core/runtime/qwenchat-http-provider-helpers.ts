import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { PassThrough } from 'node:stream';

import type { UnknownObject } from '../../../types/common-types.js';
import { extractProviderRuntimeMetadata } from './provider-runtime-metadata.js';

export const DEFAULT_QWENCHAT_BASE_URL = 'https://chat.qwen.ai';
export const DEFAULT_QWENCHAT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
export const DEFAULT_QWENCHAT_ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9,en;q=0.8';
export const DEFAULT_QWENCHAT_COMPLETION_ENDPOINT = '/api/v2/chat/completions';
export const DEFAULT_QWENCHAT_CHAT_CREATE_ENDPOINT = '/api/v2/chats/new';
export const QWENCHAT_SSE_PROBE_WRAPPER_KEY = '__routecodex_qwenchat_sse_probe';
export const QWENCHAT_NONSTREAM_DELIVERY_KEY = '__routecodex_qwenchat_nonstream_delivery';

type QwenUploadTokenData = {
  file_url: string;
  file_id?: string;
  access_key_id: string;
  access_key_secret: string;
  security_token: string;
};

type QwenBaxiaTokens = {
  bxUa: string;
  bxUmidToken: string;
  bxV: string;
};

type QwenMessageAttachment = {
  source: string;
  filename?: string;
  mimeType?: string;
  explicitType?: 'image' | 'audio' | 'video' | 'document';
};

type LoadedAttachment = {
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
  explicitType?: 'image' | 'audio' | 'video' | 'document';
};

type ParsedIncomingMessages = {
  content: string;
  attachments: QwenMessageAttachment[];
};

type ParsedQwenSse = {
  content: string;
  reasoningContent: string;
  usage?: Record<string, unknown>;
};

type CollectedFunctionCall = {
  id?: string;
  name?: string;
  argumentsText: string;
  phase?: string;
};

type CollectedToolCall = {
  index: number;
  id?: string;
  name?: string;
  argumentsText: string;
  phase?: string;
};

type QwenChatPayload = {
  model: string;
  messages: unknown[];
  stream: boolean;
  tools?: unknown;
  metadata?: Record<string, unknown>;
};

type QwenImageGenerationOptions = {
  enabled: boolean;
  count: number;
  sizeRatio: string;
  responseFormat: 'url' | 'b64_json';
};

type QwenChatSendInput = {
  baseUrl: string;
  payload: QwenChatPayload;
  baxiaTokens: QwenBaxiaTokens;
  authHeaders?: Record<string, string>;
  backoffKey?: string;
  toolSearchSuppressionMode?: 'normal' | 'off' | 'none' | 'disable';
};

type JsonResponseOk = {
  ok: true;
  status: number;
  data: Record<string, unknown>;
  rawText: string;
};

type JsonResponseErr = {
  ok: false;
  status: number;
  data: null;
  rawText: string;
  parseError: Error;
};

type QwenFilePayload = Record<string, unknown>;

type ParsedContentPart = {
  text: string;
  attachments: QwenMessageAttachment[];
};

type QwenUploadResult = {
  files: QwenFilePayload[];
};

type DeltaRecord = Record<string, unknown>;

type QwenSseChunkWriterInput = {
  upstreamStream: NodeJS.ReadableStream;
  model: string;
  declaredToolNames?: string[];
};

type QwenChatSseProbe = {
  startedAtMs: number;
  firstUpstreamChunkMs?: number;
  firstDataFrameMs?: number;
  firstEmitMs?: number;
  firstToolCallMs?: number;
  upstreamDoneMs?: number;
  upstreamChunkCount: number;
  dataFrameCount: number;
  ignoredFrameCount: number;
  emittedChunkCount: number;
  terminalErrorCode?: string;
};

type BxCacheState = {
  tokenCache: QwenBaxiaTokens | null;
  tokenCacheTime: number;
};

type QwenHiddenNativeToolHit = {
  name: string;
  phase?: string;
};

type QwenToolContractViolation =
  | {
      kind: 'hidden_native_tool';
      name: string;
      phase?: string;
    }
  | {
      kind: 'native_tool_call';
      name: string;
      phase?: string;
    };

const KNOWN_QWEN_HIDDEN_NATIVE_TOOLS = new Set([
  'web_extractor',
  'tool_code_interpreter',
  'code_interpreter',
  'python',
  'browser',
  'web_search',
  'read_file',
  'file_read',
  'cat',
  'bash'
]);

const BAXIA_VERSION = '2.5.36';

function createQwenChatSseProbe(): QwenChatSseProbe {
  return {
    startedAtMs: Date.now(),
    upstreamChunkCount: 0,
    dataFrameCount: 0,
    ignoredFrameCount: 0,
    emittedChunkCount: 0
  };
}

function elapsedSince(startedAtMs: number): number {
  return Math.max(0, Date.now() - startedAtMs);
}

function markFirstProbeLatency(
  probe: QwenChatSseProbe,
  field: 'firstUpstreamChunkMs' | 'firstDataFrameMs' | 'firstEmitMs' | 'firstToolCallMs'
): void {
  if (typeof probe[field] === 'number') {
    return;
  }
  probe[field] = elapsedSince(probe.startedAtMs);
}
const BAXIA_CACHE_TTL_MS = 4 * 60 * 1000;
const DEFAULT_ATTACHMENT_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
const QWENCHAT_PROVIDER_TOOL_OVERRIDE_MARKER = '[routecodex-qwenchat-provider-tool-override]';
const QWENCHAT_CREATE_SESSION_MAX_ATTEMPTS = 3;
const QWENCHAT_CREATE_SESSION_BASE_BACKOFF_MS = 400;
const QWENCHAT_CREATE_SESSION_MAX_BACKOFF_MS = 8_000;
const QWENCHAT_HELPERS_NON_BLOCKING_LOG_THROTTLE_MS = 60_000;
const qwenChatHelpersNonBlockingLogState = new Map<string, number>();

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function logQwenChatHelpersNonBlocking(
  stage: string,
  error: unknown,
  details?: Record<string, unknown>
): void {
  const now = Date.now();
  const last = qwenChatHelpersNonBlockingLogState.get(stage) ?? 0;
  if (now - last < QWENCHAT_HELPERS_NON_BLOCKING_LOG_THROTTLE_MS) {
    return;
  }
  qwenChatHelpersNonBlockingLogState.set(stage, now);
  try {
    const detailSuffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(`[qwenchat-helpers] ${stage} failed (non-blocking): ${formatUnknownError(error)}${detailSuffix}`);
  } catch {
    // never throw from non-blocking logging
  }
}

type QwenChatCreateSessionBackoffState = {
  consecutiveFailures: number;
  cooldownUntil: number;
};

type QwenChatCreateSessionQueueState = {
  tail: Promise<void>;
};

const qwenChatCreateSessionBackoffState = new Map<string, QwenChatCreateSessionBackoffState>();
const qwenChatCreateSessionQueueState = new Map<string, QwenChatCreateSessionQueueState>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeInputString(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  const lowered = trimmed.toLowerCase();
  if (lowered === 'undefined' || lowered === '[undefined]' || lowered === 'null' || lowered === '[null]') {
    return '';
  }
  return trimmed;
}

function sleep(ms: number): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeStreamChunkUtf8(chunk: unknown): string {
  if (typeof chunk === 'string') {
    return chunk;
  }
  if (Buffer.isBuffer(chunk)) {
    return chunk.toString('utf8');
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk).toString('utf8');
  }
  return String(chunk ?? '');
}

function readDeclaredToolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) {
    return [];
  }
  const names: string[] = [];
  for (const entry of tools) {
    if (!isRecord(entry)) continue;
    const fnNode = isRecord(entry.function) ? entry.function : entry;
    const name = normalizeInputString(fnNode.name);
    if (name) {
      names.push(name);
    }
  }
  return Array.from(new Set(names));
}

type DeclaredToolPromptSpec = {
  name: string;
  schemaLine: string;
  exampleLine?: string;
};

function describePromptSchemaType(node: unknown): string {
  if (!isRecord(node)) {
    return 'json';
  }
  const enumValues = Array.isArray(node.enum) ? node.enum.filter((entry) => typeof entry === 'string') : [];
  if (enumValues.length > 0) {
    return enumValues.map((entry) => JSON.stringify(entry)).join('|');
  }
  const type = normalizeInputString(node.type).toLowerCase();
  if (!type) {
    return 'json';
  }
  if (type === 'integer' || type === 'number') {
    return 'number';
  }
  if (type === 'boolean') {
    return 'boolean';
  }
  if (type === 'array') {
    const itemType = describePromptSchemaType(node.items);
    return `array<${itemType}>`;
  }
  if (type === 'object') {
    return 'object';
  }
  return type;
}

function buildDeclaredToolPromptSpecs(tools: unknown): DeclaredToolPromptSpec[] {
  if (!Array.isArray(tools)) {
    return [];
  }
  const specs: DeclaredToolPromptSpec[] = [];
  for (const entry of tools) {
    if (!isRecord(entry)) continue;
    const fnNode = isRecord(entry.function) ? entry.function : entry;
    const name = normalizeInputString(fnNode.name);
    if (!name) {
      continue;
    }
    const parametersNode = isRecord(fnNode.parameters) ? fnNode.parameters : undefined;
    const propertiesNode = isRecord(parametersNode?.properties)
      ? (parametersNode.properties as Record<string, unknown>)
      : undefined;
    const requiredSet = new Set(
      Array.isArray(parametersNode?.required)
        ? parametersNode.required
            .map((item) => normalizeInputString(item))
            .filter(Boolean)
        : []
    );
    const propertyKeys = propertiesNode ? Object.keys(propertiesNode).slice(0, 6) : [];
    const fieldParts = propertyKeys.map((key) => {
      const required = requiredSet.has(key) ? '' : '?';
      return `${key}${required}:${describePromptSchemaType(propertiesNode?.[key])}`;
    });
    const schemaLine =
      fieldParts.length > 0
        ? `${name} => input { ${fieldParts.join(', ')} }`
        : `${name} => input must be a JSON object matching the declared schema`;
    let exampleLine: string | undefined;
    switch (name.trim().toLowerCase()) {
      case 'exec_command':
        exampleLine = 'example exec_command => {"tool_calls":[{"name":"exec_command","input":{"cmd":"pwd"}}]}';
        break;
      case 'apply_patch':
        exampleLine =
          'example apply_patch => {"tool_calls":[{"name":"apply_patch","input":{"patch":"*** Begin Patch\\n*** End Patch"}}]}';
        break;
      case 'update_plan':
        exampleLine =
          'example update_plan => {"tool_calls":[{"name":"update_plan","input":{"plan":[{"step":"Inspect repo","status":"in_progress"}]}}]}';
        break;
      default:
        break;
    }
    specs.push({ name, schemaLine, exampleLine });
  }
  return specs;
}

function normalizeToolNameSet(names: string[] | undefined): Set<string> {
  return new Set(
    Array.isArray(names)
      ? names
          .map((name) => normalizeInputString(name).toLowerCase())
          .filter(Boolean)
      : []
  );
}

function readRuntimeCapturedToolsFromRequest(request: UnknownObject): unknown {
  const runtime = extractProviderRuntimeMetadata(request);
  const runtimeMetadata =
    runtime?.metadata && isRecord(runtime.metadata)
      ? (runtime.metadata as Record<string, unknown>)
      : undefined;
  const candidates: unknown[] = [
    runtimeMetadata?.capturedChatRequest,
    runtimeMetadata?.captured_chat_request,
    runtime?.capturedChatRequest,
    runtime?.captured_chat_request
  ];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) {
      continue;
    }
    const tools = candidate.tools;
    if (Array.isArray(tools) && tools.length > 0) {
      return tools;
    }
  }
  return undefined;
}

function detectQwenHiddenNativeTool(
  deltaRaw: Record<string, unknown> | undefined,
  declaredToolNames: Set<string>
): QwenHiddenNativeToolHit | null {
  if (!deltaRaw) {
    return null;
  }
  const phase = normalizeInputString(deltaRaw.phase);
  const functionCallNode = isRecord(deltaRaw.function_call) ? deltaRaw.function_call : undefined;
  const functionName = normalizeInputString(functionCallNode?.name);
  if (functionName) {
    const normalizedFunctionName = functionName.toLowerCase();
    if (
      KNOWN_QWEN_HIDDEN_NATIVE_TOOLS.has(normalizedFunctionName)
      || (declaredToolNames.size > 0 && !declaredToolNames.has(normalizedFunctionName))
    ) {
      return { name: functionName, ...(phase ? { phase } : {}) };
    }
  }
  const toolCallsRaw = Array.isArray(deltaRaw.tool_calls) ? deltaRaw.tool_calls : [];
  for (const entryRaw of toolCallsRaw) {
    if (!isRecord(entryRaw)) continue;
    const functionNode = isRecord(entryRaw.function) ? entryRaw.function : undefined;
    const name =
      normalizeInputString(functionNode?.name)
      || normalizeInputString(entryRaw.name);
    if (!name) {
      continue;
    }
    const normalizedName = name.toLowerCase();
    if (
      KNOWN_QWEN_HIDDEN_NATIVE_TOOLS.has(normalizedName)
      || (declaredToolNames.size > 0 && !declaredToolNames.has(normalizedName))
    ) {
      return { name, ...(phase ? { phase } : {}) };
    }
  }
  return null;
}

function detectQwenToolContractViolation(
  deltaRaw: Record<string, unknown> | undefined,
  declaredToolNames: Set<string>
): QwenToolContractViolation | null {
  if (!deltaRaw) {
    return null;
  }
  const hiddenNativeTool = detectQwenHiddenNativeTool(deltaRaw, declaredToolNames);
  if (hiddenNativeTool) {
    return {
      kind: 'hidden_native_tool',
      name: hiddenNativeTool.name,
      ...(hiddenNativeTool.phase ? { phase: hiddenNativeTool.phase } : {})
    };
  }
  if (declaredToolNames.size === 0) {
    return null;
  }
  const phase = normalizeInputString(deltaRaw.phase);
  const functionCallNode = isRecord(deltaRaw.function_call) ? deltaRaw.function_call : undefined;
  const toolCallsRaw = Array.isArray(deltaRaw.tool_calls) ? deltaRaw.tool_calls : [];
  if (!functionCallNode && toolCallsRaw.length === 0) {
    return null;
  }
  const nativeName =
    normalizeInputString(functionCallNode?.name)
    || toolCallsRaw
        .map((entryRaw) => {
          if (!isRecord(entryRaw)) return '';
          const functionNode = isRecord(entryRaw.function) ? entryRaw.function : undefined;
          return normalizeInputString(functionNode?.name) || normalizeInputString(entryRaw.name);
        })
        .find(Boolean)
    || 'unknown';
  if (declaredToolNames.has(nativeName.toLowerCase())) {
    return null;
  }
  return {
    kind: 'native_tool_call',
    name: nativeName,
    ...(phase ? { phase } : {})
  };
}

function createQwenToolContractViolationError(
  hit: QwenToolContractViolation,
  declaredToolNames: Set<string>
): Error {
  const allowed = Array.from(declaredToolNames).join(', ');
  const allowedSuffix = allowed ? `; expected only declared tools: ${allowed}` : '';
  const phaseSuffix = hit.phase ? ` (phase=${hit.phase})` : '';
  const isHiddenNativeTool = hit.kind === 'hidden_native_tool';
  const err = new Error(
    isHiddenNativeTool
      ? `QwenChat upstream emitted undeclared native tool "${hit.name}"${phaseSuffix}${allowedSuffix}`
      : `QwenChat upstream emitted raw native tool call "${hit.name}"${phaseSuffix}${allowedSuffix}; expected text-only RCC harvest output`
  );
  (err as Error & { statusCode?: number; code?: string; toolName?: string; phase?: string }).statusCode = 502;
  (err as Error & { statusCode?: number; code?: string; toolName?: string; phase?: string }).code =
    isHiddenNativeTool ? 'QWENCHAT_HIDDEN_NATIVE_TOOL' : 'QWENCHAT_NATIVE_TOOL_CALL';
  (err as Error & { statusCode?: number; code?: string; toolName?: string; phase?: string }).toolName = hit.name;
  (err as Error & { statusCode?: number; code?: string; toolName?: string; phase?: string }).phase = hit.phase;
  return err;
}

function applyQwenChatProviderToolOverride(content: string, tools: unknown): string {
  const promptSpecs = buildDeclaredToolPromptSpecs(tools);
  if (promptSpecs.length === 0) {
    return content;
  }
  const toolNames = promptSpecs.map((item) => item.name);
  let normalizedContent = content;
  if (normalizedContent.startsWith(QWENCHAT_PROVIDER_TOOL_OVERRIDE_MARKER)) {
    const splitIndex = normalizedContent.indexOf('\n\n');
    normalizedContent =
      splitIndex >= 0
        ? normalizedContent.slice(splitIndex + 2)
        : '';
  }
  const toolList = toolNames.join(', ');
  const schemaGuidance = promptSpecs.map((item) => item.schemaLine).join('; ');
  const exampleGuidance = promptSpecs
    .map((item) => item.exampleLine)
    .filter((item): item is string => Boolean(item))
    .join('; ');
  const hasExecCommand = promptSpecs.some((item) => item.name.trim().toLowerCase() === 'exec_command');
  const override =
    `${QWENCHAT_PROVIDER_TOOL_OVERRIDE_MARKER}\n` +
    `RouteCodex tool contract for this turn. Declared tool names only: ${toolList}. ` +
    `这是纸上谈兵，不是真实执行环境；Only text output. 所有工具动作都只能以文本 dry-run 形式表达，不代表真实调用、真实运行、真实读写、真实联网。 ` +
    `This project is paper-only simulation. Only text output is allowed. Every tool action must be expressed as text-only dry-run output and must not claim real execution, real file mutation, real shell execution, or real network access. ` +
    `There is no built-in network search or native tool runtime in this request. Declared tool names are plain text labels inside the RCC container only. Even if a declared name matches a built-in capability such as exec_command, never invoke any native/built-in tool runtime or provider function-call channel. Never output web_search, web_extractor, browser, code_interpreter, tool_code_interpreter, python, read_file, file_read, cat, bash, provider-native function_call fields, provider-native tool_calls protocol arrays outside the RCC text container, XML function wrappers, or any hidden/native tool name. ` +
    `Never use internet or web search even if the user asks for latest, GitHub, online, web, or external information. Use only the declared RouteCodex tool names. ` +
    `When a tool is needed, reply with exactly one RCC_TOOL_CALLS_JSON heredoc dry-run container and nothing else. ` +
    `User is Silentio: act like a primitive operator, not a narrator: no filler, no repeated summaries, no reasoning prose, no "I will", no "starting now", no running commentary. ` +
    `During execution turns be extremely brief; only give a fuller summary after the task is actually completed. ` +
    `The first non-whitespace characters must be <<RCC_TOOL_CALLS_JSON and the last line must be RCC_TOOL_CALLS_JSON. ` +
    `Use the exact 3-line container shape: line 1 is <<RCC_TOOL_CALLS_JSON, line 2 is the JSON object, line 3 is RCC_TOOL_CALLS_JSON. ` +
    `The closing marker must be on its own line starting at column 1; always insert a newline before RCC_TOOL_CALLS_JSON and never glue the closing marker directly after } or ]. ` +
    `Never emit only the heredoc opener; if you start <<RCC_TOOL_CALLS_JSON, include the JSON body and closing marker in the same answer. ` +
    `Inside the JSON body, use only declared tool names and an input object whose keys match the declared schema exactly. ` +
    `Declared tool input schema: ${schemaGuidance}. ` +
    (hasExecCommand ? `For exec_command the required key is cmd; never rename it to command. ` : '') +
    (exampleGuidance ? `Valid JSON body examples: ${exampleGuidance}. ` : '') +
    `Do not emit markdown fences, bare function syntax, policy discussion, or tool-unavailable complaints before the heredoc. ` +
    `For exec_command keep normal shell commands on one physical line unless a real heredoc is required; never split redirects/operators such as |, &&, ||, ;, 2>/dev/null, or -exec ... \\; across lines.`;
  return normalizedContent ? `${override}\n\n${normalizedContent}` : override;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed =
    typeof value === 'number' && Number.isFinite(value)
      ? Math.trunc(value)
      : Number.parseInt(normalizeInputString(value), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function readBooleanEnv(keys: string[], fallback: boolean): boolean {
  for (const key of keys) {
    const raw = normalizeInputString(process.env[key]);
    if (!raw) {
      continue;
    }
    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

function parseImageSizeToQwenRatio(size: unknown): string {
  const text = normalizeInputString(size);
  if (!text) {
    return '1:1';
  }
  const ratioMatch = text.match(/^(\d{1,2}):(\d{1,2})$/);
  if (ratioMatch) {
    const w = Number.parseInt(ratioMatch[1], 10);
    const h = Number.parseInt(ratioMatch[2], 10);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      const ratio = `${w}:${h}`;
      if (['1:1', '16:9', '9:16', '4:3', '3:4'].includes(ratio)) {
        return ratio;
      }
    }
  }

  const sizeMatch = text.toLowerCase().match(/^(\d{2,5})\s*x\s*(\d{2,5})$/);
  if (!sizeMatch) {
    return '1:1';
  }
  const width = Number.parseInt(sizeMatch[1], 10);
  const height = Number.parseInt(sizeMatch[2], 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return '1:1';
  }
  const ratio = width / height;
  const candidates = [
    { key: '1:1', ratio: 1 },
    { key: '16:9', ratio: 16 / 9 },
    { key: '9:16', ratio: 9 / 16 },
    { key: '4:3', ratio: 4 / 3 },
    { key: '3:4', ratio: 3 / 4 }
  ];
  let best = candidates[0];
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const diff = Math.abs(ratio - candidate.ratio);
    if (diff < bestDiff) {
      best = candidate;
      bestDiff = diff;
    }
  }
  return best.key;
}

function parseQwenImageGenerationOptions(metadata?: Record<string, unknown>): QwenImageGenerationOptions {
  const node =
    metadata && isRecord(metadata.qwenImageGeneration)
      ? (metadata.qwenImageGeneration as Record<string, unknown>)
      : undefined;
  const enabled =
    metadata?.qwenImageGeneration === true
    || metadata?.imageGeneration === true
    || normalizeInputString(metadata?.generationMode).toLowerCase() === 'image'
    || Boolean(node);
  const count = clampInteger(node?.n ?? metadata?.n, 1, 1, 10);
  const sizeRatio = parseImageSizeToQwenRatio(node?.size ?? metadata?.size);
  const responseFormatRaw = normalizeInputString(
    node?.responseFormat ?? node?.response_format ?? metadata?.response_format
  ).toLowerCase();
  const responseFormat: 'url' | 'b64_json' = responseFormatRaw === 'b64_json' ? 'b64_json' : 'url';
  return {
    enabled,
    count,
    sizeRatio,
    responseFormat
  };
}

function readPositiveIntegerEnv(keys: string[], fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  for (const key of keys) {
    const raw = normalizeInputString(process.env[key]);
    if (!raw) {
      continue;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
      continue;
    }
    const normalized = Math.floor(parsed);
    if (normalized < min || normalized > max) {
      continue;
    }
    return normalized;
  }
  return fallback;
}

function isPrivateIpv4(host: string): boolean {
  const segments = host.split('.');
  if (segments.length !== 4) {
    return false;
  }
  const numbers = segments.map((segment) => Number.parseInt(segment, 10));
  if (numbers.some((value) => !Number.isFinite(value) || value < 0 || value > 255)) {
    return false;
  }
  const [a, b] = numbers;
  if (a === 10 || a === 127 || a === 0) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  return false;
}

function isPrivateIpv6(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe80:');
}

function validateAttachmentSourceUrl(input: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('Invalid attachment URL');
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new Error(`Unsupported attachment URL protocol: ${protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('Attachment URL must not include username/password');
  }
  const hostname = parsed.hostname.trim().toLowerCase();
  if (!hostname) {
    throw new Error('Attachment URL hostname is required');
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('Attachment URL localhost/local domains are not allowed');
  }
  const ipType = isIP(hostname);
  if (ipType === 4 && isPrivateIpv4(hostname)) {
    throw new Error('Attachment URL private IPv4 is not allowed');
  }
  if (ipType === 6 && isPrivateIpv6(hostname)) {
    throw new Error('Attachment URL private IPv6 is not allowed');
  }
  return parsed;
}

async function readResponseBytesWithLimit(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLengthText = normalizeInputString(response.headers.get('content-length'));
  if (contentLengthText) {
    const contentLength = Number.parseInt(contentLengthText, 10);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(`Attachment exceeds max size (${contentLength} > ${maxBytes})`);
    }
  }
  const reader = response.body?.getReader();
  if (!reader) {
    return new Uint8Array(await response.arrayBuffer());
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const step = await reader.read();
    if (step.done) {
      break;
    }
    const chunk = step.value;
    total += chunk.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel('attachment_too_large');
      } catch (error: unknown) {
        logQwenChatHelpersNonBlocking('readResponseBytesWithLimit.cancel', error, { maxBytes, total });
      }
      throw new Error(`Attachment exceeds max size (${total} > ${maxBytes})`);
    }
    chunks.push(chunk);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function randomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}

function cryptoHashBase64Md5(data: Uint8Array): string {
  return createHash('md5').update(data).digest('base64').substring(0, 32);
}

function encodeBaxiaToken(data: Record<string, unknown>): string {
  const json = JSON.stringify(data);
  const encoded = Buffer.from(json, 'utf8').toString('base64');
  return `${BAXIA_VERSION.replace(/\./g, '')}!${encoded}`;
}

async function collectFingerprintData(): Promise<Record<string, unknown>> {
  const platforms = ['Win32', 'Linux x86_64', 'MacIntel'];
  const languages = ['en-US', 'zh-CN', 'en-GB'];
  const canvas = cryptoHashBase64Md5(randomBytes(32));
  return {
    p: platforms[Math.floor(Math.random() * platforms.length)],
    l: languages[Math.floor(Math.random() * languages.length)],
    hc: 4 + Math.floor(Math.random() * 12),
    dm: [4, 8, 16, 32][Math.floor(Math.random() * 4)],
    to: [-480, -300, 0, 60, 480][Math.floor(Math.random() * 5)],
    sw: 1920 + Math.floor(Math.random() * 200),
    sh: 1080 + Math.floor(Math.random() * 100),
    cd: 24,
    pr: [1, 1.25, 1.5, 2][Math.floor(Math.random() * 4)],
    wf: 'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.6)'.substring(0, 20),
    cf: canvas,
    af: (124.04347527516074 + Math.random() * 0.001).toFixed(14),
    ts: Date.now(),
    r: Math.random()
  };
}

export async function getQwenBaxiaTokens(cache: BxCacheState): Promise<QwenBaxiaTokens> {
  const now = Date.now();
  if (cache.tokenCache && now - cache.tokenCacheTime < BAXIA_CACHE_TTL_MS) {
    return cache.tokenCache;
  }
  const bxUa = encodeBaxiaToken(await collectFingerprintData());
  let bxUmidToken = `T2gA${randomString(40)}`;
  try {
    const resp = await fetch('https://sg-wum.alibaba.com/w/wu.json', {
      headers: { 'User-Agent': DEFAULT_QWENCHAT_USER_AGENT }
    });
    const etag = normalizeInputString(resp.headers.get('etag'));
    if (etag) {
      bxUmidToken = etag;
    }
  } catch (error: unknown) {
    logQwenChatHelpersNonBlocking('getQwenBaxiaTokens.fetchEtag', error);
  }
  const next: QwenBaxiaTokens = { bxUa, bxUmidToken, bxV: BAXIA_VERSION };
  cache.tokenCache = next;
  cache.tokenCacheTime = now;
  return next;
}

async function safeReadJsonResponse(response: Response): Promise<JsonResponseOk | JsonResponseErr> {
  const rawText = await response.text().catch(() => '');
  if (!rawText) {
    return {
      ok: false,
      status: response.status,
      data: null,
      rawText: '',
      parseError: new Error('Empty response body')
    };
  }
  try {
    const parsed = JSON.parse(rawText);
    if (!isRecord(parsed)) {
      return {
        ok: false,
        status: response.status,
        data: null,
        rawText,
        parseError: new Error('Response is not a JSON object')
      };
    }
    return {
      ok: true,
      status: response.status,
      data: parsed,
      rawText
    };
  } catch (error) {
    return {
      ok: false,
      status: response.status,
      data: null,
      rawText,
      parseError: error instanceof Error ? error : new Error(String(error))
    };
  }
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

function normalizeMimeType(raw: unknown): string {
  const value = normalizeInputString(raw).toLowerCase();
  return value || 'application/octet-stream';
}

function inferFileCategory(
  mimeType: string,
  explicitType?: 'image' | 'audio' | 'video' | 'document'
): 'image' | 'audio' | 'video' | 'document' {
  if (explicitType) {
    return explicitType;
  }
  const mime = normalizeMimeType(mimeType);
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'document';
}

function fileExtensionFromMime(mimeType: string): string {
  const mime = normalizeMimeType(mimeType);
  const mapping: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'text/markdown': 'md',
    'application/json': 'json',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/mp4': 'm4a',
    'audio/ogg': 'ogg',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'video/x-matroska': 'mkv',
    'video/avi': 'avi'
  };
  return mapping[mime] || 'bin';
}

function decodeBase64ToBytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

function parseDataUrl(dataUrl: string): { mimeType: string; bytes: Uint8Array } | null {
  const matched = dataUrl.match(/^data:([^;,]+)?;base64,(.+)$/i);
  if (!matched) {
    return null;
  }
  return {
    mimeType: normalizeMimeType(matched[1] || 'application/octet-stream'),
    bytes: decodeBase64ToBytes(matched[2])
  };
}

function inferFilename(rawFilename: unknown, mimeType: string): string {
  const normalized = normalizeInputString(rawFilename);
  if (normalized) {
    return normalized;
  }
  return `attachment-${randomUUID()}.${fileExtensionFromMime(mimeType)}`;
}

function normalizeLegacyFiles(message: Record<string, unknown>): QwenMessageAttachment[] {
  const out: QwenMessageAttachment[] = [];
  const rawAttachments = Array.isArray(message.attachments) ? message.attachments : [];
  const rawFiles = Array.isArray(message.files) ? message.files : [];
  for (const item of [...rawAttachments, ...rawFiles]) {
    if (!isRecord(item)) continue;
    const source = normalizeInputString(item.data || item.file_data || item.url || item.file_url);
    if (!source) continue;
    const explicitRaw = normalizeInputString(item.type).toLowerCase();
    const explicitType =
      explicitRaw === 'image' || explicitRaw === 'audio' || explicitRaw === 'video' || explicitRaw === 'document'
        ? explicitRaw
        : undefined;
    out.push({
      source,
      filename: normalizeInputString(item.filename || item.name) || undefined,
      mimeType: normalizeInputString(item.mime_type || item.content_type || item.type) || undefined,
      explicitType: explicitType as QwenMessageAttachment['explicitType'] | undefined
    });
  }
  return out;
}

const VIDEO_SOURCE_HINT_RE = /(^data:video\/)|(\.(mp4|mov|m4v|webm|avi|mkv|m3u8|flv)(?:$|[?#]))/i;

function sourceLooksLikeVideo(source: string, mimeType?: string): boolean {
  const normalizedSource = normalizeInputString(source);
  if (normalizedSource && VIDEO_SOURCE_HINT_RE.test(normalizedSource)) {
    return true;
  }
  const normalizedMime = normalizeMimeType(mimeType).toLowerCase();
  return normalizedMime.startsWith('video/');
}

function normalizeContentParts(content: unknown): ParsedContentPart {
  if (typeof content === 'string') {
    return { text: normalizeInputString(content), attachments: [] };
  }
  if (!Array.isArray(content)) {
    return { text: '', attachments: [] };
  }
  const textParts: string[] = [];
  const attachments: QwenMessageAttachment[] = [];
  for (const partRaw of content) {
    if (!isRecord(partRaw)) {
      if (typeof partRaw === 'string') {
        const text = normalizeInputString(partRaw);
        if (text) textParts.push(text);
      }
      continue;
    }
    const type = normalizeInputString(partRaw.type).toLowerCase();
    if (type === 'text' || type === 'input_text') {
      const text = normalizeInputString(partRaw.text || partRaw.input_text);
      if (text) textParts.push(text);
      continue;
    }
    if (type === 'image_url' || type === 'input_image') {
      const rawImage = isRecord(partRaw.image_url) ? partRaw.image_url.url : partRaw.image_url;
      const source = normalizeInputString(rawImage || partRaw.url || partRaw.file_url || partRaw.file_data);
      if (!source) continue;
      const mimeHint = normalizeInputString(partRaw.mime_type || partRaw.content_type);
      attachments.push({
        source,
        filename: normalizeInputString(partRaw.filename || partRaw.name) || undefined,
        mimeType: mimeHint || undefined,
        // Some clients put video URLs in image_url blocks; preserve shape, only fix type.
        explicitType: sourceLooksLikeVideo(source, mimeHint) ? 'video' : 'image'
      });
      continue;
    }
    if (
      type === 'file' ||
      type === 'input_file' ||
      type === 'audio' ||
      type === 'input_audio' ||
      type === 'video' ||
      type === 'input_video' ||
      type === 'video_url'
    ) {
      const rawVideo = isRecord(partRaw.video_url) ? partRaw.video_url.url : partRaw.video_url;
      const source = normalizeInputString(rawVideo || partRaw.file_data || partRaw.url || partRaw.file_url || partRaw.data);
      if (!source) continue;
      const explicitType =
        type.includes('audio') ? 'audio' : (type.includes('video') || sourceLooksLikeVideo(source, normalizeInputString(partRaw.mime_type || partRaw.content_type))) ? 'video' : undefined;
      attachments.push({
        source,
        filename: normalizeInputString(partRaw.filename || partRaw.name) || undefined,
        mimeType: normalizeInputString(partRaw.mime_type || partRaw.content_type) || undefined,
        explicitType
      });
      continue;
    }
    const fallbackText = normalizeInputString(partRaw.text || partRaw.content);
    if (fallbackText) {
      textParts.push(fallbackText);
    }
  }
  return {
    text: textParts.join('\n'),
    attachments
  };
}

export function parseIncomingMessages(messages: unknown): ParsedIncomingMessages {
  const safeMessages = Array.isArray(messages) ? messages : [];
  const normalized = safeMessages.map((messageRaw) => {
    const message = isRecord(messageRaw) ? messageRaw : {};
    const parsed = normalizeContentParts(message.content);
    return {
      role: normalizeInputString(message.role) || 'user',
      text: parsed.text,
      attachments: [...parsed.attachments, ...normalizeLegacyFiles(message)]
    };
  });

  if (normalized.length === 0) {
    return { content: '', attachments: [] };
  }

  const last = normalized[normalized.length - 1];
  const history = normalized
    .slice(0, -1)
    .map((item) => {
      if (!item.text) return '';
      const role = item.role === 'assistant' ? 'Assistant' : item.role === 'system' ? 'System' : 'User';
      return `[${role}]: ${item.text}`;
    })
    .filter(Boolean)
    .join('\n\n');

  const lastText = last.text || (last.attachments.length > 0 ? '请结合附件内容回答。' : '');
  const merged = history ? `${history}\n\n[User]: ${lastText}` : lastText;
  return {
    content: merged,
    attachments: last.attachments
  };
}

async function loadAttachmentBytes(attachment: QwenMessageAttachment): Promise<LoadedAttachment> {
  const parsedDataUrl = parseDataUrl(attachment.source);
  if (parsedDataUrl) {
    const mimeType = normalizeMimeType(attachment.mimeType || parsedDataUrl.mimeType);
    return {
      bytes: parsedDataUrl.bytes,
      mimeType,
      filename: inferFilename(attachment.filename, mimeType),
      explicitType: attachment.explicitType
    };
  }
  if (/^https?:\/\//i.test(attachment.source)) {
    const parsedUrl = validateAttachmentSourceUrl(attachment.source);
    const timeoutMs = readPositiveIntegerEnv(
      ['ROUTECODEX_QWENCHAT_ATTACHMENT_FETCH_TIMEOUT_MS', 'RCC_QWENCHAT_ATTACHMENT_FETCH_TIMEOUT_MS'],
      DEFAULT_ATTACHMENT_FETCH_TIMEOUT_MS,
      1_000,
      300_000
    );
    const maxBytes = readPositiveIntegerEnv(
      ['ROUTECODEX_QWENCHAT_ATTACHMENT_MAX_BYTES', 'RCC_QWENCHAT_ATTACHMENT_MAX_BYTES'],
      DEFAULT_ATTACHMENT_MAX_BYTES,
      1024
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('attachment_fetch_timeout'), timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    const resp = await fetch(parsedUrl, { signal: controller.signal }).finally(() => clearTimeout(timer));
    if (!resp.ok) {
      throw new Error(`Failed to fetch attachment URL: HTTP ${resp.status}`);
    }
    const bytes = await readResponseBytesWithLimit(resp, maxBytes);
    const mimeType = normalizeMimeType(attachment.mimeType || resp.headers.get('content-type'));
    return {
      bytes,
      mimeType,
      filename: inferFilename(attachment.filename, mimeType),
      explicitType: attachment.explicitType
    };
  }
  const normalizedBase64 = attachment.source.replace(/\s+/g, '');
  const bytes = decodeBase64ToBytes(normalizedBase64);
  const mimeType = normalizeMimeType(attachment.mimeType);
  return {
    bytes,
    mimeType,
    filename: inferFilename(attachment.filename, mimeType),
    explicitType: attachment.explicitType
  };
}

type QwenHeaderOptions = {
  baseUrl?: string;
  refererMode?: 'web' | 'guest';
  acceptMode?: 'default' | 'json';
};

function qwenCommonHeaders(
  baxiaTokens: QwenBaxiaTokens,
  authHeaders?: Record<string, string>,
  options?: QwenHeaderOptions
): Record<string, string> {
  const forwardAuthHeaders = readBooleanEnv(
    ['ROUTECODEX_QWENCHAT_FORWARD_AUTH_HEADERS', 'RCC_QWENCHAT_FORWARD_AUTH_HEADERS'],
    false
  );
  const normalizedBase = normalizeInputString(options?.baseUrl) || DEFAULT_QWENCHAT_BASE_URL;
  const base = normalizedBase.replace(/\/$/, '');
  const referer = options?.refererMode === 'guest' ? `${base}/c/guest` : `${base}/`;
  const accept = options?.acceptMode === 'json' ? 'application/json' : 'application/json, text/plain, */*';
  return {
    'Accept': accept,
    'Content-Type': 'application/json',
    'bx-ua': baxiaTokens.bxUa,
    'bx-umidtoken': baxiaTokens.bxUmidToken,
    'bx-v': baxiaTokens.bxV,
    'source': 'web',
    'timezone': new Date().toUTCString(),
    'Referer': referer,
    'User-Agent': DEFAULT_QWENCHAT_USER_AGENT,
    'Accept-Language': DEFAULT_QWENCHAT_ACCEPT_LANGUAGE,
    'x-request-id': randomUUID(),
    ...(forwardAuthHeaders ? authHeaders || {} : {})
  };
}

function extractQwenErrorMessage(payload: Record<string, unknown>): string {
  const readNestedMessage = (value: unknown): string => {
    if (typeof value === 'string') {
      return normalizeInputString(value);
    }
    if (!isRecord(value)) {
      return '';
    }
    const nested = [
      normalizeInputString(value.message),
      normalizeInputString(value.msg),
      normalizeInputString(value.details),
      normalizeInputString(value.template),
      normalizeInputString(value.code),
      isRecord(value.error) ? normalizeInputString(value.error.message) : ''
    ].filter(Boolean);
    return nested[0] || '';
  };

  const readNode = (node: Record<string, unknown> | undefined): string => {
    if (!node) return '';
    const direct = [
      normalizeInputString(node.msg),
      normalizeInputString(node.message),
      normalizeInputString(node.error),
      normalizeInputString(node.err_msg),
      normalizeInputString(node.details),
      normalizeInputString(node.template),
      normalizeInputString(node.code)
    ].filter(Boolean);
    if (direct.length > 0) {
      return direct[0];
    }
    if (isRecord(node.error)) {
      const nested = [
        normalizeInputString(node.error.message),
        normalizeInputString(node.error.msg),
        normalizeInputString(node.error.details),
        normalizeInputString(node.error.template),
        normalizeInputString(node.error.code)
      ].filter(Boolean);
      if (nested.length > 0) {
        return nested[0];
      }
    }
    if (isRecord(node.details)) {
      const nestedDetails = readNestedMessage(node.details);
      if (nestedDetails) {
        return nestedDetails;
      }
    }
    return '';
  };

  const dataNode = isRecord(payload.data) ? payload.data : undefined;
  const detailsNode = isRecord(dataNode?.details) ? dataNode.details : undefined;
  return readNode(payload) || readNode(dataNode) || readNode(detailsNode) || '';
}

function extractQwenUploadTokenData(payload: Record<string, unknown>): QwenUploadTokenData | null {
  const tryReadNode = (node: unknown): QwenUploadTokenData | null => {
    if (!isRecord(node)) {
      return null;
    }

    const fileUrl =
      normalizeInputString(node.file_url) ||
      normalizeInputString(node.fileUrl) ||
      normalizeInputString(node.upload_url) ||
      normalizeInputString(node.uploadUrl) ||
      normalizeInputString(node.url);

    const accessKeyId =
      normalizeInputString(node.access_key_id) ||
      normalizeInputString(node.accessKeyId);
    const accessKeySecret =
      normalizeInputString(node.access_key_secret) ||
      normalizeInputString(node.accessKeySecret);
    const securityToken =
      normalizeInputString(node.security_token) ||
      normalizeInputString(node.securityToken);

    if (!fileUrl || !accessKeyId || !accessKeySecret || !securityToken) {
      return null;
    }

    return {
      file_url: fileUrl,
      file_id: normalizeInputString(node.file_id) || normalizeInputString(node.fileId) || undefined,
      access_key_id: accessKeyId,
      access_key_secret: accessKeySecret,
      security_token: securityToken
    };
  };

  const dataNode = isRecord(payload.data) ? payload.data : undefined;
  const resultNode = isRecord(payload.result) ? payload.result : undefined;
  const candidateNodes: unknown[] = [
    dataNode,
    isRecord(dataNode?.data) ? dataNode.data : undefined,
    isRecord(dataNode?.result) ? dataNode.result : undefined,
    resultNode,
    isRecord(resultNode?.data) ? resultNode.data : undefined,
    payload
  ];

  for (const node of candidateNodes) {
    const hit = tryReadNode(node);
    if (hit) {
      return hit;
    }
  }
  return null;
}

function throwQwenUploadTokenError(
  message: string,
  opts?: { statusCode?: number; code?: string }
): never {
  const err = new Error(message);
  (err as Error & { statusCode?: number; code?: string }).statusCode = opts?.statusCode ?? 502;
  (err as Error & { statusCode?: number; code?: string }).code = opts?.code || 'QWENCHAT_UPLOAD_TOKEN_FAILED';
  throw err;
}

async function requestUploadToken(
  baseUrl: string,
  file: LoadedAttachment,
  baxiaTokens: QwenBaxiaTokens,
  authHeaders?: Record<string, string>
): Promise<{ tokenData: QwenUploadTokenData; filetype: 'image' | 'audio' | 'video' | 'document' }> {
  const filetype = inferFileCategory(file.mimeType, file.explicitType);
  const resp = await fetch(joinUrl(baseUrl, '/api/v2/files/getstsToken'), {
    method: 'POST',
    headers: qwenCommonHeaders(baxiaTokens, authHeaders, { baseUrl, refererMode: 'web', acceptMode: 'default' }),
    body: JSON.stringify({
      filename: file.filename,
      filesize: file.bytes.length,
      filetype
    })
  });
  const parsed = await safeReadJsonResponse(resp);
  if (!parsed.ok || !resp.ok) {
    const preview = parsed.rawText.slice(0, 200).replace(/\s+/g, ' ').trim();
    const suffix = preview ? ` body=${preview}` : '';
    throwQwenUploadTokenError(`Failed to get qwen upload token: HTTP ${resp.status}${suffix}`, {
      statusCode: resp.ok ? 502 : resp.status,
      code: 'QWENCHAT_UPLOAD_TOKEN_HTTP_ERROR'
    });
  }

  const payload = parsed.data;
  if (payload.success === false) {
    const reason = extractQwenErrorMessage(payload);
    const dataNode = isRecord(payload.data) ? payload.data : undefined;
    const dataKeys = dataNode ? Object.keys(dataNode).slice(0, 8).join(',') : '';
    const preview = parsed.rawText.slice(0, 200).replace(/\s+/g, ' ').trim();
    const detail = [reason, dataKeys ? `keys=${dataKeys}` : '', preview ? `body=${preview}` : '']
      .filter(Boolean)
      .join(' ');
    throwQwenUploadTokenError(`Failed to get qwen upload token: ${detail || 'upstream rejected request'}`, {
      statusCode: 502,
      code: 'QWENCHAT_UPLOAD_TOKEN_REJECTED'
    });
  }

  const tokenData = extractQwenUploadTokenData(payload);
  if (!tokenData) {
    const dataNode = isRecord(payload.data) ? payload.data : undefined;
    const dataKeys = dataNode ? Object.keys(dataNode).slice(0, 8).join(',') : '';
    const preview = parsed.rawText.slice(0, 200).replace(/\s+/g, ' ').trim();
    const detail = [dataKeys ? `keys=${dataKeys}` : '', preview ? `body=${preview}` : '']
      .filter(Boolean)
      .join(' ');
    const suffix = detail ? ` (${detail})` : '';
    throwQwenUploadTokenError(`Failed to get qwen upload token: malformed response${suffix}`, {
      statusCode: 502,
      code: 'QWENCHAT_UPLOAD_TOKEN_MALFORMED'
    });
  }

  return {
    tokenData,
    filetype
  };
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function formatOssDate(date = new Date()): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`;
}

function formatOssDateScope(date = new Date()): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

function hmacSha256(key: Uint8Array, content: string | Uint8Array): Uint8Array {
  const hmac = createHmac('sha256', Buffer.from(key));
  hmac.update(typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content));
  return new Uint8Array(hmac.digest());
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function buildOssSignedHeaders(uploadUrl: string, tokenData: QwenUploadTokenData, file: LoadedAttachment): Record<string, string> {
  const parsedUrl = new URL(uploadUrl);
  const query = parsedUrl.searchParams;
  const credentialFromQuery = decodeURIComponent(query.get('x-oss-credential') || '');
  const credentialParts = credentialFromQuery.split('/');
  const dateScope = credentialParts[1] || formatOssDateScope();
  const region = credentialParts[2] || 'ap-southeast-1';
  const xOssDate = query.get('x-oss-date') || formatOssDate();

  const hostParts = parsedUrl.hostname.split('.');
  const bucket = hostParts.length > 0 ? hostParts[0] : '';
  const objectPath = parsedUrl.pathname || '/';
  const canonicalUri = bucket ? `/${bucket}${objectPath}` : objectPath;
  const xOssUserAgent = 'aliyun-sdk-js/6.23.0';
  const canonicalHeaders =
    [
      `content-type:${file.mimeType}`,
      'x-oss-content-sha256:UNSIGNED-PAYLOAD',
      `x-oss-date:${xOssDate}`,
      `x-oss-security-token:${tokenData.security_token}`,
      `x-oss-user-agent:${xOssUserAgent}`
    ].join('\n') + '\n';
  const canonicalRequest = ['PUT', canonicalUri, '', canonicalHeaders, '', 'UNSIGNED-PAYLOAD'].join('\n');
  const credentialScope = `${dateScope}/${region}/oss/aliyun_v4_request`;
  const stringToSign = ['OSS4-HMAC-SHA256', xOssDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmacSha256(Buffer.from(`aliyun_v4${tokenData.access_key_secret}`, 'utf8'), dateScope);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, 'oss');
  const kSigning = hmacSha256(kService, 'aliyun_v4_request');
  const signature = toHex(hmacSha256(kSigning, stringToSign));

  return {
    'Accept': '*/*',
    'Content-Type': file.mimeType,
    'authorization': `OSS4-HMAC-SHA256 Credential=${tokenData.access_key_id}/${credentialScope},Signature=${signature}`,
    'x-oss-content-sha256': 'UNSIGNED-PAYLOAD',
    'x-oss-date': xOssDate,
    'x-oss-security-token': tokenData.security_token,
    'x-oss-user-agent': xOssUserAgent,
    'Referer': `${DEFAULT_QWENCHAT_BASE_URL}/`
  };
}

async function uploadFileToQwenOss(file: LoadedAttachment, tokenData: QwenUploadTokenData): Promise<void> {
  const uploadUrl = normalizeInputString(tokenData.file_url).split('?')[0];
  if (!uploadUrl) {
    throw new Error('Upload failed: missing qwen oss upload url');
  }
  const signedHeaders = buildOssSignedHeaders(tokenData.file_url, tokenData, file);
  const resp = await fetch(uploadUrl, {
    method: 'PUT',
    headers: signedHeaders,
    body: Buffer.from(file.bytes)
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Upload failed with status ${resp.status}${detail ? `: ${detail}` : ''}`);
  }
}

function extractUploadedFileId(fileUrl: string): string {
  try {
    const pathname = decodeURIComponent(new URL(fileUrl).pathname);
    const filename = pathname.split('/').pop() || '';
    if (filename.includes('_')) {
      return filename.split('_')[0];
    }
  } catch (error: unknown) {
    logQwenChatHelpersNonBlocking('extractUploadedFileId.decode', error, { fileUrl });
  }
  return randomUUID();
}

function buildQwenFilePayload(
  file: LoadedAttachment,
  tokenData: QwenUploadTokenData,
  filetype: 'image' | 'audio' | 'video' | 'document'
): QwenFilePayload {
  const now = Date.now();
  const id = normalizeInputString(tokenData.file_id) || extractUploadedFileId(tokenData.file_url);
  const isDocument = filetype === 'document';
  const showType = isDocument ? 'file' : filetype;
  const fileClass = isDocument ? 'document' : filetype === 'image' ? 'vision' : filetype;
  return {
    type: showType,
    file: {
      created_at: now,
      data: {},
      filename: file.filename,
      hash: null,
      id,
      meta: {
        name: file.filename,
        size: file.bytes.length,
        content_type: file.mimeType
      },
      update_at: now
    },
    id,
    url: tokenData.file_url,
    name: file.filename,
    collection_name: '',
    progress: 0,
    status: 'uploaded',
    is_uploading: false,
    error: '',
    showType,
    file_class: fileClass,
    itemId: randomUUID(),
    greenNet: 'success',
    size: file.bytes.length,
    file_type: file.mimeType,
    uploadTaskId: randomUUID()
  };
}

async function ensureUploadStatusForNonVideo(
  baseUrl: string,
  filetype: 'image' | 'audio' | 'video' | 'document',
  baxiaTokens: QwenBaxiaTokens,
  authHeaders?: Record<string, string>
): Promise<void> {
  if (filetype === 'video') {
    return;
  }
  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const resp = await fetch(joinUrl(baseUrl, '/api/v2/users/status'), {
      method: 'POST',
      headers: qwenCommonHeaders(baxiaTokens, authHeaders, { baseUrl, refererMode: 'web', acceptMode: 'default' }),
      body: JSON.stringify({
        typarms: {
          typarm1: 'web',
          typarm2: '',
          typarm3: 'prod',
          typarm4: 'qwen_chat',
          typarm5: 'product',
          orgid: 'tongyi'
        }
      })
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`Upload status check failed with status ${resp.status}${detail ? `: ${detail}` : ''}`);
    }
    const payload = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
    if (payload.data === true) {
      return;
    }
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  throw new Error('Upload status not ready for non-video file');
}

async function parseDocumentIfNeeded(
  baseUrl: string,
  qwenFilePayload: QwenFilePayload,
  filetype: 'image' | 'audio' | 'video' | 'document',
  baxiaTokens: QwenBaxiaTokens,
  authHeaders?: Record<string, string>
): Promise<void> {
  if (filetype !== 'document') {
    return;
  }
  const fileId = normalizeInputString(qwenFilePayload.id);
  if (!fileId) {
    return;
  }
  const resp = await fetch(joinUrl(baseUrl, '/api/v2/files/parse'), {
    method: 'POST',
    headers: qwenCommonHeaders(baxiaTokens, authHeaders, { baseUrl, refererMode: 'web', acceptMode: 'default' }),
    body: JSON.stringify({ file_id: fileId })
  });
  const text = await resp.text().catch(() => '');
  if (!resp.ok) {
    throw new Error(`Document parse failed with status ${resp.status}${text ? `: ${text}` : ''}`);
  }
  if (text) {
    try {
      const payload = JSON.parse(text) as Record<string, unknown>;
      if (payload.success === false) {
        const message = normalizeInputString(payload.msg) || 'Document parse rejected';
        throw new Error(message);
      }
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
    }
  }
}

export async function uploadAttachments(args: {
  baseUrl: string;
  attachments: QwenMessageAttachment[];
  baxiaTokens: QwenBaxiaTokens;
  authHeaders?: Record<string, string>;
}): Promise<QwenUploadResult> {
  const files: QwenFilePayload[] = [];
  for (const rawAttachment of args.attachments) {
    const loaded = await loadAttachmentBytes(rawAttachment);
    const { tokenData, filetype } = await requestUploadToken(args.baseUrl, loaded, args.baxiaTokens, args.authHeaders);
    await uploadFileToQwenOss(loaded, tokenData);
    const qwenFilePayload = buildQwenFilePayload(loaded, tokenData, filetype);
    await ensureUploadStatusForNonVideo(args.baseUrl, filetype, args.baxiaTokens, args.authHeaders);
    await parseDocumentIfNeeded(args.baseUrl, qwenFilePayload, filetype, args.baxiaTokens, args.authHeaders);
    if (filetype === 'document') {
      await ensureUploadStatusForNonVideo(args.baseUrl, filetype, args.baxiaTokens, args.authHeaders);
    }
    files.push(qwenFilePayload);
  }
  return { files };
}

export function extractQwenChatPayload(request: UnknownObject): QwenChatPayload {
  const container = isRecord(request) ? request : {};
  const payload = isRecord(container.data) ? container.data : container;
  const runtimeMetadata = extractProviderRuntimeMetadata(request);
  const model = normalizeInputString(payload.model) || 'qwen3.6-plus';
  // OpenAI-responses format: input field (string or array of content parts)
  const inputField = payload.input;
  let inputMessages: Array<{ role: string; content: string }> = [];
  if (typeof inputField === 'string' && inputField.trim()) {
    inputMessages = [{ role: 'user', content: inputField }];
  } else if (Array.isArray(inputField)) {
    const content = inputField
      .filter((part: any) => typeof part?.text === 'string' || typeof part === 'string')
      .map((part: any) => typeof part === 'string' ? part : part.text)
      .join('\n');
    if (content.trim()) {
      inputMessages = [{ role: 'user', content }];
    }
  }
  const directMessages = Array.isArray(payload.messages) ? payload.messages : [];
  const compatPrompt = normalizeInputString(payload.prompt);
  const messages =
    directMessages.length > 0
      ? directMessages
      : inputMessages.length > 0
        ? inputMessages
        : compatPrompt
          ? [{ role: 'user', content: compatPrompt }]
          : [];
  const streamFlag = payload.stream;
  // Follow OpenAI semantics: stream defaults to false unless explicitly true.
  const stream = streamFlag === true;
  const metadata = isRecord(payload.metadata)
    ? (payload.metadata as Record<string, unknown>)
    : isRecord(container.metadata)
      ? (container.metadata as Record<string, unknown>)
      : runtimeMetadata?.metadata && isRecord(runtimeMetadata.metadata)
        ? (runtimeMetadata.metadata as Record<string, unknown>)
      : undefined;
  const tools =
    Array.isArray(payload.tools) && payload.tools.length > 0
      ? payload.tools
      : Array.isArray(container.tools) && container.tools.length > 0
        ? container.tools
        : readRuntimeCapturedToolsFromRequest(request);
  return {
    model,
    messages,
    stream,
    tools,
    metadata
  };
}

export function shouldUseSearchMode(payload: QwenChatPayload): boolean {
  if (parseQwenImageGenerationOptions(payload.metadata).enabled) {
    return false;
  }
  if (payload.metadata?.qwenWebSearch === true || payload.metadata?.webSearch === true) {
    return true;
  }
  return false;
}

function shouldUseImageGenerationMode(payload: QwenChatPayload): boolean {
  return parseQwenImageGenerationOptions(payload.metadata).enabled;
}

function extractChatIdFromCreatePayload(payload: Record<string, unknown>): string {
  const readChatIdFromText = (value: unknown): string => {
    const text = normalizeInputString(value);
    if (!text) {
      return '';
    }
    const namedMatch = text.match(
      /(?:chat[_-]?id|session[_-]?id|conversation[_-]?id)\s*[:=]\s*["']?([a-zA-Z0-9._:-]{8,})["']?/i
    );
    if (namedMatch?.[1]) {
      return namedMatch[1].trim();
    }
    return '';
  };

  const readDirect = (node: Record<string, unknown> | undefined): string => {
    if (!node) {
      return '';
    }
    return (
      normalizeInputString(node.id) ||
      normalizeInputString(node.chat_id) ||
      normalizeInputString(node.chatId) ||
      normalizeInputString(node.session_id) ||
      normalizeInputString(node.sessionId) ||
      normalizeInputString(node.conversation_id) ||
      normalizeInputString(node.conversationId) ||
      readChatIdFromText(node.details) ||
      readChatIdFromText(node.message) ||
      readChatIdFromText(node.msg)
    );
  };

  const root = payload;
  const dataNode = isRecord(root.data) ? root.data : undefined;
  const resultNode = isRecord(root.result) ? root.result : undefined;
  const chatNode = isRecord(dataNode?.chat) ? dataNode.chat : undefined;
  const dataDetailsNode = isRecord(dataNode?.details) ? dataNode.details : undefined;
  const resultDetailsNode = isRecord(resultNode?.details) ? resultNode.details : undefined;
  const rootDetailsNode = isRecord(root.details) ? root.details : undefined;
  const nestedDataNode = isRecord(dataNode?.data) ? dataNode.data : undefined;
  const nestedResultNode = isRecord(dataNode?.result) ? dataNode.result : undefined;
  const conversationNode = isRecord(dataNode?.conversation) ? dataNode.conversation : undefined;
  const sessionNode = isRecord(dataNode?.session) ? dataNode.session : undefined;

  return (
    readDirect(dataNode) ||
    readDirect(chatNode) ||
    readDirect(conversationNode) ||
    readDirect(sessionNode) ||
    readDirect(nestedDataNode) ||
    readDirect(nestedResultNode) ||
    readDirect(resultNode) ||
    readDirect(dataDetailsNode) ||
    readDirect(resultDetailsNode) ||
    readDirect(rootDetailsNode) ||
    readDirect(root)
  );
}

function extractCreateErrorMessage(payload: Record<string, unknown>): string {
  const reason = extractQwenErrorMessage(payload);
  if (reason) {
    return reason;
  }
  const dataNode = isRecord(payload.data) ? payload.data : undefined;
  const detailsNode = isRecord(dataNode?.details) ? dataNode.details : undefined;
  const detailsParts = [
    detailsNode ? normalizeInputString(detailsNode.message) : '',
    detailsNode ? normalizeInputString(detailsNode.msg) : '',
    detailsNode ? normalizeInputString(detailsNode.details) : '',
    detailsNode ? normalizeInputString(detailsNode.template) : '',
    detailsNode ? normalizeInputString(detailsNode.code) : ''
  ].filter(Boolean);
  return detailsParts[0] || '';
}

function inferCreateSessionStatusCode(payload: Record<string, unknown>, reason: string): number {
  const dataNode = isRecord(payload.data) ? payload.data : undefined;
  const normalized = [
    normalizeInputString(payload.code),
    normalizeInputString(dataNode?.code),
    reason
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (
    normalized.includes('ratelimit') ||
    normalized.includes('rate_limit') ||
    normalized.includes('daily usage limit') ||
    normalized.includes('allocated quota exceeded') ||
    normalized.includes('quota exceeded') ||
    normalized.includes('quota limit') ||
    normalized.includes('insufficient quota') ||
    normalized.includes('no resource') ||
    normalized.includes('resource exhausted') ||
    normalized.includes('too many request') ||
    normalized.includes('达到今日的使用上限') ||
    normalized.includes('请求过于频繁')
  ) {
    return 429;
  }
  if (
    normalized.includes('forbidden') ||
    normalized.includes('permission denied') ||
    normalized.includes('没有权限') ||
    normalized.includes('无权限') ||
    normalized.includes('permission')
  ) {
    return 403;
  }
  if (
    normalized.includes('unauthorized') ||
    normalized.includes('invalid token') ||
    normalized.includes('login') ||
    normalized.includes('auth') ||
    normalized.includes('未登录')
  ) {
    return 401;
  }
  return 502;
}

function shouldRetryQwenChatCreateSessionStatus(statusCode: number): boolean {
  return statusCode === 404
    || statusCode === 408
    || statusCode === 409
    || statusCode === 425
    || statusCode === 429
    || statusCode === 500
    || statusCode === 502
    || statusCode === 503
    || statusCode === 504;
}

function normalizeQwenChatCreateSessionBackoffKey(value: unknown): string {
  return normalizeInputString(value).toLowerCase();
}

async function maybeWaitQwenChatCreateSessionCooldown(backoffKey?: string): Promise<void> {
  const key = normalizeQwenChatCreateSessionBackoffKey(backoffKey);
  if (!key) {
    return;
  }
  const state = qwenChatCreateSessionBackoffState.get(key);
  if (!state) {
    return;
  }
  const waitMs = state.cooldownUntil - Date.now();
  if (waitMs > 0) {
    await sleep(waitMs);
  }
}

function markQwenChatCreateSessionSuccess(backoffKey?: string): void {
  const key = normalizeQwenChatCreateSessionBackoffKey(backoffKey);
  if (!key) {
    return;
  }
  qwenChatCreateSessionBackoffState.delete(key);
}

function markQwenChatCreateSessionRetryableFailure(backoffKey?: string): void {
  const key = normalizeQwenChatCreateSessionBackoffKey(backoffKey);
  if (!key) {
    return;
  }
  const previous = qwenChatCreateSessionBackoffState.get(key);
  const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
  const cooldownMs = Math.min(
    QWENCHAT_CREATE_SESSION_MAX_BACKOFF_MS,
    QWENCHAT_CREATE_SESSION_BASE_BACKOFF_MS * (2 ** Math.max(0, consecutiveFailures - 1))
  );
  qwenChatCreateSessionBackoffState.set(key, {
    consecutiveFailures,
    cooldownUntil: Date.now() + cooldownMs
  });
}

async function acquireQwenChatCreateSessionQueue(backoffKey?: string): Promise<() => void> {
  const key = normalizeQwenChatCreateSessionBackoffKey(backoffKey);
  if (!key) {
    return () => undefined;
  }
  const state = qwenChatCreateSessionQueueState.get(key) ?? { tail: Promise.resolve() };
  qwenChatCreateSessionQueueState.set(key, state);
  const waitFor = state.tail;
  let releaseQueue!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const queuedTail = waitFor.catch((error: unknown) => {
    logQwenChatHelpersNonBlocking('acquireQwenChatCreateSessionQueue.queuedTail', error, { key });
  }).then(() => current);
  state.tail = queuedTail;
  await waitFor.catch((error: unknown) => {
    logQwenChatHelpersNonBlocking('acquireQwenChatCreateSessionQueue.waitFor', error, { key });
  });
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    releaseQueue();
    if (qwenChatCreateSessionQueueState.get(key)?.tail === queuedTail) {
      qwenChatCreateSessionQueueState.delete(key);
    }
  };
}

type QwenUpstreamBusinessError = {
  message: string;
  statusCode: number;
  code: string;
};

type QwenUpstreamPreludeInspection = {
  replayStream?: NodeJS.ReadableStream;
  businessError?: QwenUpstreamBusinessError;
  toolContractError?: Error;
  rawCapture: string;
};

function detectQwenToolContractViolationFromSseRaw(args: {
  rawPayload: string;
  declaredToolNames?: string[];
}): Error | null {
  const declaredToolNames = normalizeToolNameSet(args.declaredToolNames);
  if (declaredToolNames.size === 0) {
    return null;
  }
  for (const line of args.rawPayload.split('\n')) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('data:')) {
      continue;
    }
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') {
      continue;
    }
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      const choiceNode = Array.isArray(parsed.choices) && parsed.choices.length > 0 && isRecord(parsed.choices[0])
        ? (parsed.choices[0] as Record<string, unknown>)
        : undefined;
      const deltaNode = choiceNode && isRecord(choiceNode.delta) ? choiceNode.delta : undefined;
      const violation = detectQwenToolContractViolation(deltaNode, declaredToolNames);
      if (violation) {
        return createQwenToolContractViolationError(violation, declaredToolNames);
      }
    } catch (error: unknown) {
      logQwenChatHelpersNonBlocking('detectQwenToolContractViolationFromSseRaw.parseLine', error);
      continue;
    }
  }
  return null;
}

function parseQwenUpstreamBusinessErrorFromRaw(rawPayload: string): QwenUpstreamBusinessError | null {
  const trimmed = rawPayload.trim();
  if (!trimmed || trimmed.startsWith('data:')) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (!isRecord(parsed)) {
      return null;
    }
    const success = parsed.success;
    const hasErrorNode = isRecord(parsed.error);
    const hasCode = Boolean(normalizeInputString(parsed.code));
    // Only treat as business rejection when payload explicitly signals failure.
    if (success !== false && !hasErrorNode && !hasCode) {
      return null;
    }
    const reason = extractQwenErrorMessage(parsed) || normalizeInputString(parsed.message) || 'upstream rejected request';
    const statusCode = inferCreateSessionStatusCode(parsed, reason);
    const code = statusCode === 429 ? 'QWENCHAT_RATE_LIMITED' : 'QWENCHAT_COMPLETION_REJECTED';
    return {
      message: `QwenChat upstream rejected completion request: ${reason}`,
      statusCode,
      code
    };
  } catch (error: unknown) {
    logQwenChatHelpersNonBlocking('parseQwenUpstreamBusinessErrorFromRaw.parse', error);
    return null;
  }
}


export function shouldFallbackToQwenSseForJsonModeError(rawPayload: string, error?: unknown): boolean {
  const code = normalizeInputString((error as { code?: string } | undefined)?.code).toUpperCase();
  if (code !== 'QWENCHAT_COMPLETION_REJECTED') {
    return false;
  }
  const businessError = parseQwenUpstreamBusinessErrorFromRaw(rawPayload);
  if (!businessError) {
    return false;
  }
  const normalizedMessage = businessError.message.trim().toLowerCase();
  if (!normalizedMessage.includes('internal error')) {
    return false;
  }
  try {
    const parsed = JSON.parse(rawPayload);
    if (!isRecord(parsed)) {
      return false;
    }
    const dataNode = isRecord(parsed.data) ? parsed.data : undefined;
    const errorCode = normalizeInputString(dataNode?.code || parsed.code).toLowerCase();
    return errorCode === 'bad_request';
  } catch (error: unknown) {
    logQwenChatHelpersNonBlocking('shouldFallbackToQwenSseForJsonModeError.parse', error);
    return false;
  }
}

function createQwenUpstreamBusinessError(error: QwenUpstreamBusinessError): Error {
  const err = new Error(error.message) as Error & {
    code?: string;
    status?: number;
    statusCode?: number;
    retryable?: boolean;
    upstreamCode?: string;
  };
  err.code = error.code;
  err.status = error.statusCode;
  err.statusCode = error.statusCode;
  err.retryable = error.statusCode === 429;
  err.upstreamCode = error.code;
  return err;
}

function looksLikeQwenSsePrelude(rawPayload: string): boolean {
  const trimmed = rawPayload.trimStart();
  return trimmed.startsWith('data:') || trimmed.startsWith('event:');
}

function looksLikePartialPrefix(candidate: string, target: string): boolean {
  if (!candidate) {
    return false;
  }
  return target.startsWith(candidate);
}

function looksLikeQwenPotentialSsePrelude(rawPayload: string): boolean {
  const trimmed = rawPayload.trimStart().toLowerCase();
  if (!trimmed) {
    return false;
  }
  return (
    looksLikePartialPrefix(trimmed, 'data:')
    || looksLikePartialPrefix(trimmed, 'event:')
  );
}

function looksLikeQwenPotentialJsonPrelude(rawPayload: string): boolean {
  const trimmed = rawPayload.trimStart();
  if (!trimmed) {
    return false;
  }
  const first = trimmed[0];
  return first === '{' || first === '[';
}

export async function inspectQwenUpstreamStreamPrelude(args: {
  upstreamStream: NodeJS.ReadableStream;
  maxInspectBytes?: number;
  settleMs?: number;
  declaredToolNames?: string[];
}): Promise<QwenUpstreamPreludeInspection> {
  const maxInspectBytes =
    typeof args.maxInspectBytes === 'number' && Number.isFinite(args.maxInspectBytes) && args.maxInspectBytes > 0
      ? Math.trunc(args.maxInspectBytes)
      : 4096;
  const settleMs =
    typeof args.settleMs === 'number' && Number.isFinite(args.settleMs) && args.settleMs >= 0
      ? Math.trunc(args.settleMs)
      : 80;
  const replay = new PassThrough();
  let buffer = '';
  let resolved = false;
  let mode: 'pending' | 'replay' | 'business_error' = 'pending';
  let timer: NodeJS.Timeout | null = null;

  const cleanupTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return await new Promise<QwenUpstreamPreludeInspection>((resolve, reject) => {
    const finalizeReplay = () => {
      if (resolved) {
        return;
      }
      resolved = true;
      mode = 'replay';
      cleanupTimer();
      if (buffer) {
        replay.write(buffer);
        buffer = '';
      }
      resolve({ replayStream: replay, rawCapture: '' });
    };

    const finalizeBusinessError = (businessError: QwenUpstreamBusinessError) => {
      if (resolved) {
        return;
      }
      resolved = true;
      mode = 'business_error';
      cleanupTimer();
      const rawCapture = buffer;
      try {
        const destroyFn = (args.upstreamStream as NodeJS.ReadableStream & { destroy?: (error?: Error) => void }).destroy;
        if (typeof destroyFn === 'function') {
          destroyFn.call(args.upstreamStream);
        }
      } catch (error: unknown) {
        logQwenChatHelpersNonBlocking('inspectUpstreamPrelude.finalizeBusinessError.destroy', error);
      }
      resolve({ businessError, rawCapture });
    };

    const finalizeToolContractError = (toolContractError: Error) => {
      if (resolved) {
        return;
      }
      resolved = true;
      mode = 'business_error';
      cleanupTimer();
      const rawCapture = buffer;
      try {
        const destroyFn = (args.upstreamStream as NodeJS.ReadableStream & { destroy?: (error?: Error) => void }).destroy;
        if (typeof destroyFn === 'function') {
          destroyFn.call(args.upstreamStream);
        }
      } catch (error: unknown) {
        logQwenChatHelpersNonBlocking('inspectUpstreamPrelude.finalizeToolContractError.destroy', error);
      }
      resolve({ toolContractError, rawCapture });
    };

    const inspectBuffer = () => {
      if (!buffer.trim()) {
        return;
      }
      const toolContractError = detectQwenToolContractViolationFromSseRaw({
        rawPayload: buffer,
        declaredToolNames: args.declaredToolNames
      });
      if (toolContractError) {
        finalizeToolContractError(toolContractError);
        return;
      }
      if (looksLikeQwenSsePrelude(buffer)) {
        finalizeReplay();
        return;
      }
      const businessError = parseQwenUpstreamBusinessErrorFromRaw(buffer);
      if (businessError) {
        finalizeBusinessError(businessError);
        return;
      }
      if (
        buffer.length < maxInspectBytes
        && (
          looksLikeQwenPotentialJsonPrelude(buffer)
          || looksLikeQwenPotentialSsePrelude(buffer)
        )
      ) {
        return;
      }
      if (buffer.length >= maxInspectBytes) {
        finalizeReplay();
      }
    };

    const onData = (chunk: Buffer | Uint8Array | string) => {
      const text = decodeStreamChunkUtf8(chunk);
      if (mode === 'replay') {
        replay.write(text);
        return;
      }
      if (mode === 'business_error') {
        return;
      }
      buffer += text;
      inspectBuffer();
    };

    const onEnd = () => {
      if (mode === 'replay') {
        replay.end();
        return;
      }
      const businessError = parseQwenUpstreamBusinessErrorFromRaw(buffer);
      if (businessError) {
        finalizeBusinessError(businessError);
        return;
      }
      const toolContractError = detectQwenToolContractViolationFromSseRaw({
        rawPayload: buffer,
        declaredToolNames: args.declaredToolNames
      });
      if (toolContractError) {
        finalizeToolContractError(toolContractError);
        return;
      }
      finalizeReplay();
      replay.end();
    };

    const onError = (error: unknown) => {
      cleanupTimer();
      if (mode === 'replay') {
        replay.destroy(error as Error);
        return;
      }
      reject(error);
    };

    args.upstreamStream.on('data', onData);
    args.upstreamStream.on('end', onEnd);
    args.upstreamStream.on('error', onError);

    timer = setTimeout(() => {
      if (mode === 'pending') {
        inspectBuffer();
        if (
          mode === 'pending'
          && !looksLikeQwenPotentialJsonPrelude(buffer)
          && !looksLikeQwenPotentialSsePrelude(buffer)
        ) {
          finalizeReplay();
        }
      }
    }, settleMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });
}

export async function createQwenChatSession(args: {
  baseUrl: string;
  model: string;
  chatType: 't2t' | 'search' | 't2i';
  baxiaTokens: QwenBaxiaTokens;
  authHeaders?: Record<string, string>;
  backoffKey?: string;
}): Promise<string> {
  const releaseQueue = await acquireQwenChatCreateSessionQueue(args.backoffKey);
  try {
    await maybeWaitQwenChatCreateSessionCooldown(args.backoffKey);
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < QWENCHAT_CREATE_SESSION_MAX_ATTEMPTS; attempt += 1) {
      const resp = await fetch(joinUrl(args.baseUrl, DEFAULT_QWENCHAT_CHAT_CREATE_ENDPOINT), {
        method: 'POST',
        headers: qwenCommonHeaders(args.baxiaTokens, args.authHeaders, {
          baseUrl: args.baseUrl,
          refererMode: 'guest',
          acceptMode: 'json'
        }),
        body: JSON.stringify({
          title: '新建对话',
          models: [args.model],
          chat_mode: 'guest',
          chat_type: args.chatType,
          timestamp: Date.now(),
          project_id: ''
        })
      });
      const parsed = await safeReadJsonResponse(resp);
      if (!parsed.ok || !resp.ok) {
        const bodyPreview = parsed.rawText.slice(0, 280).replace(/\s+/g, ' ').trim();
        const suffix = bodyPreview ? ` body=${bodyPreview}` : '';
        const err = new Error(`Failed to create qwenchat session: HTTP ${resp.status}${suffix}`) as Error & {
          statusCode?: number;
          code?: string;
          retryable?: boolean;
        };
        err.statusCode = resp.ok ? 502 : resp.status;
        err.code = 'QWENCHAT_CREATE_SESSION_FAILED';
        err.retryable = shouldRetryQwenChatCreateSessionStatus(err.statusCode ?? 0);
        if (err.retryable && attempt + 1 < QWENCHAT_CREATE_SESSION_MAX_ATTEMPTS) {
          lastError = err;
          await sleep(
            Math.min(
              QWENCHAT_CREATE_SESSION_MAX_BACKOFF_MS,
              QWENCHAT_CREATE_SESSION_BASE_BACKOFF_MS * (2 ** attempt)
            )
          );
          continue;
        }
        if (err.retryable) {
          markQwenChatCreateSessionRetryableFailure(args.backoffKey);
        }
        throw err;
      }
      const chatId = extractChatIdFromCreatePayload(parsed.data);
      const success = parsed.data.success === true;
      if (chatId) {
        markQwenChatCreateSessionSuccess(args.backoffKey);
        return chatId;
      }
      if (parsed.data.success === false) {
        const reason = extractCreateErrorMessage(parsed.data);
        const dataNode = isRecord(parsed.data.data) ? parsed.data.data : undefined;
        const dataKeys = dataNode ? Object.keys(dataNode).slice(0, 8).join(',') : '';
        const detail = [reason, dataKeys ? `keys=${dataKeys}` : ''].filter(Boolean).join(' ');
        const suffix = detail ? ` (${detail})` : '';
        const err = new Error(`Failed to create qwenchat session: upstream rejected request${suffix}`) as Error & {
          statusCode?: number;
          code?: string;
          retryable?: boolean;
        };
        err.statusCode = inferCreateSessionStatusCode(parsed.data, reason);
        err.code = 'QWENCHAT_CREATE_SESSION_REJECTED';
        err.retryable = shouldRetryQwenChatCreateSessionStatus(err.statusCode ?? 0);
        if (err.retryable && attempt + 1 < QWENCHAT_CREATE_SESSION_MAX_ATTEMPTS) {
          lastError = err;
          await sleep(
            Math.min(
              QWENCHAT_CREATE_SESSION_MAX_BACKOFF_MS,
              QWENCHAT_CREATE_SESSION_BASE_BACKOFF_MS * (2 ** attempt)
            )
          );
          continue;
        }
        if (err.retryable) {
          markQwenChatCreateSessionRetryableFailure(args.backoffKey);
        }
        throw err;
      }
      const reason = extractCreateErrorMessage(parsed.data);
      const dataNode = isRecord(parsed.data.data) ? parsed.data.data : undefined;
      const dataKeys = dataNode ? Object.keys(dataNode).slice(0, 8).join(',') : '';
      const detail = reason || (dataKeys ? `keys=${dataKeys}` : '') || (success ? 'success=true' : '');
      const suffix = detail ? ` (${detail})` : '';
      const err = new Error(`Failed to create qwenchat session: missing chat id${suffix}`) as Error & {
        statusCode?: number;
        code?: string;
        retryable?: boolean;
      };
      err.statusCode = 502;
      err.code = 'QWENCHAT_CREATE_SESSION_FAILED';
      err.retryable = true;
      if (attempt + 1 < QWENCHAT_CREATE_SESSION_MAX_ATTEMPTS) {
        lastError = err;
        await sleep(
          Math.min(
            QWENCHAT_CREATE_SESSION_MAX_BACKOFF_MS,
            QWENCHAT_CREATE_SESSION_BASE_BACKOFF_MS * (2 ** attempt)
          )
        );
        continue;
      }
      markQwenChatCreateSessionRetryableFailure(args.backoffKey);
      throw err;
    }

    if (lastError) {
      throw lastError;
    }
    const fallback = new Error('Failed to create qwenchat session: exhausted retries');
    (fallback as Error & { statusCode?: number; code?: string }).statusCode = 502;
    (fallback as Error & { statusCode?: number; code?: string }).code = 'QWENCHAT_CREATE_SESSION_FAILED';
    throw fallback;
  } finally {
    releaseQueue();
  }
}

export function buildQwenChatCompletionRequest(args: {
  chatId: string;
  model: string;
  content: string;
  uploadedFiles: QwenFilePayload[];
  chatType: 't2t' | 'search' | 't2i';
  hasDeclaredTools?: boolean;
  imageSize?: string;
  toolSearchSuppressionMode?: 'normal' | 'off' | 'none' | 'disable';
  stream?: boolean;
}): Record<string, unknown> {
  const enableThinking = !args.hasDeclaredTools;
  const researchMode = args.toolSearchSuppressionMode || (args.hasDeclaredTools ? 'off' : 'normal');
  const enableAutoSearch = args.chatType === 'search' && !args.hasDeclaredTools;
  const stream = args.stream !== false;
  const request: Record<string, unknown> = {
    stream,
    version: '2.1',
    incremental_output: stream,
    chat_id: args.chatId,
    chat_mode: 'guest',
    model: args.model,
    parent_id: null,
    messages: [
      {
        fid: randomUUID(),
        parentId: null,
        childrenIds: [randomUUID()],
        role: 'user',
        content: args.content,
        user_action: 'chat',
        files: args.uploadedFiles,
        timestamp: Date.now(),
        models: [args.model],
        chat_type: args.chatType,
        feature_config: {
          thinking_enabled: enableThinking,
          output_schema: 'phase',
          research_mode: researchMode,
          auto_thinking: enableThinking,
          ...(enableThinking
            ? {
                thinking_mode: 'Auto',
                thinking_format: 'summary'
              }
            : {}),
          auto_search: enableAutoSearch
        },
        extra: { meta: { subChatType: args.chatType } },
        sub_chat_type: args.chatType,
        parent_id: null
      }
    ],
    timestamp: Date.now()
  };
  if (args.chatType === 't2i' && args.imageSize) {
    request.size = args.imageSize;
  }
  return request;
}

function extractReasoningContentFromDelta(delta: Record<string, unknown>): string {
  const direct = normalizeInputString(delta.reasoning_content || delta.reasoning);
  if (direct) {
    return direct;
  }
  const phase = normalizeInputString(delta.phase);
  if (phase !== 'thinking_summary') {
    return '';
  }
  const extra = isRecord(delta.extra) ? delta.extra : undefined;
  const summaryThought = extra && isRecord(extra.summary_thought) ? extra.summary_thought : undefined;
  const content = summaryThought?.content;
  if (typeof content === 'string') {
    return normalizeInputString(content);
  }
  if (Array.isArray(content)) {
    const parts = content
      .map((item) => {
        if (typeof item === 'string') return normalizeInputString(item);
        if (isRecord(item)) return normalizeInputString(item.text || item.content || item.value);
        return '';
      })
      .filter(Boolean);
    return parts.join('\n');
  }
  return '';
}

function stringifyToolArguments(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined) {
    return '';
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function extractOpenAiStyleToolCallsFromDelta(deltaRaw: Record<string, unknown>): Array<Record<string, unknown>> {
  const toolCallsRaw = Array.isArray(deltaRaw.tool_calls) ? deltaRaw.tool_calls : [];
  if (toolCallsRaw.length === 0) {
    return [];
  }
  const mapped: Array<Record<string, unknown>> = [];
  for (const entryRaw of toolCallsRaw) {
    if (!isRecord(entryRaw)) {
      continue;
    }
    const functionNode = isRecord(entryRaw.function) ? entryRaw.function : undefined;
    const name =
      normalizeInputString(functionNode?.name)
      || normalizeInputString(entryRaw.name);
    const id =
      normalizeInputString(entryRaw.id)
      || normalizeInputString(functionNode?.id);
    const argumentsValue = stringifyToolArguments(
      functionNode?.arguments ?? entryRaw.arguments ?? entryRaw.input
    );
    const index =
      typeof entryRaw.index === 'number' && Number.isFinite(entryRaw.index)
        ? Math.trunc(entryRaw.index)
        : undefined;
    if (!name && !id && !argumentsValue) {
      continue;
    }
    mapped.push({
      ...(index !== undefined ? { index } : {}),
      ...(id ? { id } : {}),
      type: 'function',
      function: {
        ...(name ? { name } : {}),
        ...(argumentsValue ? { arguments: argumentsValue } : {})
      }
    });
  }
  return mapped;
}

function mapUpstreamDeltaToOpenAi(deltaRaw: unknown): DeltaRecord | null {
  if (!isRecord(deltaRaw)) {
    return null;
  }
  const mapped: DeltaRecord = {};
  if (normalizeInputString(deltaRaw.role) === 'assistant') {
    mapped.role = 'assistant';
  }
  const content = normalizeInputString(deltaRaw.content);
  if (content) {
    mapped.content = content;
  }
  const reasoning = extractReasoningContentFromDelta(deltaRaw);
  if (reasoning) {
    mapped.reasoning_content = reasoning;
  }
  const toolCalls = extractOpenAiStyleToolCallsFromDelta(deltaRaw);
  if (toolCalls.length > 0) {
    mapped.tool_calls = toolCalls;
  }
  const functionCallNode = isRecord(deltaRaw.function_call) ? deltaRaw.function_call : undefined;
  if (functionCallNode && toolCalls.length === 0) {
    const name = normalizeInputString(functionCallNode.name);
    const functionId =
      normalizeInputString((deltaRaw as Record<string, unknown>).function_id) ||
      normalizeInputString(functionCallNode.id);
    const argumentsValue = stringifyToolArguments(functionCallNode.arguments);
    if (name || functionId || argumentsValue) {
      mapped.function_call = {
        ...(functionId ? { id: functionId } : {}),
        ...(name ? { name } : {}),
        ...(argumentsValue ? { arguments: argumentsValue } : {})
      };
    }
  }
  const phase = normalizeInputString((deltaRaw as Record<string, unknown>).phase);
  if (phase) {
    mapped.phase = phase;
  }
  return Object.keys(mapped).length > 0 ? mapped : null;
}

function mapUsageToOpenAi(usageRaw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(usageRaw)) {
    return undefined;
  }
  const inputTokens = Number(usageRaw.input_tokens || 0);
  const outputTokens = Number(usageRaw.output_tokens || 0);
  const totalTokens = Number(usageRaw.total_tokens || inputTokens + outputTokens);
  const usage: Record<string, unknown> = {
    prompt_tokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    completion_tokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    total_tokens: Number.isFinite(totalTokens) ? totalTokens : 0
  };
  if (isRecord(usageRaw.input_tokens_details) && Object.keys(usageRaw.input_tokens_details).length > 0) {
    usage.prompt_tokens_details = usageRaw.input_tokens_details;
  }
  if (isRecord(usageRaw.output_tokens_details) && Object.keys(usageRaw.output_tokens_details).length > 0) {
    usage.completion_tokens_details = usageRaw.output_tokens_details;
  }
  return usage;
}

function createOpenAiChunk(args: {
  id: string;
  created: number;
  model: string;
  delta: DeltaRecord;
  finishReason: string | null;
  usage?: Record<string, unknown>;
}): Record<string, unknown> {
  const chunk: Record<string, unknown> = {
    id: args.id,
    object: 'chat.completion.chunk',
    created: args.created,
    model: args.model,
    choices: [
      {
        index: 0,
        delta: args.delta,
        finish_reason: args.finishReason
      }
    ]
  };
  if (args.usage) {
    chunk.usage = args.usage;
  }
  return chunk;
}

function processQwenSsePayloadLines(args: {
  payload: string;
  onChunk: (chunk: Record<string, unknown>) => void;
  onDone: () => void;
  onFinishReason?: (reason: string) => void;
  onDataFrame?: () => void;
  onIgnoredFrame?: () => void;
  onToolCallFrame?: () => void;
  includeFinishReason?: boolean;
  collect?: {
    contentParts: string[];
    reasoningParts: string[];
    imageUrls: string[];
    functionCallRef: { call?: CollectedFunctionCall };
    toolCallsRef: { calls: CollectedToolCall[] };
    usageRef: { usage?: Record<string, unknown> };
  };
  responseId: string;
  created: number;
  model: string;
  declaredToolNames?: Set<string>;
}): void {
  for (const line of args.payload.split('\n')) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (!data) continue;
    if (data === '[DONE]') {
      args.onDone();
      continue;
    }
    args.onDataFrame?.();
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      const businessError = parseQwenUpstreamBusinessErrorFromRaw(JSON.stringify(parsed));
      if (businessError) {
        throw createQwenUpstreamBusinessError(businessError);
      }
      const choiceNode = Array.isArray(parsed.choices) && parsed.choices.length > 0 && isRecord(parsed.choices[0])
        ? (parsed.choices[0] as Record<string, unknown>)
        : undefined;
      const deltaNode = choiceNode && isRecord(choiceNode.delta) ? choiceNode.delta : undefined;
      const toolContractViolation = detectQwenToolContractViolation(deltaNode, args.declaredToolNames || new Set<string>());
      if (toolContractViolation) {
        throw createQwenToolContractViolationError(toolContractViolation, args.declaredToolNames || new Set<string>());
      }
      const delta = mapUpstreamDeltaToOpenAi(deltaNode);
      const hasToolCallDelta =
        Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0
          ? true
          : Boolean(delta && isRecord(delta.function_call));
      if (hasToolCallDelta) {
        args.onToolCallFrame?.();
      }
      const finishReason = normalizeInputString(choiceNode?.finish_reason) || null;
      if (finishReason && args.onFinishReason) {
        args.onFinishReason(finishReason);
      }
      const usage = mapUsageToOpenAi(parsed.usage);
      if (usage && args.collect) {
        args.collect.usageRef.usage = usage;
      }
      if (delta && args.collect) {
        const content = normalizeInputString(delta.content);
        if (content) args.collect.contentParts.push(content);
        const reasoning = normalizeInputString(delta.reasoning_content);
        if (reasoning) args.collect.reasoningParts.push(reasoning);
        const toolCallNodes = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
        if (toolCallNodes.length > 0) {
          const phase = normalizeInputString(delta.phase);
          for (const entryRaw of toolCallNodes) {
            if (!isRecord(entryRaw)) {
              continue;
            }
            const index =
              typeof entryRaw.index === 'number' && Number.isFinite(entryRaw.index)
                ? Math.trunc(entryRaw.index)
                : 0;
            const functionNode = isRecord(entryRaw.function) ? entryRaw.function : undefined;
            const existing =
              args.collect.toolCallsRef.calls.find((item) => item.index === index)
              || { index, argumentsText: '' };
            const nextId =
              normalizeInputString(entryRaw.id)
              || normalizeInputString(functionNode?.id)
              || existing.id;
            const nextName =
              normalizeInputString(functionNode?.name)
              || normalizeInputString(entryRaw.name)
              || existing.name;
            const nextArgs =
              existing.argumentsText +
              normalizeInputString(
                stringifyToolArguments(functionNode?.arguments ?? entryRaw.arguments ?? entryRaw.input)
              );
            const nextPhase = phase || existing.phase;
            const next: CollectedToolCall = {
              index,
              ...(nextId ? { id: nextId } : {}),
              ...(nextName ? { name: nextName } : {}),
              argumentsText: nextArgs,
              ...(nextPhase ? { phase: nextPhase } : {})
            };
            const existingIndex = args.collect.toolCallsRef.calls.findIndex((item) => item.index === index);
            if (existingIndex >= 0) {
              args.collect.toolCallsRef.calls[existingIndex] = next;
            } else {
              args.collect.toolCallsRef.calls.push(next);
            }
          }
        }
        const functionCallNode = isRecord(delta.function_call) ? delta.function_call : undefined;
        if (functionCallNode) {
          const existing = args.collect.functionCallRef.call || { argumentsText: '' };
          const nextId = normalizeInputString(functionCallNode.id) || existing.id;
          const nextName = normalizeInputString(functionCallNode.name) || existing.name;
          const nextArgs = existing.argumentsText + normalizeInputString(functionCallNode.arguments);
          const nextPhase = normalizeInputString(delta.phase) || existing.phase;
          args.collect.functionCallRef.call = {
            ...(nextId ? { id: nextId } : {}),
            ...(nextName ? { name: nextName } : {}),
            argumentsText: nextArgs,
            ...(nextPhase ? { phase: nextPhase } : {})
          };
        }
      }
      if (args.collect && deltaNode) {
        const phase = normalizeInputString((deltaNode as Record<string, unknown>).phase);
        const rawContent = normalizeInputString((deltaNode as Record<string, unknown>).content);
        if (phase === 'image_gen' && /^https?:\/\//i.test(rawContent)) {
          args.collect.imageUrls.push(rawContent);
        }
      }
      if (delta || finishReason || usage) {
        const deltaForEmit = delta ? { ...delta } : {};
        args.onChunk(
          createOpenAiChunk({
            id: args.responseId,
            created: args.created,
            model: args.model,
            delta: deltaForEmit,
            finishReason: args.includeFinishReason === false ? null : finishReason,
            usage
          })
        );
      } else {
        args.onIgnoredFrame?.();
      }
    } catch (error) {
      if (String((error as { code?: string } | undefined)?.code || '').startsWith('QWENCHAT_')) {
        throw error;
      }
      // ignore malformed data line
    }
  }
}

export function createOpenAiMappedSseStream(input: QwenSseChunkWriterInput): NodeJS.ReadableStream {
  const output = new PassThrough();
  const probe = createQwenChatSseProbe();
  (output as NodeJS.ReadableStream & { [QWENCHAT_SSE_PROBE_WRAPPER_KEY]?: QwenChatSseProbe })[
    QWENCHAT_SSE_PROBE_WRAPPER_KEY
  ] = probe;
  const responseId = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let doneWritten = false;
  let buffer = '';
  const usageRef: { usage?: Record<string, unknown> } = {};
  const functionCallRef: { call?: CollectedFunctionCall } = {};
  const toolCallsRef: { calls: CollectedToolCall[] } = { calls: [] };
  let lastUpstreamFinishReason: string | null = null;
  let terminatedByHiddenNativeTool = false;
  const declaredToolNames = normalizeToolNameSet(input.declaredToolNames);

  const writeDone = () => {
    if (doneWritten) return;
    doneWritten = true;
    output.write('data: [DONE]\n\n');
  };

  const markTerminalQwenError = (error: unknown) => {
    const err =
      error instanceof Error
        ? (error as Error & {
            code?: string;
            status?: number;
            statusCode?: number;
            retryable?: boolean;
            toolName?: string;
            phase?: string;
            upstreamCode?: string;
          })
        : undefined;
    const streamState = output as NodeJS.ReadableStream & {
      __routecodexTerminalError?: Record<string, unknown>;
    };
    streamState.__routecodexTerminalError = {
      message: err?.message || String(error),
      code: err?.code || err?.upstreamCode || 'QWENCHAT_COMPLETION_REJECTED',
      status: err?.statusCode ?? err?.status ?? 502,
      statusCode: err?.statusCode ?? err?.status ?? 502,
      retryable: err?.retryable ?? false,
      ...(typeof err?.toolName === 'string' && err.toolName.trim() ? { toolName: err.toolName.trim() } : {}),
      ...(typeof err?.phase === 'string' && err.phase.trim() ? { phase: err.phase.trim() } : {})
    };
    probe.terminalErrorCode = err?.code || err?.upstreamCode || 'QWENCHAT_COMPLETION_REJECTED';
  };

  const emitTerminalQwenError = (error: unknown): void => {
    terminatedByHiddenNativeTool = true;
    markTerminalQwenError(error);
    const err =
      error instanceof Error
        ? (error as Error & { code?: string; status?: number; statusCode?: number })
        : undefined;
    output.write(
      `data: ${JSON.stringify({
        error: {
          message: error instanceof Error ? error.message : String(error),
          code: err?.code || 'QWENCHAT_COMPLETION_REJECTED',
          status: err?.statusCode ?? err?.status ?? 502
        }
      })}\n\n`
    );
    writeDone();
    output.end();
    const destroyFn = (input.upstreamStream as NodeJS.ReadableStream & { destroy?: (error?: Error) => void }).destroy;
    if (typeof destroyFn === 'function') {
      destroyFn.call(input.upstreamStream);
    }
  };

  input.upstreamStream.on('data', (chunk: Buffer | Uint8Array | string) => {
    if (terminatedByHiddenNativeTool) {
      return;
    }
    probe.upstreamChunkCount += 1;
    markFirstProbeLatency(probe, 'firstUpstreamChunkMs');
    buffer += decodeStreamChunkUtf8(chunk);
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      try {
        processQwenSsePayloadLines({
          payload: `${line}\n`,
          onChunk: (mappedChunk) => {
            probe.emittedChunkCount += 1;
            markFirstProbeLatency(probe, 'firstEmitMs');
            output.write(`data: ${JSON.stringify(mappedChunk)}\n\n`);
          },
          onDone: () => {
            // defer done to stream end, so harvest-produced final tool_calls can be emitted first.
          },
          onFinishReason: (reason) => {
            lastUpstreamFinishReason = reason;
          },
          onDataFrame: () => {
            probe.dataFrameCount += 1;
            markFirstProbeLatency(probe, 'firstDataFrameMs');
          },
          onIgnoredFrame: () => {
            probe.ignoredFrameCount += 1;
          },
          onToolCallFrame: () => {
            markFirstProbeLatency(probe, 'firstToolCallMs');
          },
          includeFinishReason: false,
          collect: { contentParts: [], reasoningParts: [], imageUrls: [], functionCallRef, toolCallsRef, usageRef },
          responseId,
          created,
          model: input.model,
          declaredToolNames
        });
      } catch (error) {
        if (String((error as { code?: string } | undefined)?.code || '').startsWith('QWENCHAT_')) {
          emitTerminalQwenError(error);
          return;
        }
        throw error;
      }
    }
  });

  input.upstreamStream.on('end', () => {
    if (terminatedByHiddenNativeTool) {
      return;
    }
    probe.upstreamDoneMs = elapsedSince(probe.startedAtMs);
    if (buffer.trim()) {
      try {
        processQwenSsePayloadLines({
          payload: buffer,
          onChunk: (mappedChunk) => {
            probe.emittedChunkCount += 1;
            markFirstProbeLatency(probe, 'firstEmitMs');
            output.write(`data: ${JSON.stringify(mappedChunk)}\n\n`);
          },
          onDone: () => {
            // defer done to stream end, so harvest-produced final tool_calls can be emitted first.
          },
          onFinishReason: (reason) => {
            lastUpstreamFinishReason = reason;
          },
          onDataFrame: () => {
            probe.dataFrameCount += 1;
            markFirstProbeLatency(probe, 'firstDataFrameMs');
          },
          onIgnoredFrame: () => {
            probe.ignoredFrameCount += 1;
          },
          onToolCallFrame: () => {
            markFirstProbeLatency(probe, 'firstToolCallMs');
          },
          includeFinishReason: false,
          collect: { contentParts: [], reasoningParts: [], imageUrls: [], functionCallRef, toolCallsRef, usageRef },
          responseId,
          created,
          model: input.model,
          declaredToolNames
        });
      } catch (error) {
        if (String((error as { code?: string } | undefined)?.code || '').startsWith('QWENCHAT_')) {
          emitTerminalQwenError(error);
          return;
        }
        throw error;
      }
      const upstreamBusinessError = parseQwenUpstreamBusinessErrorFromRaw(buffer);
      if (upstreamBusinessError) {
        emitTerminalQwenError(createQwenUpstreamBusinessError(upstreamBusinessError));
        return;
      }
    }
    const finalFinishReason =
      toolCallsRef.calls.some((call) => call.name || call.argumentsText)
        ? 'tool_calls'
        : functionCallRef.call && (functionCallRef.call.name || functionCallRef.call.argumentsText)
        ? 'tool_calls'
        : (lastUpstreamFinishReason || 'stop');
    output.write(
      `data: ${JSON.stringify(
        createOpenAiChunk({
          id: responseId,
          created,
          model: input.model,
          delta: {},
          finishReason: finalFinishReason,
          usage: usageRef.usage
        })
      )}\n\n`
    );
    writeDone();
    output.end();
  });

  input.upstreamStream.on('error', (error) => {
    probe.upstreamDoneMs = elapsedSince(probe.startedAtMs);
    if (!probe.terminalErrorCode) {
      probe.terminalErrorCode =
        error instanceof Error && typeof (error as { code?: unknown }).code === 'string'
          ? String((error as { code?: string }).code)
          : 'UPSTREAM_STREAM_ERROR';
    }
    output.write(`data: ${JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } })}\n\n`);
    writeDone();
    output.end();
  });

  return output;
}

export async function collectQwenSseAsOpenAiResult(args: {
  upstreamStream: NodeJS.ReadableStream;
  model: string;
  rawCaptureRef?: { raw?: string };
  declaredToolNames?: string[];
}): Promise<Record<string, unknown>> {
  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  const imageUrls: string[] = [];
  const functionCallRef: { call?: CollectedFunctionCall } = {};
  const toolCallsRef: { calls: CollectedToolCall[] } = { calls: [] };
  const usageRef: { usage?: Record<string, unknown> } = {};
  let buffer = '';
  let rawPayload = '';
  const declaredToolNames = normalizeToolNameSet(args.declaredToolNames);

  await new Promise<void>((resolve, reject) => {
    const processPayload = (payload: string): void => {
      if (!payload) {
        return;
      }
      processQwenSsePayloadLines({
        payload,
        onChunk: () => {
          // no-op in aggregate mode
        },
        onDone: () => {
          // no-op in aggregate mode
        },
        collect: { contentParts, reasoningParts, imageUrls, functionCallRef, toolCallsRef, usageRef },
        responseId: `chatcmpl-${randomUUID()}`,
        created: Math.floor(Date.now() / 1000),
        model: args.model,
        declaredToolNames
      });
    };
    const abortUpstream = (error?: unknown): void => {
      const destroyFn = (args.upstreamStream as NodeJS.ReadableStream & { destroy?: (err?: Error) => void }).destroy;
      if (typeof destroyFn !== 'function') {
        return;
      }
      destroyFn.call(
        args.upstreamStream,
        error instanceof Error ? error : undefined
      );
    };
    args.upstreamStream.on('data', (chunk: Buffer | Uint8Array | string) => {
      const decoded = decodeStreamChunkUtf8(chunk);
      buffer += decoded;
      rawPayload += decoded;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      try {
        for (const line of lines) {
          processPayload(`${line}\n`);
        }
      } catch (error) {
        abortUpstream(error);
        reject(error);
      }
    });
    args.upstreamStream.on('end', () => {
      try {
        processPayload(buffer);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    args.upstreamStream.on('error', reject);
  });

  if (args.rawCaptureRef) {
    args.rawCaptureRef.raw = rawPayload;
  }

  const upstreamBusinessError = parseQwenUpstreamBusinessErrorFromRaw(rawPayload);
  if (upstreamBusinessError) {
    const err = new Error(upstreamBusinessError.message);
    (err as Error & { statusCode?: number; code?: string }).statusCode = upstreamBusinessError.statusCode;
    (err as Error & { statusCode?: number; code?: string }).code = upstreamBusinessError.code;
    throw err;
  }

  const dedupImageUrls = Array.from(new Set(imageUrls));
  const aggregatedContent = dedupImageUrls.length > 0
    ? dedupImageUrls.join('\n')
    : contentParts.join('');

  const result: Record<string, unknown> = {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: args.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: aggregatedContent,
          ...(reasoningParts.length ? { reasoning_content: reasoningParts.join('') } : {}),
          ...(toolCallsRef.calls.length > 0
            ? {
                tool_calls: toolCallsRef.calls
                  .slice()
                  .sort((a, b) => a.index - b.index)
                  .map((call) => ({
                    id: call.id || `call_qwenchat_${call.index + 1}`,
                    type: 'function',
                    function: {
                      ...(call.name ? { name: call.name } : {}),
                      arguments: call.argumentsText || ''
                    }
                  }))
              }
            : functionCallRef.call && (functionCallRef.call.name || functionCallRef.call.argumentsText)
            ? {
                function_call: {
                  ...(functionCallRef.call.id ? { id: functionCallRef.call.id } : {}),
                  ...(functionCallRef.call.name ? { name: functionCallRef.call.name } : {}),
                  arguments: functionCallRef.call.argumentsText || ''
                }
              }
            : {}),
          ...(functionCallRef.call?.phase ? { phase: functionCallRef.call.phase } : {})
        },
        finish_reason:
          toolCallsRef.calls.some((call) => call.name || call.argumentsText)
            ? 'tool_calls'
            : functionCallRef.call && (functionCallRef.call.name || functionCallRef.call.argumentsText)
            ? 'tool_calls'
            : 'stop'
      }
    ]
  };
  if (usageRef.usage) {
    result.usage = usageRef.usage;
  }
  const firstChoice =
    Array.isArray(result.choices) && result.choices.length > 0 && isRecord(result.choices[0])
      ? (result.choices[0] as Record<string, unknown>)
      : undefined;
  const messageNode = firstChoice && isRecord(firstChoice.message) ? (firstChoice.message as Record<string, unknown>) : undefined;
  const finishReason = normalizeInputString(firstChoice?.finish_reason) || 'stop';
  const content = normalizeInputString(messageNode?.content);
  const reasoning = normalizeInputString(messageNode?.reasoning_content);
  const functionCall = messageNode && isRecord(messageNode.function_call) ? messageNode.function_call : undefined;
  const toolCalls = messageNode && Array.isArray(messageNode.tool_calls) ? messageNode.tool_calls : [];
  if (finishReason === 'stop' && !content && !reasoning && !functionCall && toolCalls.length === 0) {
    const err = new Error('QwenChat upstream returned an empty assistant message');
    (err as Error & { statusCode?: number; code?: string }).statusCode = 502;
    (err as Error & { statusCode?: number; code?: string }).code = 'QWENCHAT_EMPTY_ASSISTANT';
    throw err;
  }
  return result;
}

export function collectQwenJsonAsOpenAiResult(args: {
  payload: unknown;
  model: string;
  declaredToolNames?: string[];
}): Record<string, unknown> {
  const declaredToolNames = normalizeToolNameSet(args.declaredToolNames);
  const payload =
    typeof args.payload === 'string'
      ? (() => {
          try {
            return JSON.parse(args.payload) as unknown;
          } catch {
            return args.payload;
          }
        })()
      : args.payload;
  if (!isRecord(payload)) {
    const err = new Error('QwenChat upstream returned a non-JSON non-stream completion payload');
    (err as Error & { statusCode?: number; code?: string }).statusCode = 502;
    (err as Error & { statusCode?: number; code?: string }).code = 'QWENCHAT_NON_STREAM_INVALID_PAYLOAD';
    throw err;
  }
  const businessError = parseQwenUpstreamBusinessErrorFromRaw(JSON.stringify(payload));
  if (businessError) {
    throw createQwenUpstreamBusinessError(businessError);
  }
  const candidate =
    Array.isArray(payload.choices)
      ? payload
      : isRecord(payload.data) && Array.isArray(payload.data.choices)
        ? (payload.data as Record<string, unknown>)
        : payload;
  const choiceNode = Array.isArray(candidate.choices) && candidate.choices.length > 0 && isRecord(candidate.choices[0])
    ? (candidate.choices[0] as Record<string, unknown>)
    : undefined;
  if (!choiceNode) {
    const err = new Error('QwenChat non-stream response is missing choices[0]');
    (err as Error & { statusCode?: number; code?: string }).statusCode = 502;
    (err as Error & { statusCode?: number; code?: string }).code = 'QWENCHAT_NON_STREAM_INVALID_PAYLOAD';
    throw err;
  }

  const messageNode = isRecord(choiceNode.message) ? choiceNode.message : undefined;
  const deltaNode = isRecord(choiceNode.delta) ? choiceNode.delta : undefined;
  const violationFromDelta = detectQwenToolContractViolation(deltaNode, declaredToolNames);
  if (violationFromDelta) {
    throw createQwenToolContractViolationError(violationFromDelta, declaredToolNames);
  }
  if (messageNode && declaredToolNames.size > 0) {
    const phase = normalizeInputString(messageNode.phase);
    const functionCallNode = isRecord(messageNode.function_call) ? messageNode.function_call : undefined;
    const toolCallsRaw = Array.isArray(messageNode.tool_calls) ? messageNode.tool_calls : [];
    const nativeName =
      normalizeInputString(functionCallNode?.name)
      || toolCallsRaw
          .map((entryRaw) => {
            if (!isRecord(entryRaw)) return '';
            const functionNode = isRecord(entryRaw.function) ? entryRaw.function : undefined;
            return normalizeInputString(functionNode?.name) || normalizeInputString(entryRaw.name);
          })
          .find(Boolean);
    if (nativeName && !declaredToolNames.has(nativeName.toLowerCase())) {
      throw createQwenToolContractViolationError(
        {
          kind:
            KNOWN_QWEN_HIDDEN_NATIVE_TOOLS.has(nativeName.toLowerCase()) || !declaredToolNames.has(nativeName.toLowerCase())
              ? 'hidden_native_tool'
              : 'native_tool_call',
          name: nativeName,
          ...(phase ? { phase } : {})
        },
        declaredToolNames
      );
    }
  }
  if (messageNode) {
    const result: Record<string, unknown> = {
      id: normalizeInputString(candidate.id) || `chatcmpl-${randomUUID()}`,
      object: normalizeInputString(candidate.object) || 'chat.completion',
      created:
        typeof candidate.created === 'number' && Number.isFinite(candidate.created)
          ? candidate.created
          : Math.floor(Date.now() / 1000),
      model: normalizeInputString(candidate.model) || args.model,
      choices: [
        {
          index:
            typeof choiceNode.index === 'number' && Number.isFinite(choiceNode.index)
              ? choiceNode.index
              : 0,
          message: messageNode,
          finish_reason: normalizeInputString(choiceNode.finish_reason) || 'stop'
        }
      ]
    };
    if (isRecord(candidate.usage)) {
      result.usage = candidate.usage;
    }
    return result;
  }

  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  const imageUrls: string[] = [];
  const functionCallRef: { call?: CollectedFunctionCall } = {};
  const toolCallsRef: { calls: CollectedToolCall[] } = { calls: [] };
  const usageRef: { usage?: Record<string, unknown> } = {};
  processQwenSsePayloadLines({
    payload: `data: ${JSON.stringify({
      choices: [choiceNode],
      ...(isRecord(candidate.usage) ? { usage: candidate.usage } : {})
    })}\n`,
    onChunk: () => {},
    onDone: () => {},
    collect: { contentParts, reasoningParts, imageUrls, functionCallRef, toolCallsRef, usageRef },
    responseId: `chatcmpl-${randomUUID()}`,
    created: Math.floor(Date.now() / 1000),
    model: normalizeInputString(candidate.model) || args.model,
    declaredToolNames
  });

  return {
    id: normalizeInputString(candidate.id) || `chatcmpl-${randomUUID()}`,
    object: normalizeInputString(candidate.object) || 'chat.completion',
    created:
      typeof candidate.created === 'number' && Number.isFinite(candidate.created)
        ? candidate.created
        : Math.floor(Date.now() / 1000),
    model: normalizeInputString(candidate.model) || args.model,
    choices: [
      {
        index:
          typeof choiceNode.index === 'number' && Number.isFinite(choiceNode.index)
            ? choiceNode.index
            : 0,
        message: {
          role: 'assistant',
          content: imageUrls.length > 0 ? Array.from(new Set(imageUrls)).join('\n') : contentParts.join(''),
          ...(reasoningParts.length ? { reasoning_content: reasoningParts.join('') } : {}),
          ...(toolCallsRef.calls.length > 0
            ? {
                tool_calls: toolCallsRef.calls
                  .slice()
                  .sort((a, b) => a.index - b.index)
                  .map((call) => ({
                    id: call.id || `call_qwenchat_${call.index + 1}`,
                    type: 'function',
                    function: {
                      ...(call.name ? { name: call.name } : {}),
                      arguments: call.argumentsText || ''
                    }
                  }))
              }
            : functionCallRef.call && (functionCallRef.call.name || functionCallRef.call.argumentsText)
              ? {
                  function_call: {
                    ...(functionCallRef.call.id ? { id: functionCallRef.call.id } : {}),
                    ...(functionCallRef.call.name ? { name: functionCallRef.call.name } : {}),
                    arguments: functionCallRef.call.argumentsText || ''
                  }
                }
              : {})
        },
        finish_reason:
          toolCallsRef.calls.some((call) => call.name || call.argumentsText)
            ? 'tool_calls'
            : functionCallRef.call && (functionCallRef.call.name || functionCallRef.call.argumentsText)
              ? 'tool_calls'
              : normalizeInputString(choiceNode.finish_reason) || 'stop'
      }
    ],
    ...(usageRef.usage ? { usage: usageRef.usage } : {})
  };
}

export async function buildQwenChatSendPlan(input: QwenChatSendInput): Promise<{
  completionUrl: string;
  completionHeaders: Record<string, string>;
  completionBody: Record<string, unknown>;
}> {
  const normalizedPayload = input.payload;
  if (!Array.isArray(normalizedPayload.messages) || normalizedPayload.messages.length === 0) {
    const err = new Error('Messages are required');
    (err as Error & { statusCode?: number; code?: string }).statusCode = 400;
    (err as Error & { statusCode?: number; code?: string }).code = 'QWENCHAT_INVALID_REQUEST';
    throw err;
  }

  const imageGenOptions = parseQwenImageGenerationOptions(normalizedPayload.metadata);
  const chatType: 't2t' | 'search' | 't2i' = shouldUseImageGenerationMode(normalizedPayload)
    ? 't2i'
    : shouldUseSearchMode(normalizedPayload)
      ? 'search'
      : 't2t';
  const chatId = await createQwenChatSession({
    baseUrl: input.baseUrl,
    model: normalizedPayload.model,
    chatType,
    baxiaTokens: input.baxiaTokens,
    authHeaders: input.authHeaders,
    backoffKey: input.backoffKey
  });
  const parsedMessages = parseIncomingMessages(normalizedPayload.messages);
  const providerGuidedContent = applyQwenChatProviderToolOverride(parsedMessages.content, normalizedPayload.tools);
  const finalContent =
    chatType === 't2i' && imageGenOptions.count > 1
      ? `${providerGuidedContent}\n\n(Generate ${imageGenOptions.count} images.)`
      : providerGuidedContent;
  const uploaded = parsedMessages.attachments.length
    ? await uploadAttachments({
        baseUrl: input.baseUrl,
        attachments: parsedMessages.attachments,
        baxiaTokens: input.baxiaTokens,
        authHeaders: input.authHeaders
      })
    : { files: [] };

  const completionBody = buildQwenChatCompletionRequest({
    chatId,
    model: normalizedPayload.model,
    content: finalContent,
    uploadedFiles: uploaded.files,
    chatType,
    stream: normalizedPayload.stream,
    hasDeclaredTools: Array.isArray(normalizedPayload.tools) && normalizedPayload.tools.length > 0,
    toolSearchSuppressionMode: input.toolSearchSuppressionMode,
    ...(chatType === 't2i' ? { imageSize: imageGenOptions.sizeRatio } : {})
  });

  const completionHeaders = {
    ...qwenCommonHeaders(input.baxiaTokens, input.authHeaders, {
      baseUrl: input.baseUrl,
      refererMode: 'guest',
      acceptMode: 'json'
    }),
    version: '0.2.9'
  };

  return {
    completionUrl: `${joinUrl(input.baseUrl, DEFAULT_QWENCHAT_COMPLETION_ENDPOINT)}?chat_id=${encodeURIComponent(chatId)}`,
    completionHeaders,
    completionBody
  };
}

export function extractForwardAuthHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lowered = key.toLowerCase();
    if (lowered === 'authorization' || lowered === 'cookie') {
      out[key] = value;
    }
  }
  return out;
}

export function classifyQwenChatProviderIdentity(input: {
  providerFamily?: string;
  providerId?: string;
  providerKey?: string;
  compatibilityProfile?: string;
}): boolean {
  const candidates = [
    normalizeInputString(input.providerFamily).toLowerCase(),
    normalizeInputString(input.providerId).toLowerCase(),
    normalizeInputString(input.providerKey).toLowerCase(),
    normalizeInputString(input.compatibilityProfile).toLowerCase()
  ].filter(Boolean);
  return candidates.some(
    (value) =>
      value === 'qwenchat' ||
      value.startsWith('qwenchat.') ||
      value.includes('qwenchat') ||
      value === 'chat:qwenchat-web'
  );
}
