import type { ModuleDependencies } from '../../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { UnknownObject } from '../../../types/common-types.js';
import type { OpenAIStandardConfig } from '../api/provider-config.js';
import type { ProviderContext } from '../api/provider-types.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http2 from 'node:http2';
import * as childProcess from 'node:child_process';
import { createHash, randomUUID } from 'crypto';
import { gunzipSync } from 'node:zlib';
import { Transform } from 'node:stream';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  normalizeWindsurfProviderRuntimeOptions,
  type WindsurfProviderRuntimeOptions,
} from '../contracts/windsurf-provider-contract.js';
import { HttpTransportProvider } from './http-transport-provider.js';
import { extractProviderRuntimeMetadata } from './provider-runtime-metadata.js';
import { ApiKeyAuthProvider } from '../../auth/apikey-auth.js';
import { parseTomlRecord } from '../../../config/toml-basic.js';
import { resolveRccAuthDir, resolveRccPath } from '../../../config/user-data-paths.js';
import { writeProviderSnapshot } from '../utils/snapshot-writer.js';
import { WindsurfAccountStore } from './windsurf/windsurf-account-store.js';
import { WindsurfAccountPool, PoolAllExhaustedError } from './windsurf/windsurf-account-pool.js';
import { WindsurfAccountSessionManager } from './windsurf/windsurf-account-session-manager.js';
import {
  executeWindsurfCascadeBusyRetry,
  isWindsurfCascadeBusyError,
} from './windsurf/cascade-continuation-block.js';
import type { WindsurfCascadeBusyRetryConfig } from './windsurf/cascade-continuation-block.js';
import type {
  WindsurfSemanticTurn,
  WindsurfCascadeToolStepKind,
  WindsurfCascadeAdditionalStepsOptions,
  WindsurfBridgeToolHistoryPair,
} from './windsurf/windsurf-cascade-prompt.js';
import {
  extractLatestCascadeUserText,
  buildCascadeHistoryTurnText,
  buildCascadePromptText,
  buildWindsurfNativeToolAliasText,
  rewriteWindsurfNativeToolAliasesInText,
  extractWindsurfToolChoiceName,
  readDeltaSeedParts,
  isWindsurfNativeToolName,
  readBridgeToolHistoryPairs,
  appendBridgeToolHistoryToSemanticConversation,
  buildCompletedNativeToolCallIds,
  buildCompletedNativeToolSignatures,
  buildWindsurfNativeToolSignature,
  selectCurrentCascadeToolResultWindow,
  contentToString,
  escapeHistoryTag,
  compactSystemPromptForCascade,
  cascadeHistoryBudget,
  WINDSURF_CASCADE_TOOL_CONFIG_FIELDS,
  WINDSURF_TOOL_MAP,
  windsurfToolLookupName,
  collectWindsurfMappedTools,
  partitionWindsurfTools,
  setHiddenWindsurfBodyField,
  uniqueWindsurfToolKinds,
  flattenToolResultContent,
  stableStringify,
  buildFileUri,
  normalizeWindsurfToolDefinition,
  windsurfToolNameSet,
  findWindsurfToolDefinition,
  fileUriToPath,
  reverseWindsurfNativeToolArguments,
  createWindsurfProviderError,
  attachWindsurfErrorFields,
} from './windsurf/windsurf-cascade-prompt.js';


const MERGE_EFFORT_MAP: Record<string, string> = {
  minimal: 'none', none: 'none', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh'
};
const VALID_EFFORTS = new Set(['minimal', 'none', 'low', 'medium', 'high', 'xhigh']);

const WINDSURF_AUTH1_PASSWORD_LOGIN_URL = 'https://windsurf.com/_devin-auth/password/login';
const WINDSURF_CHECK_LOGIN_METHOD_URL = 'https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/CheckUserLoginMethod';
const WINDSURF_POST_AUTH_URL = 'https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth';
const WINDSURF_POST_AUTH_LEGACY_URL = 'https://server.self-serve.windsurf.com/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth';
const WINDSURF_CASCADE_MODEL_CONFIGS_URL = 'https://server.codeium.com/exa.api_server_pb.ApiServerService/GetCascadeModelConfigs';
const WINDSURF_GET_CHAT_COMPLETIONS_URL = 'https://server.self-serve.windsurf.com/exa.api_server_pb.ApiServerService/GetChatCompletions';
const WINDSURF_LS_SERVICE = '/exa.language_server_pb.LanguageServerService';
const WINDSURF_CASCADE_COMMUNICATION_NO_TOOLS = 'You are accessed via API. When asked about your identity, describe your actual underlying model name and provider accurately. Answer directly. STRICTLY respond in the exact same language the user used in their latest message (Chinese → Chinese, English → English, Japanese → Japanese; never switch mid-conversation).';
const WINDSURF_CASCADE_COMMUNICATION_WITH_TOOLS = 'You are accessed via API. When asked about your identity, describe your actual underlying model name and provider accurately. STRICTLY respond in the exact same language the user used in their latest message (Chinese → Chinese, English → English, Japanese → Japanese; never switch mid-conversation). Use the functions above when relevant.';
const WINDSURF_CASCADE_TIMEOUT_MS = 300_000;

type WindsurfSessionCredential = {
  apiKey: string;
  sessionToken: string;
  auth1Token: string;
  accountId?: string;
  primaryOrgId?: string;
  accountAlias?: string;
  accountEmail?: string;
};

type WindsurfLoginMethodProbe = {
  method: 'auth1' | null;
  hasPassword: boolean;
};

type WindsurfManagedAuthConfig = {
  apiKey?: string;
  rawType?: string;
  mobile?: string;
  account?: string;
  username?: string;
  password?: string;
  tokenFile?: string;
  accountAlias?: string;
  entries?: Array<{
    alias?: string;
    apiKey?: string;
    env?: string;
    tokenFile?: string;
    accountAlias?: string;
    account?: string;
    username?: string;
    mobile?: string;
    password?: string;
    extra?: boolean;
  }>;
};

function readPositiveIntEnv(names: string[], defaultValue: number): number {
  for (const name of names) {
    const raw = process.env[name];
    if (typeof raw !== 'string' || !raw.trim()) {
      continue;
    }
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return defaultValue;
}

function decodeProtoVarint(bytes: Uint8Array, start: number): { value: number; consumed: number } | null {
  let result = 0;
  let shift = 0;
  for (let index = start; index < bytes.length; index += 1) {
    const byte = bytes[index]!;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result, consumed: index - start + 1 };
    }
    shift += 7;
    if (shift > 35) {
      return null;
    }
  }
  return null;
}

function encodeProtoVarintValue(value: number): Buffer {
  const parts: number[] = [];
  if (!Number.isFinite(value)) {
    return Buffer.from([0]);
  }
  if (value < 0 || value > 0x7fffffff) {
    let remaining = BigInt(Math.floor(value)) & 0xffffffffffffffffn;
    while (true) {
      const byte = Number(remaining & 0x7fn);
      remaining >>= 7n;
      if (remaining === 0n) {
        parts.push(byte);
        break;
      }
      parts.push(byte | 0x80);
    }
    return Buffer.from(parts);
  }
  let remaining = Math.max(0, Math.floor(value));
  while (remaining >= 0x80) {
    parts.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  parts.push(remaining);
  return Buffer.from(parts);
}

function encodeProtoTag(fieldNo: number, wireType: number): Buffer {
  return encodeProtoVarintValue((fieldNo << 3) | wireType);
}

function writeProtoVarintField(fieldNo: number, value: number): Buffer {
  return Buffer.concat([encodeProtoTag(fieldNo, 0), encodeProtoVarintValue(value)]);
}

function writeProtoBoolField(fieldNo: number, value: boolean): Buffer {
  return writeProtoVarintField(fieldNo, value ? 1 : 0);
}

function writeProtoStringField(fieldNo: number, value: string): Buffer {
  const body = Buffer.from(value, 'utf8');
  return Buffer.concat([encodeProtoTag(fieldNo, 2), encodeProtoVarintValue(body.length), body]);
}

function writeProtoMessageField(fieldNo: number, body: Buffer): Buffer {
  const message = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
  return Buffer.concat([encodeProtoTag(fieldNo, 2), encodeProtoVarintValue(message.length), message]);
}

type ProtoField = {
  fieldNo: number;
  wireType: number;
  value: number | Uint8Array;
};

type WindsurfResponseMeta = {
  contentType?: string;
  contentEncoding?: string;
  prefixHex?: string;
  totalBytes?: number;
};

type WindsurfLiveLocalGrpcRuntime = {
  lsPort: number;
  csrfToken?: string;
  pid?: number;
  command?: string;
  codeiumDir?: string;
  runChild?: boolean;
};

type WindsurfCascadeSessionBinding = {
  runtime: WindsurfProviderRuntimeOptions;
  sessionId: string;
  cascadeId: string;
  stepOffset: number;
  active: boolean;
  lastUsedAtMs: number;
};

type WindsurfManagedLocalGrpcRuntime = {
  port: number;
  csrfToken: string;
  process: childProcess.ChildProcess;
  ready: boolean;
  sessionId: string | null;
  workspaceInit: Promise<void> | null;
};

const WINDSURF_MANAGED_LS_DEFAULT_PORT = 42101;
const WINDSURF_MANAGED_LS_CSRF = 'windsurf-api-csrf-fixed-token';
const WINDSURF_MANAGED_LS_POOL = new Map<string, WindsurfManagedLocalGrpcRuntime>();
const WINDSURF_MANAGED_LS_PENDING = new Map<string, Promise<WindsurfManagedLocalGrpcRuntime>>();

function parseProtoFields(bytes: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let index = 0;
  while (index < bytes.length) {
    const tag = decodeProtoVarint(bytes, index);
    if (!tag) {
      break;
    }
    index += tag.consumed;
    const fieldNo = tag.value >> 3;
    const wireType = tag.value & 0x7;
    if (wireType === 0) {
      const parsed = decodeProtoVarint(bytes, index);
      if (!parsed) {
        break;
      }
      index += parsed.consumed;
      fields.push({ fieldNo, wireType, value: parsed.value });
      continue;
    }
    if (wireType === 2) {
      const len = decodeProtoVarint(bytes, index);
      if (!len) {
        break;
      }
      index += len.consumed;
      const end = index + len.value;
      if (end > bytes.length) {
        break;
      }
      fields.push({ fieldNo, wireType, value: bytes.slice(index, end) });
      index = end;
      continue;
    }
    if (wireType === 1) {
      index += 8;
      continue;
    }
    if (wireType === 5) {
      index += 4;
      continue;
    }
    break;
  }
  return fields;
}

function getProtoField(fields: ProtoField[], fieldNo: number, wireType?: number): ProtoField | null {
  for (const field of fields) {
    if (field.fieldNo === fieldNo && (wireType === undefined || field.wireType === wireType)) {
      return field;
    }
  }
  return null;
}

function getAllProtoFields(fields: ProtoField[], fieldNo: number, wireType?: number): ProtoField[] {
  return fields.filter((field) => field.fieldNo === fieldNo && (wireType === undefined || field.wireType === wireType));
}

const WINDSURF_SOURCE_USER = 1;
const WINDSURF_SOURCE_ASSISTANT = 3;
const WINDSURF_SOURCE_TOOL = 4;


function readWindsurfToolFunction(tool: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!tool) return undefined;
  return tool.function && typeof tool.function === 'object' && !Array.isArray(tool.function)
    ? tool.function as Record<string, unknown>
    : tool;
}

function readWindsurfToolParameterSchema(tool: Record<string, unknown> | undefined, paramName: string): Record<string, unknown> | undefined {
  const fn = readWindsurfToolFunction(tool);
  const params = fn?.parameters && typeof fn.parameters === 'object' && !Array.isArray(fn.parameters)
    ? fn.parameters as Record<string, unknown>
    : undefined;
  const props = params?.properties && typeof params.properties === 'object' && !Array.isArray(params.properties)
    ? params.properties as Record<string, unknown>
    : undefined;
  const schema = props?.[paramName];
  return schema && typeof schema === 'object' && !Array.isArray(schema) ? schema as Record<string, unknown> : undefined;
}

function readWindsurfJsonSchemaTypes(schema: Record<string, unknown> | undefined): Set<string> {
  const out = new Set<string>();
  const raw = schema?.type;
  if (typeof raw === 'string' && raw.trim()) out.add(raw.trim().toLowerCase());
  if (Array.isArray(raw)) {
    for (const item of raw) if (typeof item === 'string' && item.trim()) out.add(item.trim().toLowerCase());
  }
  return out;
}


/**
 * Transforms Windsurf Connect binary frames into SSE text lines.
 *
 * Windsurf's HTTP/Connect response is NOT standard SSE — it's binary frames:
 *   [1-byte flags][4-byte BE length][payload JSON]
 * Each payload carries deltaText, deltaThinking, deltaToolCalls, usage.
 *
 * This transform decodes each frame and emits SSE `data:` lines shaped as
 * OpenAI chat.completion.chunk events. The Hub SSE dispatcher handles
 * keepalive, timing, and client transport.
 *
 * Terminal frame (flags & 0x02) emits usage chunk + [DONE].
 */
class WindsurfConnectSseTransform extends Transform {
  private buffer = Buffer.alloc(0);
  private seq = 0;
  private doneEmitted = false;

  constructor() {
    super();
  }

  override _transform(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    this.buffer = Buffer.concat([this.buffer, buf]);
    this.flushFrames();
    callback();
  }

  override _flush(callback: (error?: Error | null) => void): void {
    this.flushFrames();
    if (!this.doneEmitted) {
      this.doneEmitted = true;
      this.push('data: [DONE]\n\n');
    }
    callback();
  }

  private flushFrames(): void {
    while (this.buffer.length >= 5) {
      const flags = this.buffer[0]!;
      const len = this.buffer.readUInt32BE(1);
      const total = 5 + len;
      if (this.buffer.length < total) break;

      const payloadBytes = this.buffer.subarray(5, total);
      this.buffer = this.buffer.subarray(total);

      const payloadText = payloadBytes.toString('utf8').trim();
      if (!payloadText) continue;

      let payload: Record<string, unknown>;
      try {
        const parsed = JSON.parse(payloadText);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        payload = parsed as Record<string, unknown>;
      } catch {
        continue;
      }

      const isTerminal = (flags & 0x02) !== 0;
      this.seq++;
      const chunkId = `chatcmpl-${randomUUID().slice(0, 8)}-${this.seq}`;

      // Extract deltas
      const textDelta = typeof payload.deltaText === 'string'
        ? payload.deltaText
        : typeof payload.delta_text === 'string'
          ? String(payload.delta_text)
          : '';
      const thinkingDelta = typeof payload.deltaThinking === 'string'
        ? payload.deltaThinking
        : typeof payload.delta_thinking === 'string'
          ? String(payload.delta_thinking)
          : '';
      const deltaToolCalls = Array.isArray(payload.deltaToolCalls)
        ? (payload.deltaToolCalls as Array<Record<string, unknown>>)
        : Array.isArray(payload.delta_tool_calls)
          ? (payload.delta_tool_calls as Array<Record<string, unknown>>)
          : [];

      // Extract usage
      const rawUsage = (payload.usage || payload.modelUsage || payload.model_usage) as Record<string, unknown> | null;
      const inputTokens = typeof rawUsage?.inputTokens === 'number' ? (rawUsage as Record<string, number>).inputTokens
        : typeof rawUsage?.input_tokens === 'number' ? Number((rawUsage as Record<string, number>).input_tokens) : 0;
      const outputTokens = typeof rawUsage?.outputTokens === 'number' ? (rawUsage as Record<string, number>).outputTokens
        : typeof rawUsage?.output_tokens === 'number' ? Number((rawUsage as Record<string, number>).output_tokens) : 0;
      const cachedTokens = typeof rawUsage?.cacheReadTokens === 'number' ? (rawUsage as Record<string, number>).cacheReadTokens
        : typeof rawUsage?.cache_read_tokens === 'number' ? Number((rawUsage as Record<string, number>).cache_read_tokens) : 0;

      // Build delta
      const delta: Record<string, unknown> = {};
      if (textDelta) delta.content = textDelta;
      if (thinkingDelta) delta.reasoning_content = thinkingDelta;
      if (deltaToolCalls.length > 0) {
        delta.tool_calls = deltaToolCalls.map((row, i) => ({
          index: 0,
          id: typeof row.id === 'string' ? row.id : `call_${i}`,
          type: 'function',
          function: {
            name: typeof row.name === 'string' ? row.name : '',
            arguments: typeof row.argumentsJson === 'string' ? row.argumentsJson
              : typeof row.arguments_json === 'string' ? String(row.arguments_json)
              : '{}',
          },
        }));
      }

      // Emit content delta
      const sseChunk = {
        id: chunkId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: typeof payload.model === 'string' ? payload.model : '',
        choices: [{ index: 0, delta, finish_reason: null }],
      };
      this.push(`data: ${JSON.stringify(sseChunk)}\n\n`);

      // Terminal: emit usage + DONE
      if (isTerminal && !this.doneEmitted) {
        this.doneEmitted = true;
        if (inputTokens || outputTokens || cachedTokens) {
          this.push(`data: ${JSON.stringify({
            id: chunkId,
            object: 'chat.completion.chunk',
            created: sseChunk.created,
            model: sseChunk.model,
            choices: [],
            usage: {
              prompt_tokens: inputTokens,
              completion_tokens: outputTokens,
              total_tokens: inputTokens + outputTokens,
              prompt_tokens_details: { cached_tokens: cachedTokens },
            },
          })}\n\n`);
        }
        this.push('data: [DONE]\n\n');
      }
    }
  }
}


function parseWindsurfPostAuthProtoBuffer(bytes: Uint8Array): { sessionToken?: string; accountId?: string; auth1Token?: string; primaryOrgId?: string; error?: string } {
  let index = 0;
  let sessionToken = '';
  let accountId = '';
  let auth1Token = '';
  let primaryOrgId = '';
  while (index < bytes.length) {
    const tag = decodeProtoVarint(bytes, index);
    if (!tag) {
      return { error: 'WindsurfPostAuth proto tag decode failed' };
    }
    index += tag.consumed;
    const fieldNo = tag.value >> 3;
    const wireType = tag.value & 0x7;
    if (wireType === 2) {
      const len = decodeProtoVarint(bytes, index);
      if (!len) {
        return { error: 'WindsurfPostAuth proto length decode failed' };
      }
      index += len.consumed;
      const end = index + len.value;
      if (end > bytes.length) {
        return { error: 'WindsurfPostAuth proto length out of range' };
      }
      const payload = Buffer.from(bytes.slice(index, end)).toString('utf8');
      if (fieldNo === 1) {
        sessionToken = payload;
      } else if (fieldNo === 3) {
        auth1Token = payload;
      } else if (fieldNo === 4) {
        accountId = payload;
      } else if (fieldNo === 5) {
        primaryOrgId = payload;
      }
      index = end;
      continue;
    }
    if (wireType === 0) {
      const skipped = decodeProtoVarint(bytes, index);
      if (!skipped) {
        return { error: 'WindsurfPostAuth proto varint skip failed' };
      }
      index += skipped.consumed;
      continue;
    }
    if (wireType === 1) {
      index += 8;
      continue;
    }
    if (wireType === 5) {
      index += 4;
      continue;
    }
    return { error: `WindsurfPostAuth proto unsupported wire type ${wireType}` };
  }
  if (sessionToken || auth1Token || accountId || primaryOrgId) {
    return {
      sessionToken: sessionToken || undefined,
      accountId: accountId || undefined,
      auth1Token: auth1Token || undefined,
      primaryOrgId: primaryOrgId || undefined,
    };
  }
  return { error: 'empty response' };
}

function parseWindsurfPostAuthPayload(payload: unknown): { sessionToken?: string; accountId?: string; primaryOrgId?: string; error?: string } {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const sessionToken = typeof record.sessionToken === 'string' ? record.sessionToken.trim() : '';
    const accountId = typeof record.accountId === 'string' ? record.accountId.trim() : '';
    const primaryOrgId = typeof record.primaryOrgId === 'string'
      ? record.primaryOrgId.trim()
      : typeof record.primary_org_id === 'string'
        ? String(record.primary_org_id).trim()
        : '';
    if (sessionToken) {
      return {
        sessionToken,
        accountId: accountId || undefined,
        primaryOrgId: primaryOrgId || undefined,
      };
    }
  }
  if (typeof payload === 'string') {
    const raw = payload;
    const protoResult = parseWindsurfPostAuthProtoBuffer(Buffer.from(raw, 'latin1'));
    if (protoResult.sessionToken || protoResult.accountId || protoResult.primaryOrgId) {
      return {
        sessionToken: protoResult.sessionToken,
        accountId: protoResult.accountId,
        primaryOrgId: protoResult.primaryOrgId,
      };
    }
    const tokenMatch = raw.match(/devin-session-token\$[a-zA-Z0-9._-]+/);
    const accountMatch = raw.match(/account-[a-f0-9]+/);
    if (tokenMatch?.[0]) {
      return { sessionToken: tokenMatch[0], accountId: accountMatch?.[0] };
    }
    return { error: raw.slice(0, 200) || 'empty response' };
  }
  return { error: 'empty response' };
}

function createWindsurfFingerprintHeaders(): Record<string, string> {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    Accept: 'application/json, text/plain, */*',
    'Accept-Encoding': 'identity',
    'sec-ch-ua': '"Chromium";v="130", "Google Chrome";v="130", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    Origin: 'https://windsurf.com',
    Referer: 'https://windsurf.com/',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
  };
}

function createWindsurfAccountLoginHeaders(): Record<string, string> {
  return {
    ...createWindsurfFingerprintHeaders(),
    Referer: 'https://windsurf.com/account/login',
  };
}

function buildWindsurfCascadeModelConfigsMetadata(apiKey: string): Record<string, unknown> {
  const platform = os.platform() === 'darwin'
    ? 'macos'
    : os.platform() === 'win32'
      ? 'windows'
      : 'linux';
  const hardware = os.arch() === 'arm64' ? 'arm64' : 'x86_64';
  return {
    apiKey,
    ideName: 'windsurf',
    ideVersion: '2.3.9',
    extensionName: 'windsurf',
    extensionVersion: '2.3.9',
    locale: 'en',
    os: platform,
    hardware,
    requestId: Math.floor(Math.random() * 2 ** 48),
    sessionId: randomUUID(),
  };
}


function interpretWindsurfConnections(payload: unknown): WindsurfLoginMethodProbe {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const connections = Array.isArray(record.connections) ? record.connections : null;
    if (connections) {
      const emailConnection = connections.find((entry) => {
        if (!entry || typeof entry !== 'object') {
          return false;
        }
        return String((entry as Record<string, unknown>).type || '').trim().toLowerCase() === 'email';
      });
      return {
        method: emailConnection ? 'auth1' : null,
        hasPassword: !!(emailConnection && (emailConnection as Record<string, unknown>).enabled),
      };
    }
    const authMethod = record.auth_method;
    if (authMethod && typeof authMethod === 'object') {
      const authMethodRecord = authMethod as Record<string, unknown>;
      return {
        method: String(authMethodRecord.method || '').trim().toLowerCase() === 'auth1' ? 'auth1' : null,
        hasPassword: authMethodRecord.has_password !== false,
      };
    }
  }
  return { method: null, hasPassword: false };
}

const WINDSURF_MODEL_SET = new Set([
  'gpt-5.4','gpt-5.4-none','gpt-5.4-low','gpt-5.4-medium','gpt-5.4-high','gpt-5.4-xhigh',
  'gpt-5.4-mini-low','gpt-5.4-mini-medium','gpt-5.4-mini-high','gpt-5.4-mini-xhigh',
  'gpt-5.5','gpt-5.5-none','gpt-5.5-low','gpt-5.5-medium','gpt-5.5-high','gpt-5.5-xhigh',
  'gpt-5.5-none-fast','gpt-5.5-low-fast','gpt-5.5-medium-fast','gpt-5.5-high-fast','gpt-5.5-xhigh-fast',
  'gpt-5.3-codex','gpt-5.3-codex-low','gpt-5.3-codex-high','gpt-5.3-codex-xhigh',
  'gpt-5.3-codex-low-fast','gpt-5.3-codex-medium-fast','gpt-5.3-codex-high-fast','gpt-5.3-codex-xhigh-fast',
  'kimi-k2-6',
  'swe-1.6','swe-1.6-fast',
]);

const WINDSURF_CHAT_COMPLETIONS_MODEL_MAP: Record<string, { enumValue: number; modelTag: string }> = {
  'gpt-5.4': { enumValue: 0, modelTag: 'gpt-5-4-medium' },
  'gpt-5.4-none': { enumValue: 0, modelTag: 'gpt-5-4-none' },
  'gpt-5.4-low': { enumValue: 0, modelTag: 'gpt-5-4-low' },
  'gpt-5.4-medium': { enumValue: 0, modelTag: 'gpt-5-4-medium' },
  'gpt-5.4-high': { enumValue: 0, modelTag: 'gpt-5-4-high' },
  'gpt-5.4-xhigh': { enumValue: 0, modelTag: 'gpt-5-4-xhigh' },
  'gpt-5.4-mini-low': { enumValue: 0, modelTag: 'gpt-5-4-mini-low' },
  'gpt-5.4-mini-medium': { enumValue: 0, modelTag: 'gpt-5-4-mini-medium' },
  'gpt-5.4-mini-high': { enumValue: 0, modelTag: 'gpt-5-4-mini-high' },
  'gpt-5.4-mini-xhigh': { enumValue: 0, modelTag: 'gpt-5-4-mini-xhigh' },
  'gpt-5': { enumValue: 340, modelTag: 'MODEL_PRIVATE_6' },
  'gpt-5-medium': { enumValue: 0, modelTag: 'MODEL_PRIVATE_7' },
  'gpt-5-high': { enumValue: 0, modelTag: 'MODEL_PRIVATE_8' },
  'gpt-5.5': { enumValue: 0, modelTag: 'gpt-5-5-medium' },
  'gpt-5.5-none': { enumValue: 0, modelTag: 'gpt-5-5-none' },
  'gpt-5.5-low': { enumValue: 0, modelTag: 'gpt-5-5-low' },
  'gpt-5.5-medium': { enumValue: 0, modelTag: 'gpt-5-5-medium' },
  'gpt-5.5-high': { enumValue: 0, modelTag: 'gpt-5-5-high' },
  'gpt-5.5-xhigh': { enumValue: 0, modelTag: 'gpt-5-5-xhigh' },
  'gpt-5.5-none-fast': { enumValue: 0, modelTag: 'gpt-5-5-none-priority' },
  'gpt-5.5-low-fast': { enumValue: 0, modelTag: 'gpt-5-5-low-priority' },
  'gpt-5.5-medium-fast': { enumValue: 0, modelTag: 'gpt-5-5-medium-priority' },
  'gpt-5.5-high-fast': { enumValue: 0, modelTag: 'gpt-5-5-high-priority' },
  'gpt-5.5-xhigh-fast': { enumValue: 0, modelTag: 'gpt-5-5-xhigh-priority' },
  'gpt-5.3-codex': { enumValue: 0, modelTag: 'gpt-5-3-codex-medium' },
  'gpt-5.3-codex-low': { enumValue: 0, modelTag: 'gpt-5-3-codex-low' },
  'gpt-5.3-codex-high': { enumValue: 0, modelTag: 'gpt-5-3-codex-high' },
  'gpt-5.3-codex-xhigh': { enumValue: 0, modelTag: 'gpt-5-3-codex-xhigh' },
  'gpt-5.3-codex-low-fast': { enumValue: 0, modelTag: 'gpt-5-3-codex-low-priority' },
  'gpt-5.3-codex-medium-fast': { enumValue: 0, modelTag: 'gpt-5-3-codex-medium-priority' },
  'gpt-5.3-codex-high-fast': { enumValue: 0, modelTag: 'gpt-5-3-codex-high-priority' },
  'gpt-5.3-codex-xhigh-fast': { enumValue: 0, modelTag: 'gpt-5-3-codex-xhigh-priority' },
  'kimi-k2-6': { enumValue: 0, modelTag: 'kimi-k2-6' },
  'swe-1.6': { enumValue: 420, modelTag: 'swe-1-6' },
  'swe-1.6-fast': { enumValue: 421, modelTag: 'swe-1-6-fast' },
  'swe-1-6': { enumValue: 420, modelTag: 'swe-1-6' },
  'swe-1-6-fast': { enumValue: 421, modelTag: 'swe-1-6-fast' },
};

function resolveWindsurfChatCompletionsModel(model: string): { enumValue: number; modelTag: string } {
  const key = String(model || '').trim().toLowerCase();
  const resolved = WINDSURF_CHAT_COMPLETIONS_MODEL_MAP[key];
  if (!resolved) {
    throw createWindsurfProviderError(`unknown windsurf chat completions model: ${model}`, {
      code: 'WINDSURF_UNKNOWN_MODEL',
      status: 400,
      retryable: false,
    });
  }
  return resolved;
}

function classifyWindsurfUpstreamPayloadError(payloadError: Record<string, unknown>): Partial<WindsurfFailureClass> {
  const rawUpstreamCode = payloadError.code;
  const upstreamCode = typeof rawUpstreamCode === 'string'
    ? rawUpstreamCode.trim()
    : typeof rawUpstreamCode === 'number' && Number.isFinite(rawUpstreamCode)
      ? String(rawUpstreamCode)
      : undefined;
  const upstreamStatus = typeof rawUpstreamCode === 'number' && Number.isFinite(rawUpstreamCode)
    ? rawUpstreamCode
    : undefined;
  const errorCodeText = typeof payloadError.code === 'string'
    ? payloadError.code.trim().toLowerCase()
    : '';
  const errorMessage = String(payloadError.message || 'windsurf upstream error');
  const normalizedMessage = errorMessage.toLowerCase();
  const looksLikeInternalError =
    normalizedMessage.includes('an internal error occurred')
    || normalizedMessage.includes('internal error occurred');
  const looksLikePolicyBlocked =
    /cyber\s*verification|content[\s_-]+policy|policy[\s_-]+(?:violation|blocked|denied)|safety[\s_-]+(?:policy|blocked)|prompt[\s_-]+(?:rejected|blocked)\s+by[\s_-]+policy|usage[\s_-]+policy[\s_-]+violation/i.test(errorMessage);
  const looksLikeTransportTransient =
    normalizedMessage.includes('err_http2')
    || normalizedMessage.includes('pending stream has been canceled')
    || normalizedMessage.includes('stream cancel')
    || normalizedMessage.includes('stream closed')
    || normalizedMessage.includes('session closed')
    || normalizedMessage.includes('econnreset')
    || normalizedMessage.includes('econnrefused')
    || normalizedMessage.includes('connect');
  const isTrueRateLimit =
    errorCodeText === 'resource_exhausted'
    && !looksLikeInternalError;
  if (looksLikePolicyBlocked) {
    return {
      code: 'WINDSURF_POLICY_BLOCKED',
      status: 451,
      retryable: false,
      upstreamCode,
      upstreamStatus,
    };
  }
  if (looksLikeInternalError || looksLikeTransportTransient) {
    return {
      code: 'WINDSURF_UPSTREAM_TRANSIENT',
      status: 502,
      retryable: true,
      upstreamCode,
      upstreamStatus,
    };
  }
  return {
    code: isTrueRateLimit ? 'WINDSURF_RATE_LIMITED' : 'WINDSURF_SERVICE_UNREACHABLE',
    status: isTrueRateLimit ? 429 : 503,
    retryable: isTrueRateLimit ? false : true,
    upstreamCode,
    upstreamStatus,
    rateLimitKind: isTrueRateLimit ? 'daily_limit' : undefined,
    cooldownOverrideMs: isTrueRateLimit ? 24 * 60 * 60_000 : undefined,
    quotaScope: isTrueRateLimit ? 'model' : undefined,
    quotaReason: isTrueRateLimit ? 'windsurf_model_rate_limited' : undefined,
  };
}

type WindsurfFailureClass = {
  code: string;
  retryable: boolean;
  status: number;
  upstreamCode?: string;
  upstreamStatus?: number;
  rateLimitKind?: 'daily_limit' | 'short_lived' | 'synthetic_cooldown';
  cooldownOverrideMs?: number;
  quotaScope?: 'weekly' | 'model';
  quotaReason?: string;
};


function computeWindsurfQuotaCooldownUntilNextMidnightMs(nowMs = Date.now()): number {
  const now = Number.isFinite(nowMs) && nowMs > 0 ? nowMs : Date.now();
  const d = new Date(now);
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
  const ttl = next - now;
  return Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : 24 * 60 * 60_000;
}

function mergeReasoningEffortIntoModel(model: string, body: Record<string, unknown>): string {
  const effort = String((body.reasoning_effort as string) || (((body.reasoning as Record<string, unknown>)?.effort) as string) || '').toLowerCase().trim();
  if (!effort || !VALID_EFFORTS.has(effort)) return model;
  for (const e of VALID_EFFORTS) if (model.toLowerCase().endsWith('-' + e)) return model;
  const merged = `${model}-${MERGE_EFFORT_MAP[effort] || effort}`;
  return WINDSURF_MODEL_SET.has(merged.toLowerCase()) ? merged : model;
}


export class WindsurfChatProvider extends HttpTransportProvider {
  static readonly WindsurfConnectSseTransform = WindsurfConnectSseTransform;
  private static readonly http2SessionPool = new Map<string, http2.ClientHttp2Session>();
  private static readonly cascadeRuntimeScope = new AsyncLocalStorage<{
    pinnedRuntime: WindsurfProviderRuntimeOptions | null;
    sessionKey: string;
    accountAlias?: string;
    locked?: boolean;
  }>();
  private readonly windsurfRuntime: ReturnType<typeof normalizeWindsurfProviderRuntimeOptions>;
  private windsurfSessionCredential: WindsurfSessionCredential | null = null;
  private windsurfSessionCredentialPromise: Promise<WindsurfSessionCredential | null> | null = null;
  private windsurfForceRefreshLogin = false;
  private readonly windsurfCascadeTimeoutMs: number;
  private readonly windsurfUnavailableAccounts = new Set<string>();
  private readonly windsurfCascadeSessionBindings = new Map<string, WindsurfCascadeSessionBinding>();
  private windsurfCascadeWarmupPromise: Promise<void> | null = null;
  private windsurfCascadeSessionIdOverride: string | null = null;
  private windsurfCascadeSendQueue: Promise<void> = Promise.resolve();
  private readonly windsurfAccountStore: WindsurfAccountStore;
  private windsurfAccountPool: WindsurfAccountPool | null = null;
  private windsurfAccountSessionManager: WindsurfAccountSessionManager | null = null;

  constructor(config: OpenAIStandardConfig, dependencies: ModuleDependencies) {
    const cfg: OpenAIStandardConfig = {
      ...config,
      config: {
        ...config.config,
        providerType: 'openai',
        providerId: config.config.providerId || 'windsurf',
      },
    };
    super(cfg, dependencies, 'windsurf-chat-provider');

    const raw = config.config.extensions as UnknownObject | undefined;
    const nested = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).windsurf : undefined;
    this.windsurfRuntime = normalizeWindsurfProviderRuntimeOptions(
      nested && typeof nested === 'object' ? (nested as UnknownObject) : raw
    );
    this.windsurfCascadeTimeoutMs = readPositiveIntEnv(
      ['ROUTECODEX_WINDSURF_CASCADE_TIMEOUT_MS', 'RCC_WINDSURF_CASCADE_TIMEOUT_MS'],
      WINDSURF_CASCADE_TIMEOUT_MS
    );
    this.windsurfAccountStore = new WindsurfAccountStore();
  }

  protected override getServiceProfile() {
    const base = super.getServiceProfile();
    return { ...base, supportsTools: true, supportsVision: true, supportsThinking: true, streamingModes: ['sse'] };
  }

  public override async checkHealth(): Promise<boolean> {
    return true;
  }

  protected override async preprocessRequest(request: UnknownObject): Promise<UnknownObject> {
    const req = request && typeof request === 'object' && !Array.isArray(request)
      ? request as Record<string, unknown>
      : {};
    const body = (req.body as Record<string, unknown>) || req;

    if (!Array.isArray(body.messages) && typeof body.input === 'string' && body.input.trim()) {
      body.messages = [
        {
          role: 'user',
          content: [{ type: 'input_text', text: body.input }],
        },
      ];
    }

    if (!Array.isArray(body.messages) && Array.isArray(body.input)) {
      body.messages = this.convertResponsesInputToChatMessages(body.input);
    }

    if (Array.isArray(body.tools as unknown[])) {
      const tools = body.tools as Array<Record<string, unknown>>;
      if (tools.length > 0) {
        const partition = partitionWindsurfTools(tools);
        setHiddenWindsurfBodyField(body, 'windsurf_native_mode', partition.nativeTools.length > 0 || partition.customTools.length > 0);
        setHiddenWindsurfBodyField(body, 'windsurf_mcp_mode', partition.customTools.length > 0);
        setHiddenWindsurfBodyField(body, 'windsurf_native_allowlist', uniqueWindsurfToolKinds(partition.mappedNativeTools));
        setHiddenWindsurfBodyField(body, 'windsurf_declared_native_tools', partition.nativeTools);
        setHiddenWindsurfBodyField(body, 'windsurf_custom_tools', partition.customTools);
        delete body.windsurf_declared_tools;
        delete body.tools_preamble;
        delete body.windsurf_tools_preamble_tier;
        if (body.tool_choice !== undefined) {
          setHiddenWindsurfBodyField(body, 'windsurf_tool_choice', body.tool_choice);
          delete body.tool_choice;
        }
        delete body.tools;
      }
    }

    if (typeof body.model === 'string' && body.model.startsWith('windsurf.')) body.model = body.model.slice('windsurf.'.length);
    if (typeof body.model === 'string' && body.model.length > 0) body.model = mergeReasoningEffortIntoModel(body.model, body);

    return req;
  }

  private convertResponsesInputToChatMessages(input: unknown[]): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const rowType = typeof row.type === 'string' ? row.type.trim().toLowerCase() : '';
      const role = typeof row.role === 'string' ? row.role.trim().toLowerCase() : '';

      if (role === 'user' || role === 'assistant' || role === 'system') {
        out.push({
          role,
          content: row.content,
          ...(Array.isArray(row.tool_calls) ? { tool_calls: row.tool_calls } : {}),
        });
        continue;
      }

      if (rowType === 'message' && (role === 'user' || role === 'assistant' || role === 'system')) {
        out.push({
          role,
          content: row.content,
          ...(Array.isArray(row.tool_calls) ? { tool_calls: row.tool_calls } : {}),
        });
      }
    }
    return out;
  }

  protected override async sendRequestInternal(request: UnknownObject): Promise<unknown> {
    const existingScope = WindsurfChatProvider.cascadeRuntimeScope.getStore();
    if (!existingScope) {
      const initialSessionKey = this.resolveWindsurfSessionStateKeyFromRequest(request);
      return await WindsurfChatProvider.cascadeRuntimeScope.run(
        { pinnedRuntime: null, sessionKey: initialSessionKey },
        async () => this.sendRequestInternal(request),
      );
    }
    if (!existingScope.locked) {
      return await this.runWindsurfCascadeSendExclusive(async () => WindsurfChatProvider.cascadeRuntimeScope.run(
        { ...existingScope, locked: true },
        async () => this.sendRequestInternal(request),
      ));
    }
    const body = this.readRequestBodyRecord(request);
    const wantsSse = this.wantsUpstreamSse(request, {} as ProviderContext);
    const configModel = typeof (this.config.config as Record<string, unknown>).model === 'string'
      ? String((this.config.config as Record<string, unknown>).model)
      : '';
    const model = typeof body.model === 'string' && body.model.trim()
      ? body.model.trim()
      : configModel.trim()
        ? configModel.trim()
        : 'gpt-5.5-medium';
    this.logWindsurfStage('sendRequestInternal.begin', {
      requestModel: model,
      messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
      wantsSse,
    });
    let lastCascadeId = '';
    const stickySessionKey = (existingScope.sessionKey || 'provider-default-session').trim() || 'provider-default-session';
    this.markWindsurfSessionActive(stickySessionKey);
    const resolvedModel = resolveWindsurfChatCompletionsModel(model);
    const apiKey = await this.resolveCascadeApiKey(resolvedModel.modelTag);
    let retainedSelected: { sessionId: string; cascadeId: string; stepOffset: number } | null = null;
    const attempt = 1;
      try {
        const semanticConversation = this.parseCascadeSemanticRoundtripSync(body.messages);
        this.appendBridgeToolHistoryToSemanticConversation(semanticConversation, this.readBridgeToolHistoryPairs(body));
        void wantsSse;
        if (!this.getPinnedGrpcRuntime()) {
          this.setPinnedGrpcRuntime(await this.resolveManagedRuntimeOptions());
        }
        const mcpMode = body.windsurf_mcp_mode === true;
        const nativeMode = body.windsurf_native_mode === true || mcpMode;
        const nativeAllowlist = Array.isArray(body.windsurf_native_allowlist) ? body.windsurf_native_allowlist.filter((item): item is WindsurfCascadeToolStepKind => typeof item === 'string' && item in WINDSURF_CASCADE_TOOL_CONFIG_FIELDS) : [];
        const customTools = Array.isArray(body.windsurf_custom_tools) ? body.windsurf_custom_tools as Array<Record<string, unknown>> : [];
        const nativeDeclaredTools = Array.isArray(body.windsurf_declared_native_tools) ? body.windsurf_declared_native_tools as Array<Record<string, unknown>> : [];
        const deltaSeedParts = this.readDeltaSeedParts(body);
        const completedNativeToolCallIds = this.buildCompletedNativeToolCallIds(semanticConversation);
        const completedNativeToolSignatures = this.buildCompletedNativeToolSignatures(semanticConversation, nativeDeclaredTools);
        const isPanelMissing = (error: unknown): boolean => /panel state not found|not_found.*panel/i.test(String(error instanceof Error ? error.message : error || ''));
        const isExpiredCascade = (error: unknown): boolean => /not_found.*(cascade|trajectory)|(?:cascade|trajectory).*not[ _-]?found|expired.*cascade|unknown.*cascade/i.test(String(error instanceof Error ? error.message : error || ''));
        const isUntrustedWorkspace = (error: unknown): boolean => /untrusted workspace|workspace.*not.*trusted/i.test(String(error instanceof Error ? error.message : error || ''));

        const isWarmStart = retainedSelected !== null;
        let sessionId: string;
        let cascadeId: string;
        let selected: { sessionId: string; cascadeId: string; stepOffset: number };
        try {
          selected = retainedSelected || await this.selectUsablePinnedGrpcRuntime(apiKey);
          retainedSelected = selected;
          sessionId = selected.sessionId;
          cascadeId = selected.cascadeId;
        } catch (error) {
          if (!isPanelMissing(error)) {
            throw error;
          }
          this.resetWindsurfCascadeTransportState('panel-missing-start');
          retainedSelected = null;
          selected = await this.selectUsablePinnedGrpcRuntime(apiKey);
          retainedSelected = selected;
          sessionId = selected.sessionId;
          cascadeId = selected.cascadeId;
        }
        lastCascadeId = cascadeId;
        let text = this.buildCascadePromptText(
          body.messages,
          semanticConversation,
          resolvedModel.modelTag,
          customTools,
          deltaSeedParts,
          nativeDeclaredTools,
          body.windsurf_tool_choice,
          isWarmStart,
        );
        let additionalSteps = this.buildCascadeAdditionalStepsFromSemanticConversation(semanticConversation, nativeDeclaredTools, { currentOnly: !isWarmStart, mcpMode });
        if (process.env.RCC_DEBUG_WINDSURF_TOOLS === '1') {
          console.log('[windsurf-tools] outbound-shape', JSON.stringify({
            nativeMode,
            mcpMode,
            nativeTools: nativeDeclaredTools.map((tool) => {
              const fn = tool && typeof tool === 'object' && !Array.isArray(tool) ? tool.function as Record<string, unknown> | undefined : undefined;
              return typeof fn?.name === 'string' ? fn.name : '';
            }).filter(Boolean),
            nativeAllowlist,
            customTools: customTools.map((tool) => {
              const fn = tool && typeof tool === 'object' && !Array.isArray(tool) ? tool.function as Record<string, unknown> | undefined : undefined;
              return typeof fn?.name === 'string' ? fn.name : '';
            }).filter(Boolean),
            toolChoice: body.windsurf_tool_choice,
            textHasShellCommand: text.includes('shell_command'),
            textHasRunCommand: text.includes('run_command'),
          }));
        }

        try {
          await this.sendCascadeMessageWithBusyRetry({
            apiKey,
            cascadeId,
            text,
            sessionId,
            modelEnum: resolvedModel.enumValue,
            modelUid: resolvedModel.modelTag,
            nativeMode,
            nativeAllowlist,
            additionalSteps,
            mcpMode,
          });
        } catch (error) {
          const isCascadeBusy = isWindsurfCascadeBusyError(error);
          if (!isCascadeBusy && !isPanelMissing(error) && !isExpiredCascade(error) && !isUntrustedWorkspace(error)) {
            throw error;
          }
          this.resetWindsurfCascadeTransportState(isCascadeBusy ? 'busy-exhausted' : 'send-rewarm');
          retainedSelected = null;
          selected = await this.selectUsablePinnedGrpcRuntime(apiKey);
          retainedSelected = selected;
          sessionId = selected.sessionId;
          cascadeId = selected.cascadeId;
          lastCascadeId = cascadeId;
          text = this.buildCascadePromptText(
            body.messages,
            semanticConversation,
            resolvedModel.modelTag,
            customTools,
            deltaSeedParts,
            nativeDeclaredTools,
            body.windsurf_tool_choice,
            false,
          );
          additionalSteps = this.buildCascadeAdditionalStepsFromSemanticConversation(semanticConversation, nativeDeclaredTools, { currentOnly: false, mcpMode });
          await this.sendCascadeMessage({
            apiKey,
            cascadeId,
            text,
            sessionId,
            modelEnum: resolvedModel.enumValue,
            modelUid: resolvedModel.modelTag,
            nativeMode,
            nativeAllowlist,
            additionalSteps,
            mcpMode,
          });
        }
        const output = await this.pollCascadeTrajectorySteps({
          cascadeId,
          model,
          stepOffset: selected.stepOffset,
          promptChars: text.length,
          customTools,
          nativeTools: nativeDeclaredTools,
          completedNativeToolCallIds,
          completedNativeToolSignatures,
        });
        this.rememberWindsurfCascadeSessionBinding(stickySessionKey, {
          runtime: this.getPinnedGrpcRuntime() || await this.resolveManagedRuntimeOptions(),
          sessionId,
          cascadeId,
          stepOffset: output.stepOffset,
        });
        const out = this.buildCascadeCompletionFromOutput({
          model,
          candidate: output.candidate,
          usage: output.usage,
          nativeTools: nativeDeclaredTools,
        });
        if (this.windsurfAccountPool && this.windsurfSessionCredential?.accountAlias) {
          this.windsurfAccountPool.markSuccess(this.windsurfSessionCredential.accountAlias);
        }
        return out;
      } catch (error) {
        const classified = this.classifyWindsurfCascadeError(error) as Error & Record<string, unknown>;
        const isQuotaExhausted = classified.code === 'WINDSURF_WEEKLY_QUOTA_EXHAUSTED'
          || classified.code === 'WINDSURF_ACCOUNT_QUOTA_EXHAUSTED';

        if (isQuotaExhausted) {
          this.logWindsurfStage('sendRequestInternal.error', {
            cascadeId: lastCascadeId || null,
            attempt,
            retryableTransport: false,
            quotaExhausted: true,
            error: error instanceof Error ? error.message : String(error),
          });
          if (this.windsurfAccountPool && this.windsurfSessionCredential?.accountAlias) {
            this.windsurfAccountPool.markQuotaExhausted(
              this.windsurfSessionCredential.accountAlias,
              error instanceof Error ? error.message : String(error),
            );
          }
          throw classified;
        }

        this.logWindsurfStage('sendRequestInternal.error', {
          cascadeId: lastCascadeId || null,
          attempt,
          retryableTransport: false,
          error: error instanceof Error ? error.message : String(error),
        });
        throw classified;
      } finally {
        this.markWindsurfSessionStopped(stickySessionKey);
        this.clearPinnedGrpcRuntime();
      }
  }

  /**
   * SSE streaming path: fetches the Connect-protocol response as a byte stream,
   * pipes it through WindsurfConnectSseTransform, and returns { __sse_responses }
   * so the Hub SSE dispatcher handles client transport, keepalive, and timing.
   */
  private async streamWindsurfSseResponse(
    upstreamBody: Record<string, unknown>,
    apiKey: string,
    model: string,
  ): Promise<UnknownObject> {
    const { Readable } = await import('node:stream');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 600_000); // 10min for long streams
    try {
      const response = await fetch(WINDSURF_GET_CHAT_COMPLETIONS_URL, {
        method: 'POST',
        headers: {
          ...this.buildChatMessageHeaders(apiKey),
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(upstreamBody),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) {
        const text = await response.text();
        throw createWindsurfProviderError(
          `windsurf SSE fetch failed ${response.status}: ${text.slice(0, 200)}`,
          { status: response.status, retryable: response.status >= 500 }
        );
      }
      if (!response.body) {
        throw createWindsurfProviderError('windsurf SSE response body missing', {
          code: 'WINDSURF_RESPONSE_PARSE_FAILED', status: 502, retryable: false,
        });
      }
      const transform = new WindsurfConnectSseTransform();
      const readable = Readable.fromWeb(response.body as never).pipe(transform as Transform);
      return { __sse_responses: readable } as UnknownObject;
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof Error && error.name === 'AbortError') {
        throw createWindsurfProviderError('windsurf SSE timeout after 10min', {
          code: 'WINDSURF_FETCH_TIMEOUT', status: 504, retryable: true,
        });
      }
      this.logWindsurfStage('streamWindsurfSseResponse.error', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw this.classifyWindsurfCascadeError(error);
    }
  }

  protected override wantsUpstreamSse(request: UnknownObject, context: ProviderContext): boolean {
    if (request && typeof request === 'object') {
      const body = (request as Record<string, unknown>).body;
      if (body && typeof body === 'object' && (body as Record<string, unknown>).stream) return true;
      if ((request as Record<string, unknown>).stream) return true;
    }
    return super.wantsUpstreamSse(request, context);
  }

  private readApiKey(): string {
    const auth = this.authProvider;
    if (!(auth instanceof ApiKeyAuthProvider)) {
      throw new Error('windsurf auth provider unavailable');
    }
    const cfg = (auth as unknown as { config?: WindsurfManagedAuthConfig }).config;
    const rawType = normalizeWindsurfAuthRawType(cfg?.rawType);
    const key = typeof cfg?.apiKey === 'string' ? cfg.apiKey.trim() : '';
    if (isManagedWindsurfAuthRawType(rawType)) {
      if (keyLikeSessionToken(key)) {
        return key;
      }
      if (this.windsurfSessionCredential?.apiKey) {
        return this.windsurfSessionCredential.apiKey;
      }
      if (rawType === 'windsurf-devin-token') {
        throw createWindsurfProviderError('windsurf devin token missing', {
          code: 'WINDSURF_SESSION_TOKEN_NOT_INITIALIZED',
          status: 401,
          retryable: false,
        });
      }
      const mobile = typeof cfg?.mobile === 'string' ? cfg.mobile.trim() : '';
      const account = typeof cfg?.account === 'string' ? cfg.account.trim() : '';
      const username = typeof cfg?.username === 'string' ? cfg.username.trim() : '';
      const password = typeof cfg?.password === 'string' ? cfg.password.trim() : '';
      if (!(mobile || account || username) || !password) {
        throw createWindsurfProviderError('windsurf account credential missing', {
          code: 'WINDSURF_ACCOUNT_CREDENTIAL_MISSING',
          status: 401,
          retryable: false,
        });
      }
      throw createWindsurfProviderError('windsurf session token not initialized', {
        code: 'WINDSURF_SESSION_TOKEN_NOT_INITIALIZED',
        status: 401,
        retryable: false,
      });
    }
    if (!key) {
      throw createWindsurfProviderError('windsurf api key missing', {
        code: 'WINDSURF_API_KEY_MISSING',
        status: 401,
        retryable: false,
      });
    }
    if (auth.getApiKeyInfo().length < 10) {
      throw createWindsurfProviderError('windsurf api key invalid', {
        code: 'INVALID_API_KEY',
        status: 401,
        retryable: false,
      });
    }
    return key;
  }

  private readManagedWindsurfAuthConfig(): { auth: ApiKeyAuthProvider; cfg: WindsurfManagedAuthConfig; rawType: string } | null {
    const auth = this.authProvider;
    if (!(auth instanceof ApiKeyAuthProvider)) {
      return null;
    }
    const cfg = (auth as unknown as { config?: WindsurfManagedAuthConfig }).config ?? {};
    const rawType = normalizeWindsurfAuthRawType(cfg.rawType);
    if (!isManagedWindsurfAuthRawType(rawType)) {
      return null;
    }
    try {
      console.log(`[windsurf-account] managed-auth rawType=${rawType} entries=${Array.isArray(cfg.entries) ? cfg.entries.length : 0}`);
    } catch { /* best-effort */ }
    return { auth, cfg, rawType };
  }

  private resolveWindsurfTokenFilePath(cfg: WindsurfManagedAuthConfig): string {
    const raw = typeof cfg.tokenFile === 'string' ? cfg.tokenFile.trim() : '';
    if (raw) {
      if (raw.startsWith('~/')) {
        return path.join(process.env.HOME || '', raw.slice(2));
      }
      return path.resolve(raw);
    }
    const alias = typeof cfg.accountAlias === 'string' && cfg.accountAlias.trim() ? cfg.accountAlias.trim() : 'default';
    return path.join(resolveRccAuthDir(), `windsurf-${alias}.json`);
  }

  private async loadPersistedWindsurfSessionCredential(cfg: WindsurfManagedAuthConfig): Promise<WindsurfSessionCredential | null> {
    const tokenFilePath = this.resolveWindsurfTokenFilePath(cfg);
    try {
      const raw = await fs.readFile(tokenFilePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const apiKey = typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '';
      const sessionToken = typeof parsed.sessionToken === 'string' ? parsed.sessionToken.trim() : apiKey;
      const auth1Token = typeof parsed.auth1Token === 'string' ? parsed.auth1Token.trim() : '';
      const accountId = typeof parsed.accountId === 'string' ? parsed.accountId.trim() : '';
      const primaryOrgId = typeof parsed.primaryOrgId === 'string' ? parsed.primaryOrgId.trim() : '';
      if (!keyLikeSessionToken(apiKey || sessionToken)) {
        return null;
      }
      return {
        apiKey: apiKey || sessionToken,
        sessionToken: sessionToken || apiKey,
        auth1Token,
        ...(accountId ? { accountId } : {}),
        ...(primaryOrgId ? { primaryOrgId } : {}),
      };
    } catch {
      return null;
    }
  }

  private async persistWindsurfSessionCredential(cfg: WindsurfManagedAuthConfig, credential: WindsurfSessionCredential): Promise<void> {
    const tokenFilePath = this.resolveWindsurfTokenFilePath(cfg);
    await fs.mkdir(path.dirname(tokenFilePath), { recursive: true });
    await fs.writeFile(tokenFilePath, JSON.stringify(credential, null, 2), 'utf8');
  }

  private normalizeWindsurfAccountEmail(value: unknown): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  }

  private async loginWindsurfSessionCredential(cfg: WindsurfManagedAuthConfig): Promise<WindsurfSessionCredential> {
    const mobile = typeof cfg.mobile === 'string' ? cfg.mobile.trim() : '';
    const account = typeof cfg.account === 'string' ? cfg.account.trim() : '';
    const username = typeof cfg.username === 'string' ? cfg.username.trim() : '';
    const password = typeof cfg.password === 'string' ? cfg.password.trim() : '';
    const parsedInline = parseInlineWindsurfAccount(cfg.apiKey);
    const loginEmail = mobile || account || username || parsedInline?.email || '';
    const loginPassword = password || parsedInline?.passwordOrToken || '';
    if (!loginEmail || !loginPassword) {
      throw createWindsurfProviderError('windsurf account credential missing', {
        code: 'WINDSURF_ACCOUNT_CREDENTIAL_MISSING',
        status: 401,
        retryable: false,
      });
    }
    this.logWindsurfStage('sessionCredential.login.begin', { loginEmail });
    const fingerprint = createWindsurfAccountLoginHeaders();
    try {
      const loginMethodProbe = await this.resolveWindsurfLoginMethodProbe(loginEmail, fingerprint);
      this.logWindsurfStage('sessionCredential.loginMethod.done', {
        loginEmail,
        method: loginMethodProbe.method,
        hasPassword: loginMethodProbe.hasPassword,
      });
      if (loginMethodProbe.method === 'auth1' && !loginMethodProbe.hasPassword) {
        throw createWindsurfProviderError('No password set. Please log in with Google or GitHub.', {
          code: 'WINDSURF_NO_PASSWORD_SET',
          status: 401,
          retryable: false,
        });
      }
    } catch (error) {
      this.logWindsurfStage('sessionCredential.loginMethod.skip', {
        loginEmail,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const loginBody = { email: loginEmail, password: loginPassword };
    let loginResp;
    try {
      loginResp = await this.httpClient.post(
        WINDSURF_AUTH1_PASSWORD_LOGIN_URL,
        loginBody,
        {
          ...fingerprint,
          'Content-Type': 'application/json',
        }
      );
    } catch (error) {
      const source = error as { status?: unknown; response?: { data?: unknown }; message?: unknown };
      const status = typeof source?.status === 'number' ? source.status : typeof source?.response?.data === 'object' ? 401 : 502;
      const detail = this.extractWindsurfAuthDetail(source?.response?.data);
      if (status === 401 || detail) {
        throw createWindsurfProviderError(detail || 'Invalid email or password', {
          code: detail?.toLowerCase().includes('no password set') ? 'WINDSURF_NO_PASSWORD_SET' : 'WINDSURF_AUTH_FAILED',
          status: 401,
          retryable: false,
        });
      }
      throw error;
    }
    this.logWindsurfStage('sessionCredential.passwordLogin.done', { loginEmail });
    const loginRecord = (loginResp.data && typeof loginResp.data === 'object') ? loginResp.data as Record<string, unknown> : {};
    const auth1Token = typeof loginRecord.token === 'string' ? loginRecord.token.trim() : '';
    const loginDetail = this.extractWindsurfAuthDetail(loginRecord);
    if (!auth1Token) {
      throw createWindsurfProviderError(loginDetail || 'windsurf auth1 token missing', {
        code: loginDetail?.toLowerCase().includes('no password set') ? 'WINDSURF_NO_PASSWORD_SET' : 'WINDSURF_AUTH_FAILED',
        status: 401,
        retryable: false,
      });
    }
    const postAuthHeaders = {
      ...fingerprint,
      'Content-Type': 'application/proto',
      'Content-Length': '0',
      'Connect-Protocol-Version': '1',
      Origin: 'https://windsurf.com',
      Referer: 'https://windsurf.com/account/login',
      'X-Devin-Auth1-Token': auth1Token,
    };
    const postAuthRequest = {
      method: 'POST',
      headers: postAuthHeaders,
      body: Buffer.alloc(0) as unknown,
    } as RequestInit;
    const postAuthEndpoints = [WINDSURF_POST_AUTH_URL, WINDSURF_POST_AUTH_LEGACY_URL];
    let response: Response | null = null;
    let postAuthEndpoint = WINDSURF_POST_AUTH_URL;
    let lastPostAuthError: unknown = null;
    for (const endpoint of postAuthEndpoints) {
      this.logWindsurfStage('sessionCredential.postAuth.begin', { endpoint, loginEmail });
      try {
        response = await this.fetchWithTimeout(endpoint, postAuthRequest, this.windsurfCascadeTimeoutMs);
        postAuthEndpoint = endpoint;
        break;
      } catch (error) {
        lastPostAuthError = error;
        this.logWindsurfStage('sessionCredential.postAuth.error', {
          endpoint,
          loginEmail,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!response) {
      throw lastPostAuthError instanceof Error ? lastPostAuthError : new Error(String(lastPostAuthError ?? 'windsurf post auth failed'));
    }
    const raw = await response.text();
    const maybeJson = (() => { try { return JSON.parse(raw); } catch { return raw; } })();
    const parsed = this.parseWindsurfPostAuthPayload(maybeJson);
    if (!response.ok || !parsed.sessionToken) {
      throw createWindsurfProviderError(parsed.error || `windsurf post auth failed: ${response.status}`, {
        code: 'WINDSURF_POSTAUTH_FAILED',
        status: response.status || 502,
        retryable: response.status >= 500,
      });
    }
    this.logWindsurfStage('sessionCredential.postAuth.done', {
      endpoint: postAuthEndpoint,
      loginEmail,
      accountId: parsed.accountId || null,
    });
    return {
      apiKey: parsed.sessionToken,
      sessionToken: parsed.sessionToken,
      auth1Token,
      accountId: parsed.accountId,
      primaryOrgId: parsed.primaryOrgId,
      accountEmail: loginEmail,
    };
  }

  private clearManagedWindsurfSessionCredential(reason?: string): void {
    const alias = this.windsurfSessionCredential?.accountAlias || '';
    if (alias) {
      this.windsurfUnavailableAccounts.add(alias);
      if (this.windsurfAccountPool) {
        this.windsurfAccountPool.markAuthInvalid(alias, reason ?? 'session credential refresh failed');
      }
    }
    this.windsurfSessionCredential = null;
    this.windsurfSessionCredentialPromise = null;
    const managed = this.readManagedWindsurfAuthConfig();
    if (managed && (managed.auth as unknown as { config?: { apiKey?: string } }).config) {
      (managed.auth as unknown as { config?: { apiKey?: string } }).config!.apiKey = '';
    }
  }

  private hasManagedLoginCredentials(cfg: WindsurfManagedAuthConfig): boolean {
    const mobile = typeof cfg.mobile === 'string' ? cfg.mobile.trim() : '';
    const account = typeof cfg.account === 'string' ? cfg.account.trim() : '';
    const username = typeof cfg.username === 'string' ? cfg.username.trim() : '';
    const password = typeof cfg.password === 'string' ? cfg.password.trim() : '';
    const parsedInline = parseInlineWindsurfAccount(cfg.apiKey);
    const loginEmail = mobile || account || username || parsedInline?.email || '';
    const loginPassword = password || parsedInline?.passwordOrToken || '';
    return !!(loginEmail && loginPassword);
  }

  private isWindsurfAuthFailure(error: unknown): boolean {
    const source = error as {
      status?: unknown;
      response?: { status?: unknown; data?: unknown };
      message?: unknown;
    };
    const responseData = source?.response?.data && typeof source.response.data === 'object'
      ? source.response.data as Record<string, unknown>
      : null;
    const nestedError = responseData?.error && typeof responseData.error === 'object'
      ? responseData.error as Record<string, unknown>
      : null;
    const upstreamStatus =
      typeof source?.status === 'number'
        ? source.status
        : typeof source?.response?.status === 'number'
          ? source.response.status
          : typeof nestedError?.code === 'number'
            ? nestedError.code
            : null;
    const statusText = typeof nestedError?.status === 'string' ? nestedError.status.toLowerCase() : '';
    const message = typeof source?.message === 'string' ? source.message.toLowerCase() : '';
    return (
      upstreamStatus === 401
      || statusText === 'unauthenticated'
      || message.includes('unauthenticated')
      || message.includes('invalid authentication credentials')
    );
  }

  private logWindsurfStage(stage: string, details: Record<string, unknown> = {}): void {
    const enabled = String(process.env.ROUTECODEX_WINDSURF_DEBUG || process.env.RCC_WINDSURF_DEBUG || '').trim();
    if (!enabled || enabled === '0' || enabled.toLowerCase() === 'false') {
      return;
    }
    try {
      console.warn(`[windsurf.${stage}] ${JSON.stringify(details)}`);
    } catch {
      console.warn(`[windsurf.${stage}]`);
    }
  }

  private shouldLogWindsurfGrpc(pathName: string, grpcStatus = '0'): boolean {
    if (grpcStatus !== '0') return true;
    const enabled = String(process.env.ROUTECODEX_WINDSURF_DEBUG || process.env.RCC_WINDSURF_DEBUG || '').trim();
    if (!enabled || enabled === '0' || enabled.toLowerCase() === 'false') return false;
    if (pathName.endsWith('/GetCascadeTrajectory') || pathName.endsWith('/GetCascadeTrajectorySteps')) {
      return enabled.toLowerCase() === 'trace';
    }
    return true;
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw createWindsurfProviderError(`windsurf fetch timeout after ${timeoutMs}ms: ${url}`, {
          code: 'WINDSURF_FETCH_TIMEOUT',
          status: 504,
          retryable: true,
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensureWindsurfSessionCredential(): Promise<WindsurfSessionCredential | null> {
    const managed = this.readManagedWindsurfAuthConfig();
    if (!managed) {
      return null;
    }
    const { auth, cfg, rawType } = managed;
    if (this.windsurfSessionCredential?.apiKey) {
      return this.windsurfSessionCredential;
    }
    if (this.windsurfSessionCredentialPromise) {
      return await this.windsurfSessionCredentialPromise;
    }
    const run = async (): Promise<WindsurfSessionCredential | null> => {
      const skipPersistedCredential = this.windsurfForceRefreshLogin;
      this.windsurfForceRefreshLogin = false;
      const canFallbackToPasswordLogin = this.hasManagedLoginCredentials(cfg);
      const inlineApiKey = typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';
      if (inlineApiKey && !skipPersistedCredential) {
        const parsedInline = parseInlineWindsurfAccount(inlineApiKey);
        if (!parsedInline && keyLikeSessionToken(inlineApiKey)) {
          const inlineCredential: WindsurfSessionCredential = {
            apiKey: inlineApiKey,
            sessionToken: inlineApiKey,
            auth1Token: '',
          };
          if (rawType === 'windsurf-devin-token') {
            this.windsurfSessionCredential = inlineCredential;
            await this.persistWindsurfSessionCredential(cfg, this.windsurfSessionCredential);
            return this.windsurfSessionCredential;
          }
          if (!canFallbackToPasswordLogin) {
            this.windsurfSessionCredential = inlineCredential;
            await this.persistWindsurfSessionCredential(cfg, this.windsurfSessionCredential);
            return this.windsurfSessionCredential;
          }
          try {
            await this.fetchCascadeModelConfigsForSite(inlineCredential.apiKey);
            this.windsurfSessionCredential = inlineCredential;
            await this.persistWindsurfSessionCredential(cfg, this.windsurfSessionCredential);
            return this.windsurfSessionCredential;
          } catch (error) {
            if (!this.isWindsurfAuthFailure(error)) {
              throw error;
            }
            this.clearManagedWindsurfSessionCredential();
          }
        }
      }

      if (!skipPersistedCredential) {
        const persisted = await this.loadPersistedWindsurfSessionCredential(cfg);
        if (persisted) {
          if (!canFallbackToPasswordLogin) {
            this.windsurfSessionCredential = persisted;
            if ((auth as unknown as { config?: { apiKey?: string } }).config) {
              (auth as unknown as { config?: { apiKey?: string } }).config!.apiKey = persisted.apiKey;
            }
            return persisted;
          }
          try {
            await this.fetchCascadeModelConfigsForSite(persisted.apiKey);
            this.windsurfSessionCredential = persisted;
            if ((auth as unknown as { config?: { apiKey?: string } }).config) {
              (auth as unknown as { config?: { apiKey?: string } }).config!.apiKey = persisted.apiKey;
            }
            return persisted;
          } catch (error) {
            if (!this.isWindsurfAuthFailure(error)) {
              throw error;
            }
            this.clearManagedWindsurfSessionCredential();
          }
        }
      }

      if (rawType === 'windsurf-devin-token') {
        throw createWindsurfProviderError('windsurf devin token missing', {
          code: 'WINDSURF_SESSION_TOKEN_NOT_INITIALIZED',
          status: 401,
          retryable: false,
        });
      }

      this.windsurfSessionCredential = await this.loginWindsurfSessionCredential(cfg);
      (auth as unknown as { config?: { apiKey?: string } }).config!.apiKey = this.windsurfSessionCredential.apiKey;
      await this.persistWindsurfSessionCredential(cfg, this.windsurfSessionCredential);
      this.logWindsurfStage('sessionCredential.ready', {
        loginEmail: this.windsurfSessionCredential.accountEmail || null,
        accountId: this.windsurfSessionCredential.accountId || null,
      });
      return this.windsurfSessionCredential;
    };
    this.windsurfSessionCredentialPromise = run();
    try {
      return await this.windsurfSessionCredentialPromise;
    } finally {
      this.windsurfSessionCredentialPromise = null;
    }
  }


  private async resolveWindsurfLoginMethodProbe(
    email: string,
    fingerprint: Record<string, string>,
  ): Promise<WindsurfLoginMethodProbe> {
    const primary = await this.fetchWindsurfCheckLoginMethod(email, fingerprint);
    if (primary) {
      return primary;
    }
    throw createWindsurfProviderError('windsurf CheckUserLoginMethod failed', {
      code: 'WINDSURF_CHECK_LOGIN_METHOD_FAILED',
      status: 502,
      retryable: true,
    });
  }

  private async fetchWindsurfCheckLoginMethod(
    email: string,
    fingerprint: Record<string, string>,
  ): Promise<WindsurfLoginMethodProbe | null> {
    try {
      const body = JSON.stringify({ email });
      const response = await this.fetchWithTimeout(
        WINDSURF_CHECK_LOGIN_METHOD_URL,
        {
          method: 'POST',
          headers: {
            ...fingerprint,
            Accept: 'application/json, text/plain, */*',
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
          },
          body,
        },
        15000,
      );
      const raw = await response.text();
      if (!response.ok) {
        return null;
      }
      const parsed = this.parseCheckUserLoginMethodResponse(raw);
      if (!parsed) {
        return null;
      }
      if (parsed.userExists === false) {
        return { method: null, hasPassword: false };
      }
      return {
        method: 'auth1',
        hasPassword: !!parsed.hasPassword,
      };
    } catch {
      return null;
    }
  }

  private parseCheckUserLoginMethodResponse(raw: string | Uint8Array): { userExists: boolean; hasPassword: boolean } | null {
    const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
    if (!text.trim()) {
      return null;
    }
    let parsed: Record<string, unknown> | null = null;
    try {
      const value = JSON.parse(text);
      if (value && typeof value === 'object') {
        parsed = value as Record<string, unknown>;
      }
    } catch {
      return null;
    }
    if (!parsed) {
      return null;
    }
    const hasUserField = Object.prototype.hasOwnProperty.call(parsed, 'userExists');
    const hasPasswordField = Object.prototype.hasOwnProperty.call(parsed, 'hasPassword');
    if (!hasUserField && !hasPasswordField) {
      return null;
    }
    return {
      userExists: parsed.userExists === false ? false : true,
      hasPassword: !!parsed.hasPassword,
    };
  }

  private parseWindsurfPostAuthPayload(payload: unknown): { sessionToken?: string; accountId?: string; primaryOrgId?: string; error?: string } {
    return parseWindsurfPostAuthPayload(payload);
  }


  private extractWindsurfAuthDetail(payload: unknown): string {
    if (!payload || typeof payload !== 'object') {
      return '';
    }
    const detail = (payload as Record<string, unknown>).detail;
    if (typeof detail === 'string') {
      return detail.trim();
    }
    if (Array.isArray(detail)) {
      return detail
        .map((entry) => {
          if (typeof entry === 'string') {
            return entry;
          }
          if (entry && typeof entry === 'object') {
            const record = entry as Record<string, unknown>;
            return typeof record.msg === 'string'
              ? record.msg
              : typeof record.type === 'string'
                ? record.type
                : JSON.stringify(record);
          }
          return '';
        })
        .filter(Boolean)
        .join('; ')
        .trim();
    }
    return '';
  }


  private readRequestBodyRecord(request: UnknownObject): Record<string, unknown> {
    if (request && typeof request === 'object') {
      const record = request as Record<string, unknown>;
      if (record.body && typeof record.body === 'object') {
        return record.body as Record<string, unknown>;
      }
      return record;
    }
    return {};
  }

  private async resolveCascadeApiKey(requestedModelUid?: string): Promise<string> {
    await this.ensureWindsurfSessionCredential();
    const managed = this.readManagedWindsurfAuthConfig();
    if (managed) {
      const selected = await this.selectWindsurfAccount(managed, requestedModelUid);
      if (selected?.apiKey) {
        return selected.apiKey;
      }
    }
    try {
      console.log('[windsurf-account] aggregate path=direct-fallback managed=false');
    } catch { /* best-effort */ }
    const raw = this.readApiKey();
    if (keyLikeSessionToken(raw)) {
      return raw;
    }
    return this.readApiKey();
  }

  private resolveWindsurfSessionStateKeyFromRequest(request: UnknownObject): string {
    const body = this.readRequestBodyRecord(request);
    const runtimeMetadata = extractProviderRuntimeMetadata(request);
    const routeMetadata = runtimeMetadata?.metadata && typeof runtimeMetadata.metadata === 'object' && !Array.isArray(runtimeMetadata.metadata)
      ? runtimeMetadata.metadata as Record<string, unknown>
      : undefined;
    const responsesResume = routeMetadata?.responsesResume && typeof routeMetadata.responsesResume === 'object' && !Array.isArray(routeMetadata.responsesResume)
      ? routeMetadata.responsesResume as Record<string, unknown>
      : undefined;
    const restoredScope = typeof responsesResume?.restoredFromScopeKey === 'string' ? responsesResume.restoredFromScopeKey.trim() : '';
    const scopeSession = restoredScope.startsWith('session:') ? restoredScope.slice('session:'.length).trim() : '';
    const scopeConversation = restoredScope.startsWith('conversation:') ? restoredScope.slice('conversation:'.length).trim() : '';
    const candidates: Array<unknown> = [
      body.session_id,
      body.sessionId,
      body.conversation_id,
      body.conversationId,
      routeMetadata?.session_id,
      routeMetadata?.sessionId,
      routeMetadata?.conversation_id,
      routeMetadata?.conversationId,
      scopeSession,
      scopeConversation,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }
    return 'provider-default-session';
  }

  private async selectWindsurfAccount(
    managed: { auth: ApiKeyAuthProvider; cfg: WindsurfManagedAuthConfig; rawType: string },
    requestedModelUid?: string,
  ): Promise<{ accountAlias: string; apiKey: string }> {
    // Build pool entries from config
    let entries = Array.isArray(managed.cfg.entries) && managed.cfg.entries.length > 0
      ? managed.cfg.entries
      : [];
    if (entries.length === 0 && typeof managed.cfg.apiKey === 'string' && managed.cfg.apiKey.trim()) {
      entries = [{
        alias: managed.cfg.accountAlias || 'default',
        apiKey: managed.cfg.apiKey.trim(),
        account: managed.cfg.account,
        username: managed.cfg.username,
        mobile: managed.cfg.mobile,
        password: managed.cfg.password,
        tokenFile: managed.cfg.tokenFile,
      }];
    }

    // Lazy init pool
    if (!this.windsurfAccountPool) {
      await this.windsurfAccountStore.load();
      this.windsurfAccountPool = new WindsurfAccountPool(this.windsurfAccountStore);
      this.windsurfAccountSessionManager = new WindsurfAccountSessionManager(
        this.windsurfAccountPool,
        async (alias: string, entry: { alias?: string; apiKey?: string; env?: string; tokenFile?: string; account?: string; username?: string; mobile?: string; password?: string; extra?: boolean }) => {
          // Delegate to existing login chain for credential refresh
          const managed = this.readManagedWindsurfAuthConfig();
          if (!managed) throw new Error('managed auth config not available for refresh');
          const credential = await this.ensureWindsurfSessionCredential();
          if (!credential?.apiKey) throw new Error('session credential refresh returned no apiKey');
          return {
            apiKey: credential.apiKey,
            auth1Token: credential.auth1Token,
            accountId: credential.accountId,
            primaryOrgId: credential.primaryOrgId,
          };
        },
      );
    }

    const scope = WindsurfChatProvider.cascadeRuntimeScope.getStore();
    const sessionKey = (scope?.sessionKey || 'provider-default-session').trim() || 'provider-default-session';

    try {
      const selected = await this.windsurfAccountPool.selectAccount(entries, sessionKey, requestedModelUid);
      this.windsurfSessionCredential = {
        apiKey: selected.apiKey,
        sessionToken: selected.apiKey,
        auth1Token: this.windsurfSessionCredential?.auth1Token || '',
        accountId: this.windsurfSessionCredential?.accountId,
        primaryOrgId: this.windsurfSessionCredential?.primaryOrgId,
        accountAlias: selected.accountAlias,
      };
      if (scope) {
        scope.accountAlias = selected.accountAlias;
      }
      try {
        console.log(`[windsurf-account] pool selected alias=${selected.accountAlias} model=${requestedModelUid || '-'} sticky=${selected.sticky}`);
      } catch {
        // best-effort logging, never throw
      }
      return { accountAlias: selected.accountAlias, apiKey: selected.apiKey };
    } catch (error) {
      if (error instanceof PoolAllExhaustedError) {
        throw createWindsurfProviderError(error.message, {
          code: error.code as 'WINDSURF_ACCOUNT_POOL_COOLDOWN' | 'WINDSURF_NO_HEALTHY_ACCOUNT' | 'WINDSURF_NO_CONFIGURED_ACCOUNT',
          status: error.code === 'WINDSURF_NO_CONFIGURED_ACCOUNT' ? 401 : 429,
          retryable: error.retryable,
          rateLimitKind: error.rateLimitKind as 'synthetic_cooldown' | 'short_lived',
          cooldownOverrideMs: error.cooldownOverrideMs,
        });
      }
      throw error;
    }
  }

  /** Normalize a session key: trim whitespace, default to 'provider-default-session'. */
  private normalizeWindsurfSessionKey(sessionKey: string): string {
    return (sessionKey || '').trim() || 'provider-default-session';
  }

  /** Cleanup idle session bindings. Releases stale cascade session bindings. */
  private cleanupReleasedWindsurfSessions(nowMs = Date.now()): void {
    const releaseIdleMs = 5 * 60_000;
    for (const [sessionKey, binding] of this.windsurfCascadeSessionBindings.entries()) {
      if (!binding.active && nowMs - binding.lastUsedAtMs >= releaseIdleMs) {
        this.windsurfCascadeSessionBindings.delete(sessionKey);
      }
    }
  }

  /** Mark a session as active. Updates cascade session binding activity timestamp. */
  private markWindsurfSessionActive(sessionKey: string): void {
    const normalizedSessionKey = this.normalizeWindsurfSessionKey(sessionKey);
    const nowMs = Date.now();
    this.cleanupReleasedWindsurfSessions(nowMs);
    const cascadeBinding = this.windsurfCascadeSessionBindings.get(normalizedSessionKey);
    if (cascadeBinding) {
      this.windsurfCascadeSessionBindings.set(normalizedSessionKey, { ...cascadeBinding, active: true, lastUsedAtMs: nowMs });
    }
  }

  /** Mark a session as stopped. Sets cascade session binding to inactive. */
  private markWindsurfSessionStopped(sessionKey: string): void {
    const normalizedSessionKey = this.normalizeWindsurfSessionKey(sessionKey);
    const nowMs = Date.now();
    const cascadeBinding = this.windsurfCascadeSessionBindings.get(normalizedSessionKey);
    if (cascadeBinding) {
      this.windsurfCascadeSessionBindings.set(normalizedSessionKey, { ...cascadeBinding, active: false, lastUsedAtMs: nowMs });
    }
  }

  private buildCascadeAuthProbeBody(apiKey: string): Buffer {
    const token = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!token) {
      throw createWindsurfProviderError('windsurf api key missing', {
        code: 'WINDSURF_API_KEY_MISSING',
        status: 401,
        retryable: false,
      });
    }
    return Buffer.from(JSON.stringify({
      metadata: buildWindsurfCascadeModelConfigsMetadata(token),
    }), 'utf8');
  }

  private buildCascadeAuthProbeHeaders(apiKey: string): Record<string, string> {
    const token = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!token) {
      throw createWindsurfProviderError('windsurf api key missing', {
        code: 'WINDSURF_API_KEY_MISSING',
        status: 401,
        retryable: false,
      });
    }
    const headers: Record<string, string> = {
      'x-auth-token': token,
      'x-devin-session-token': token,
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      Accept: 'application/json',
      'User-Agent': 'windsurf/2.3.9',
    };
    if (this.windsurfSessionCredential?.accountId) {
      headers['x-devin-account-id'] = this.windsurfSessionCredential.accountId;
    }
    if (this.windsurfSessionCredential?.auth1Token) {
      headers['x-devin-auth1-token'] = this.windsurfSessionCredential.auth1Token;
    }
    if (this.windsurfSessionCredential?.primaryOrgId) {
      headers['x-devin-primary-org-id'] = this.windsurfSessionCredential.primaryOrgId;
    }
    return headers;
  }

  private buildAccountLoginHeaders(): Record<string, string> {
    return createWindsurfAccountLoginHeaders();
  }

  private async fetchCascadeModelConfigsForSite(apiKey: string): Promise<{ status: number; raw: string }> {
    const body = this.buildCascadeAuthProbeBody(apiKey);
    const headers = this.buildCascadeAuthProbeHeaders(apiKey);
    const response = await this.fetchWithTimeout(
      WINDSURF_CASCADE_MODEL_CONFIGS_URL,
      {
        method: 'POST',
        headers,
        body: body as unknown as BodyInit,
      },
      15000,
    );
    const raw = await response.text();
    if (!response.ok) {
      throw createWindsurfProviderError(`HTTP ${response.status}: ${raw}`, {
        code: response.status === 401 ? 'WINDSURF_AUTH_FAILED' : 'WINDSURF_SERVICE_UNREACHABLE',
        status: response.status || (response.status === 401 ? 401 : 503),
        retryable: response.status !== 401,
      });
    }
    return {
      status: response.status,
      raw,
    };
  }

  private buildChatMessageHeaders(apiKey: string): Record<string, string> {
    const token = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!token) {
      throw createWindsurfProviderError('windsurf api key missing', {
        code: 'WINDSURF_API_KEY_MISSING',
        status: 401,
        retryable: false,
      });
    }
    const headers: Record<string, string> = {
      'x-auth-token': token,
      'x-devin-session-token': token,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      'User-Agent': 'windsurf/2.3.9',
      Referer: 'https://windsurf.com/',
    };
    if (this.windsurfSessionCredential?.accountId) {
      headers['x-devin-account-id'] = this.windsurfSessionCredential.accountId;
    }
    if (this.windsurfSessionCredential?.auth1Token) {
      headers['x-devin-auth1-token'] = this.windsurfSessionCredential.auth1Token;
    }
    if (this.windsurfSessionCredential?.primaryOrgId) {
      headers['x-devin-primary-org-id'] = this.windsurfSessionCredential.primaryOrgId;
    }
    return headers;
  }


  private parseProtoFields(bytes: Uint8Array): ProtoField[] {
    return parseProtoFields(bytes);
  }

  private getProtoField(fields: ProtoField[], fieldNo: number, wireType?: number): ProtoField | null {
    return getProtoField(fields, fieldNo, wireType);
  }

  private getAllProtoFields(fields: ProtoField[], fieldNo: number, wireType?: number): ProtoField[] {
    return getAllProtoFields(fields, fieldNo, wireType);
  }

  private readProtoString(fields: ProtoField[], fieldNo: number): string {
    const field = this.getProtoField(fields, fieldNo, 2);
    return field && field.value instanceof Uint8Array ? Buffer.from(field.value).toString('utf8') : '';
  }

  private readProtoNumber(fields: ProtoField[], fieldNo: number): number | undefined {
    const field = this.getProtoField(fields, fieldNo, 0);
    return field && typeof field.value === 'number' ? Number(field.value) : undefined;
  }

  private parseWindsurfModelUsageStats(bytes: Uint8Array): { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } | null {
    const fields = this.parseProtoFields(bytes);
    if (!fields.length) {
      return null;
    }
    return {
      inputTokens: this.readProtoNumber(fields, 2),
      outputTokens: this.readProtoNumber(fields, 3),
      cacheWriteTokens: this.readProtoNumber(fields, 4),
      cacheReadTokens: this.readProtoNumber(fields, 5),
    };
  }

  private tryParseWindsurfCompletionDeltaProto(bytes: Uint8Array): Record<string, unknown> | null {
    const fields = this.parseProtoFields(bytes);
    if (!fields.length) {
      return null;
    }
    const deltaText = this.readProtoString(fields, 1);
    const deltaThinking = this.readProtoString(fields, 6);
    const deltaSignature = this.readProtoString(fields, 7);
    const outputId = this.readProtoString(fields, 9);
    const thinkingId = this.readProtoString(fields, 10);
    const deltaSignatureType = this.readProtoString(fields, 12);
    const phase = this.readProtoString(fields, 13);
    const toolCallFields = this.getAllProtoFields(fields, 5, 2);
    const usageField = this.getProtoField(fields, 4, 2);
    const deltaToolCalls = toolCallFields.map((field, index) => {
      const inner = this.parseProtoFields(field.value as Uint8Array);
      return {
        id: this.readProtoString(inner, 1) || `call_${index}`,
        name: this.readProtoString(inner, 2),
        argumentsJson: this.readProtoString(inner, 3) || '{}',
      };
    });
    const usage = usageField && usageField.value instanceof Uint8Array
      ? this.parseWindsurfModelUsageStats(usageField.value)
      : null;
    const stopReason = this.readProtoNumber(fields, 3);
    const hasSignal = !!(
      deltaText
      || deltaThinking
      || deltaToolCalls.length > 0
      || usage
      || deltaSignature
      || outputId
      || thinkingId
      || deltaSignatureType
      || phase
      || stopReason !== undefined
    );
    if (!hasSignal) {
      return null;
    }
    return {
      ...(deltaText ? { delta_text: deltaText } : {}),
      ...(deltaThinking ? { delta_thinking: deltaThinking } : {}),
      ...(deltaToolCalls.length > 0 ? { delta_tool_calls: deltaToolCalls } : {}),
      ...(usage ? { usage } : {}),
      ...(deltaSignature ? { delta_signature: deltaSignature } : {}),
      ...(outputId ? { output_id: outputId } : {}),
      ...(thinkingId ? { thinking_id: thinkingId } : {}),
      ...(deltaSignatureType ? { delta_signature_type: deltaSignatureType } : {}),
      ...(phase ? { phase } : {}),
      ...(stopReason !== undefined ? { stop_reason: stopReason } : {}),
    };
  }


  private isWindsurfNativeToolName(name: string, nativeTools?: unknown): boolean {
    return isWindsurfNativeToolName(name, nativeTools);
  }

  private readBridgeToolHistoryPairs(body: Record<string, unknown>): WindsurfBridgeToolHistoryPair[] {
    return readBridgeToolHistoryPairs(body);
  }

  private appendBridgeToolHistoryToSemanticConversation(semanticConversation: WindsurfSemanticTurn[], pairs: WindsurfBridgeToolHistoryPair[]): void {
    appendBridgeToolHistoryToSemanticConversation(semanticConversation, pairs);
  }

  private buildCompletedNativeToolCallIds(semanticConversation: WindsurfSemanticTurn[]): string[] {
    return buildCompletedNativeToolCallIds(semanticConversation);
  }

  private buildCompletedNativeToolSignatures(semanticConversation: WindsurfSemanticTurn[], nativeTools?: Array<Record<string, unknown>>): string[] {
    return buildCompletedNativeToolSignatures(semanticConversation, nativeTools);
  }

  private buildWindsurfNativeToolSignature(name: string, payload: Record<string, unknown>): string {
    return buildWindsurfNativeToolSignature(name, payload);
  }

  private selectCurrentCascadeToolResultWindow(semanticConversation: WindsurfSemanticTurn[]): WindsurfSemanticTurn[] {
    return selectCurrentCascadeToolResultWindow(semanticConversation);
  }

  private buildCascadeMcpToolStep(toolCall: { call_id: string; name: string; arguments: Record<string, unknown> }, result: string): Buffer | null {
    const parsed = /^mcp__(.+?)__(.+)$/.exec(String(toolCall.name || '').trim());
    if (!parsed) return null;
    const serverName = parsed[1]?.trim();
    const toolName = parsed[2]?.trim();
    if (!serverName || !toolName || !toolCall.call_id) return null;
    const argumentsJson = JSON.stringify(toolCall.arguments || {});
    const chatToolCall = Buffer.concat([
      writeProtoStringField(1, toolCall.call_id),
      writeProtoStringField(2, toolName),
      writeProtoStringField(3, argumentsJson),
    ]);
    const mcpTool = Buffer.concat([
      writeProtoStringField(1, serverName),
      writeProtoMessageField(2, chatToolCall),
      writeProtoStringField(3, result),
    ]);
    return Buffer.concat([
      writeProtoVarintField(1, 15),
      writeProtoVarintField(4, 3),
      writeProtoMessageField(47, mcpTool),
    ]);
  }

  private buildCascadeAdditionalStepsFromSemanticConversation(
    semanticConversation: WindsurfSemanticTurn[],
    nativeTools?: Array<Record<string, unknown>>,
    options: WindsurfCascadeAdditionalStepsOptions = {},
  ): Buffer[] {
    const out: Buffer[] = [];
    const toolResultById = new Map<string, string>();
    const sourceConversation = options.currentOnly
      ? this.selectCurrentCascadeToolResultWindow(semanticConversation)
      : semanticConversation;
    for (const turn of sourceConversation) {
      if (turn.type === 'function_call_output') {
        toolResultById.set(turn.call_id, turn.output);
      }
    }
    for (const turn of sourceConversation) {
      if (turn.type !== 'assistant' || !Array.isArray(turn.tool_calls)) continue;
      for (const toolCall of turn.tool_calls) {
        const observation = toolResultById.get(toolCall.call_id);
        if (typeof observation !== 'string') continue;
        if (!this.isWindsurfNativeToolName(toolCall.name, nativeTools)) continue;
        const mapped = WINDSURF_TOOL_MAP[String(toolCall.name || '').toLowerCase()];
        if (!mapped) continue;
        const payload = mapped.forward(toolCall.arguments || {});
        if (mapped.applyObservation) {
          mapped.applyObservation(payload, observation);
        }
        const encoded = this.buildCascadeAdditionalStep(mapped.kind, payload);
        if (encoded.length > 0) out.push(encoded);
      }
    }
    if (options.mcpMode) {
      for (const turn of sourceConversation) {
        if (turn.type !== 'assistant' || !Array.isArray(turn.tool_calls)) continue;
        for (const toolCall of turn.tool_calls) {
          if (this.isWindsurfNativeToolName(toolCall.name, nativeTools)) continue;
          const observation = toolResultById.get(toolCall.call_id);
          if (typeof observation !== 'string') continue;
          const encoded = this.buildCascadeMcpToolStep(toolCall, observation);
          if (encoded && encoded.length > 0) out.push(encoded);
        }
      }
    }
    return out;
  }

  private buildCascadeAdditionalStep(kind: WindsurfCascadeToolStepKind, payload: Record<string, unknown>): Buffer {
    const meta: Record<WindsurfCascadeToolStepKind, { typeEnum: number; oneofField: number }> = {
      view_file: { typeEnum: 14, oneofField: 14 },
      list_directory: { typeEnum: 15, oneofField: 15 },
      write_to_file: { typeEnum: 23, oneofField: 23 },
      run_command: { typeEnum: 28, oneofField: 28 },
      find: { typeEnum: 34, oneofField: 34 },
      grep_search: { typeEnum: 13, oneofField: 13 },
      read_url_content: { typeEnum: 40, oneofField: 40 },
      search_web: { typeEnum: 42, oneofField: 42 },
      grep_search_v2: { typeEnum: 105, oneofField: 105 },
    };
    const selected = meta[kind];
    if (!selected) return Buffer.alloc(0);
    const body = this.buildCascadeStepBody(kind, payload);
    return Buffer.concat([
      writeProtoVarintField(1, selected.typeEnum),
      writeProtoVarintField(4, 3),
      writeProtoMessageField(selected.oneofField, body),
    ]);
  }

  private buildCascadeStepBody(kind: WindsurfCascadeToolStepKind, payload: Record<string, unknown>): Buffer {
    const str = (key: string) => typeof payload[key] === 'string' ? String(payload[key]) : '';
    const num = (key: string) => Number.isFinite(Number(payload[key])) ? Number(payload[key]) : 0;
    switch (kind) {
      case 'view_file':
        return Buffer.concat([
          ...(str('absolute_path_uri') ? [writeProtoStringField(1, str('absolute_path_uri'))] : []),
          ...(num('offset') ? [writeProtoVarintField(11, num('offset'))] : []),
          ...(num('limit') ? [writeProtoVarintField(12, num('limit'))] : []),
          ...(typeof payload.content === 'string' ? [writeProtoStringField(4, String(payload.content))] : []),
        ]);
      case 'run_command':
        return Buffer.concat([
          ...(str('command_line') ? [writeProtoStringField(23, str('command_line'))] : []),
          ...(str('cwd') ? [writeProtoStringField(2, str('cwd'))] : []),
          ...(payload.blocking ? [writeProtoBoolField(11, true)] : []),
          ...(typeof payload.stdout === 'string' ? [writeProtoStringField(4, String(payload.stdout))] : []),
          ...(typeof payload.stderr === 'string' ? [writeProtoStringField(5, String(payload.stderr))] : []),
          ...(Number.isFinite(Number(payload.exit_code)) ? [writeProtoVarintField(6, Number(payload.exit_code))] : []),
          ...(typeof payload.full_output === 'string' ? [writeProtoMessageField(21, writeProtoStringField(1, String(payload.full_output)))] : []),
        ]);
      case 'grep_search_v2':
        return Buffer.concat([
          ...(str('pattern') ? [writeProtoStringField(2, str('pattern'))] : []),
          ...(str('path') ? [writeProtoStringField(3, str('path'))] : []),
          ...(str('glob') ? [writeProtoStringField(4, str('glob'))] : []),
          ...(str('output_mode') ? [writeProtoStringField(5, str('output_mode'))] : []),
          ...(payload.case_insensitive ? [writeProtoBoolField(10, true)] : []),
          ...(payload.multiline ? [writeProtoBoolField(13, true)] : []),
          ...(str('type') ? [writeProtoStringField(11, str('type'))] : []),
          ...(num('head_limit') ? [writeProtoVarintField(12, num('head_limit'))] : []),
          ...(num('lines_after') ? [writeProtoVarintField(6, num('lines_after'))] : []),
          ...(num('lines_before') ? [writeProtoVarintField(7, num('lines_before'))] : []),
          ...(num('lines_both') ? [writeProtoVarintField(8, num('lines_both'))] : []),
          ...(typeof payload.raw_output === 'string' ? [writeProtoStringField(15, String(payload.raw_output))] : []),
        ]);
      case 'find':
        return Buffer.concat([
          ...(str('search_directory') ? [writeProtoStringField(10, str('search_directory'))] : []),
          ...(str('pattern') ? [writeProtoStringField(1, str('pattern'))] : []),
          ...(typeof payload.raw_output === 'string' ? [writeProtoStringField(11, String(payload.raw_output))] : []),
        ]);
      case 'list_directory':
        return Buffer.concat([
          ...(str('directory_path_uri') ? [writeProtoStringField(1, str('directory_path_uri'))] : []),
          ...(Array.isArray(payload.children) ? payload.children.map((child) => writeProtoStringField(2, String(child))) : []),
        ]);
      case 'write_to_file':
        return Buffer.concat([
          ...(str('target_file_uri') ? [writeProtoStringField(1, str('target_file_uri'))] : []),
          ...(Array.isArray(payload.code_content) ? payload.code_content.map((line) => writeProtoStringField(2, String(line))) : []),
          ...(payload.file_created ? [writeProtoBoolField(4, true)] : []),
        ]);
      case 'search_web':
        return Buffer.concat([
          ...(str('query') ? [writeProtoStringField(1, str('query'))] : []),
          ...(typeof payload.summary === 'string' ? [writeProtoStringField(5, String(payload.summary))] : []),
        ]);
      case 'read_url_content':
        return Buffer.concat([
          ...(str('url') ? [writeProtoStringField(1, str('url'))] : []),
          ...(typeof payload.summary === 'string' ? [writeProtoStringField(4, String(payload.summary))] : []),
        ]);
      default:
        return Buffer.alloc(0);
    }
  }

  private buildWindsurfMetadataProto(apiKey: string, sessionId?: string): Buffer {
    const platform = os.platform() === 'darwin'
      ? 'macos'
      : os.platform() === 'win32'
        ? 'windows'
        : 'linux';
    const hardware = os.arch() === 'arm64' ? 'arm64' : 'x86_64';
    const version = '2.0.67';
    return Buffer.concat([
      writeProtoStringField(1, 'windsurf'),
      writeProtoStringField(2, version),
      writeProtoStringField(3, apiKey),
      writeProtoStringField(4, 'en'),
      writeProtoStringField(5, platform),
      writeProtoStringField(7, version),
      writeProtoStringField(8, hardware),
      writeProtoVarintField(9, Math.floor(Math.random() * 2 ** 48)),
      ...(sessionId ? [writeProtoStringField(10, sessionId)] : []),
      writeProtoStringField(12, 'windsurf'),
    ]);
  }

  private buildStartCascadeRequest(apiKey: string, sessionId: string): Buffer {
    return Buffer.concat([
      writeProtoMessageField(1, this.buildWindsurfMetadataProto(apiKey, sessionId)),
      writeProtoVarintField(4, 1),
    ]);
  }

  private buildNativeCascadeToolConfig(allowlist: WindsurfCascadeToolStepKind[]): Buffer {
    const list = allowlist.length > 0 ? allowlist : ['view_file', 'run_command', 'grep_search_v2', 'find', 'list_directory'];
    const parts: Buffer[] = [];
    const includesKind = (kind: string) => list.includes(kind as WindsurfCascadeToolStepKind);
    if (includesKind('run_command')) parts.push(writeProtoMessageField(8, Buffer.alloc(0)));
    if (includesKind('view_file')) parts.push(writeProtoMessageField(10, Buffer.alloc(0)));
    if (includesKind('list_directory')) parts.push(writeProtoMessageField(19, Buffer.alloc(0)));
    if (includesKind('grep_search_v2')) parts.push(writeProtoMessageField(33, Buffer.alloc(0)));
    if (includesKind('find')) parts.push(writeProtoMessageField(5, Buffer.alloc(0)));
    for (const name of list) parts.push(writeProtoStringField(32, name));
    return Buffer.concat(parts);
  }

  private buildSendCascadeMessageRequest(args: {
    apiKey: string;
    cascadeId: string;
    text: string;
    sessionId: string;
    modelEnum: number;
    modelUid: string;
    nativeMode?: boolean;
    nativeAllowlist?: WindsurfCascadeToolStepKind[];
    additionalSteps?: Buffer[];
    mcpMode?: boolean;
  }): Buffer {
    const conversationalParts: Buffer[] = [
      writeProtoVarintField(4, args.nativeMode ? 1 : 3),
    ];
    if (!args.nativeMode && !args.mcpMode && !(args.additionalSteps || []).length) {
      const plannerParts: Buffer[] = [];
      if (args.modelUid) plannerParts.push(writeProtoStringField(35, args.modelUid));
      if (args.modelEnum > 0) {
        plannerParts.push(writeProtoMessageField(15, writeProtoVarintField(1, args.modelEnum)));
        plannerParts.push(writeProtoVarintField(1, args.modelEnum));
      }
      const cascadeConfig = Buffer.concat([
        writeProtoMessageField(1, Buffer.concat(plannerParts)),
      ]);
      return Buffer.concat([
        writeProtoStringField(1, args.cascadeId),
        writeProtoMessageField(2, writeProtoStringField(1, args.text)),
        writeProtoMessageField(3, this.buildWindsurfMetadataProto(args.apiKey, args.sessionId)),
        writeProtoMessageField(5, cascadeConfig),
      ]);
    }
    if (!args.nativeMode) {
      conversationalParts.push(writeProtoMessageField(10, Buffer.concat([
        writeProtoVarintField(1, 1),
        writeProtoStringField(2, 'No tools are available.'),
      ])));
      conversationalParts.push(writeProtoMessageField(12, Buffer.concat([
        writeProtoVarintField(1, 1),
        writeProtoStringField(2,
          'CRITICAL OPERATING CONSTRAINT — READ BEFORE ANY RESPONSE:\n' +
          'You are being accessed as a plain chat API. You have NO tools, NO file access, NO shell, NO code execution, NO repository awareness, NO ability to list or read anything on the user\'s machine or any sandbox. You cannot "check", "look at", "open", "view", "inspect", "run", "glob", "grep", "list", or "edit" anything.\n' +
          '\n' +
          'OUTPUT RULES:\n' +
          '1. Never narrate tool-like actions ("Let me check X", "I\'ll look at Y", "Looking at the file...", "I see in main.py...", "Based on the codebase...").\n' +
          '2. Never reference file paths, directory structures, line numbers, or repository contents that were not explicitly pasted into the current conversation by the user.\n' +
          '3. If the user asks about their code or project but hasn\'t pasted the relevant file content, respond: "I don\'t see that file in our conversation — please paste it and I\'ll help." Do NOT invent file contents.\n' +
          '4. For general questions, answer directly from your training knowledge. No preambles.\n' +
          '5. Match the user\'s language (Chinese → Chinese, English → English; never switch mid-conversation).\n' +
          '\n' +
          'Violating these rules will produce broken output for the end user. Stay in chat-API mode at all times.'),
      ])));
      conversationalParts.push(writeProtoMessageField(13, Buffer.concat([
        writeProtoVarintField(1, 1),
        writeProtoStringField(2, WINDSURF_CASCADE_COMMUNICATION_NO_TOOLS),
      ])));
    }
    const conversationalConfig = Buffer.concat(conversationalParts);
    const plannerParts: Buffer[] = [
      writeProtoMessageField(2, conversationalConfig),
      writeProtoStringField(35, args.modelUid),
      writeProtoStringField(34, args.modelUid),
    ];
    if (args.modelEnum > 0) {
      plannerParts.push(writeProtoMessageField(15, writeProtoVarintField(1, args.modelEnum)));
      plannerParts.push(writeProtoVarintField(1, args.modelEnum));
    }
    plannerParts.push(writeProtoVarintField(6, 32768));
    plannerParts.push(writeProtoMessageField(11, Buffer.concat([
      writeProtoVarintField(1, 1),
      writeProtoStringField(2, ''),
    ])));
    if (args.nativeMode || args.mcpMode) {
      plannerParts.push(writeProtoMessageField(13, this.buildNativeCascadeToolConfig(args.nativeAllowlist || [])));
    }
    const cascadeConfig = Buffer.concat([
      writeProtoMessageField(1, Buffer.concat(plannerParts)),
      writeProtoMessageField(5, writeProtoBoolField(1, false)),
      writeProtoMessageField(7, Buffer.concat([
        writeProtoVarintField(1, 1),
        writeProtoMessageField(6, writeProtoMessageField(6, Buffer.alloc(0))),
      ])),
    ]);
    return Buffer.concat([
      writeProtoStringField(1, args.cascadeId),
      writeProtoMessageField(2, writeProtoStringField(1, args.text)),
      writeProtoMessageField(3, this.buildWindsurfMetadataProto(args.apiKey, args.sessionId)),
      writeProtoMessageField(5, cascadeConfig),
      ...((args.additionalSteps || []).filter((step) => Buffer.isBuffer(step) && step.length > 0).map((step) => writeProtoMessageField(9, step))),
    ]);
  }

  private buildGetTrajectoryStepsRequest(cascadeId: string, stepOffset = 0): Buffer {
    return Buffer.concat([
      writeProtoStringField(1, cascadeId),
      ...(stepOffset > 0 ? [writeProtoVarintField(2, stepOffset)] : []),
    ]);
  }

  private parseStartCascadeResponse(bytes: Uint8Array): string {
    const fields = this.parseProtoFields(bytes);
    return this.readProtoString(fields, 1);
  }

  private buildInitializePanelStateRequest(apiKey: string, sessionId: string): Buffer {
    return Buffer.concat([
      writeProtoMessageField(1, this.buildWindsurfMetadataProto(apiKey, sessionId)),
      writeProtoVarintField(3, 1),
    ]);
  }

  private buildHeartbeatRequest(apiKey: string, sessionId: string): Buffer {
    return Buffer.concat([writeProtoMessageField(1, this.buildWindsurfMetadataProto(apiKey, sessionId))]);
  }

  private buildGetUserStatusRequest(apiKey: string): Buffer {
    return Buffer.concat([writeProtoMessageField(1, this.buildWindsurfMetadataProto(apiKey))]);
  }

  private extractWindsurfUserStatusBytes(response: Buffer): Buffer | null {
    const fields = this.parseProtoFields(response);
    const userStatus = this.getProtoField(fields, 1, 2);
    if (!userStatus || !(userStatus.value instanceof Uint8Array) || userStatus.value.length === 0) return null;
    return Buffer.from(userStatus.value);
  }

  private buildUpdatePanelStateWithUserStatusRequest(apiKey: string, sessionId: string, userStatusBytes: Buffer | null): Buffer {
    return Buffer.concat([
      writeProtoMessageField(1, this.buildWindsurfMetadataProto(apiKey, sessionId)),
      ...(userStatusBytes && userStatusBytes.length > 0 ? [writeProtoMessageField(2, userStatusBytes)] : []),
    ]);
  }

  private buildAddTrackedWorkspaceRequest(workspacePath: string): Buffer {
    return writeProtoStringField(1, workspacePath);
  }

  private buildUpdateWorkspaceTrustRequest(apiKey: string, sessionId: string, trusted: boolean): Buffer {
    return Buffer.concat([
      writeProtoMessageField(1, this.buildWindsurfMetadataProto(apiKey, sessionId)),
      writeProtoVarintField(2, trusted ? 1 : 0),
    ]);
  }

  private buildGetTrajectoryRequest(cascadeId: string): Buffer {
    return writeProtoStringField(1, cascadeId);
  }

  private parseTrajectoryStatus(bytes: Uint8Array): number {
    const fields = this.parseProtoFields(bytes);
    return this.readProtoNumber(fields, 2) ?? 0;
  }

  private resolveWindsurfCascadeSessionId(forceFresh = false): string {
    if (forceFresh || !this.windsurfCascadeSessionIdOverride) {
      const configured = typeof this.windsurfRuntime.sessionId === 'string' ? this.windsurfRuntime.sessionId.trim() : '';
      this.windsurfCascadeSessionIdOverride = forceFresh ? randomUUID() : configured || randomUUID();
    }
    return this.windsurfCascadeSessionIdOverride;
  }

  private async runWindsurfCascadeSendExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.windsurfCascadeSendQueue;
    let release!: () => void;
    this.windsurfCascadeSendQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private resetWindsurfCascadeTransportState(reason: string): void {
    this.logWindsurfStage('cascade.transport.reset', { reason });
    this.closeLocalGrpcSession();
    this.windsurfCascadeWarmupPromise = null;
    this.windsurfCascadeSessionIdOverride = null;
    this.clearPinnedGrpcRuntime();
    const scope = WindsurfChatProvider.cascadeRuntimeScope.getStore();
    if (scope?.sessionKey) {
      this.windsurfCascadeSessionBindings.delete(scope.sessionKey);
    }
    if (/transport|timeout|warmup|panel|send|cascade/i.test(reason)) {
      this.disposeManagedLocalGrpcRuntime(reason);
    }
  }

  private disposeManagedLocalGrpcRuntime(reason: string): void {
    const key = this.resolveWindsurfManagedLsKey();
    const runtime = WINDSURF_MANAGED_LS_POOL.get(key);
    WINDSURF_MANAGED_LS_PENDING.delete(key);
    if (!runtime) return;
    WINDSURF_MANAGED_LS_POOL.delete(key);
    this.closeLocalGrpcSessionForPort(runtime.port);
    runtime.ready = false;
    runtime.sessionId = null;
    runtime.workspaceInit = null;
    this.logWindsurfStage('managedLs.dispose', { key, port: runtime.port, reason });
    if (runtime.process.exitCode == null && runtime.process.signalCode == null) {
      try { runtime.process.kill('SIGTERM'); } catch {}
    }
  }

  private getPinnedGrpcRuntime(): WindsurfProviderRuntimeOptions | null {
    return WindsurfChatProvider.cascadeRuntimeScope.getStore()?.pinnedRuntime || null;
  }

  private setPinnedGrpcRuntime(runtime: WindsurfProviderRuntimeOptions | null): void {
    const scope = WindsurfChatProvider.cascadeRuntimeScope.getStore();
    if (scope) {
      scope.pinnedRuntime = runtime;
    }
  }

  private clearPinnedGrpcRuntime(): void {
    this.setPinnedGrpcRuntime(null);
  }

  private resolveCascadeRuntimeQueueKey(): string {
    const scopedAlias = WindsurfChatProvider.cascadeRuntimeScope.getStore()?.accountAlias?.trim() || '';
    if (scopedAlias) return scopedAlias;
    const credentialAlias = this.windsurfSessionCredential?.accountAlias?.trim() || '';
    if (credentialAlias) return credentialAlias;
    const auth = (this.config.config as Record<string, unknown>).auth as Record<string, unknown> | undefined;
    const alias = typeof auth?.accountAlias === 'string' && auth.accountAlias.trim() ? auth.accountAlias.trim() : '';
    const account = typeof auth?.account === 'string' && auth.account.trim() ? auth.account.trim() : '';
    return alias || account || 'windsurf-default-runtime';
  }

  private extractLatestCascadeUserText(semanticConversation: WindsurfSemanticTurn[], tailParts: string[] = [], includeToolResults = true): string {
    return extractLatestCascadeUserText(semanticConversation, tailParts, includeToolResults);
  }

  private buildCascadeHistoryTurnText(turn: WindsurfSemanticTurn): string {
    return buildCascadeHistoryTurnText(turn);
  }

  private buildCascadePromptText(
    messages: unknown,
    semanticConversation: WindsurfSemanticTurn[],
    modelUid: string,
    mcpTools: Array<Record<string, unknown>> = [],
    seedTailParts: string[] = [],
    nativeTools: Array<Record<string, unknown>> = [],
    toolChoice?: unknown,
    resumeExistingCascade = false,
  ): string {
    return buildCascadePromptText(messages, semanticConversation, modelUid, mcpTools, seedTailParts, nativeTools, toolChoice, resumeExistingCascade);
  }

  private buildWindsurfNativeToolAliasText(nativeTools: Array<Record<string, unknown>> = [], toolChoice?: unknown): string {
    return buildWindsurfNativeToolAliasText(nativeTools, toolChoice);
  }

  private rewriteWindsurfNativeToolAliasesInText(text: string, nativeTools: Array<Record<string, unknown>> = []): string {
    return rewriteWindsurfNativeToolAliasesInText(text, nativeTools);
  }

  private extractWindsurfToolChoiceName(toolChoice: unknown): string {
    return extractWindsurfToolChoiceName(toolChoice);
  }

  private readDeltaSeedParts(body: Record<string, unknown>): string[] {
    return readDeltaSeedParts(body);
  }

  private async sendStartCascade(args: {
    apiKey: string;
    sessionId: string;
  }): Promise<string> {
    try {
      const response = await this.grpcUnaryLocal(
        `${WINDSURF_LS_SERVICE}/StartCascade`,
        this.buildStartCascadeRequest(args.apiKey, args.sessionId),
      );
      const cascadeId = this.parseStartCascadeResponse(response);
      if (!cascadeId) {
        throw createWindsurfProviderError('[windsurf] StartCascade returned empty cascade_id', {
          code: 'WINDSURF_RESPONSE_PARSE_FAILED',
          status: 502,
          retryable: false,
        });
      }
      return cascadeId;
    } catch (error) {
      throw this.handleWindsurfCascadeTransportFailure(error);
    }
  }

  private handleWindsurfCascadeTransportFailure(error: unknown): Error {
    const classified = this.classifyWindsurfCascadeError(error) as Error & Record<string, unknown>;
    const code = typeof classified.code === 'string' ? classified.code : '';
    if (classified.retryable === true && code !== 'WINDSURF_CASCADE_BUSY') {
      this.resetWindsurfCascadeTransportState('transport-failure');
    }
    return classified;
  }

  private async sendCascadeMessage(args: {
    apiKey: string;
    cascadeId: string;
    text: string;
    sessionId: string;
    modelEnum: number;
    modelUid: string;
    nativeMode?: boolean;
    nativeAllowlist?: WindsurfCascadeToolStepKind[];
    additionalSteps?: Buffer[];
    mcpMode?: boolean;
  }): Promise<void> {
    const payload = this.buildSendCascadeMessageRequest(args);
    await this.snapshotWindsurfCascadeProviderRequest(args, payload);
    try {
      await this.grpcUnaryLocal(
        `${WINDSURF_LS_SERVICE}/SendUserCascadeMessage`,
        payload,
      );
    } catch (error) {
      throw this.handleWindsurfCascadeTransportFailure(error);
    }
  }

  private async sleepWindsurfCascadeBusyRetry(delayMs: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)));
  }

  private resolveCascadeBusyRetryConfig(): WindsurfCascadeBusyRetryConfig | undefined {
    const rt = this.windsurfRuntime as Record<string, unknown> | undefined;
    if (!rt) return undefined;
    const maxRetries = Number(rt.cascadeBusyMaxRetries);
    const perAttemptWaitMs = Number(rt.cascadeBusyPerAttemptWaitMs);
    const pollIntervalMs = Number(rt.cascadeBusyPollIntervalMs);
    const hasAny = Number.isFinite(maxRetries) || Number.isFinite(perAttemptWaitMs) || Number.isFinite(pollIntervalMs);
    if (!hasAny) return undefined;
    const cfg: Partial<WindsurfCascadeBusyRetryConfig> = {};
    if (Number.isFinite(maxRetries) && maxRetries > 0) cfg.maxRetries = Math.floor(maxRetries);
    if (Number.isFinite(perAttemptWaitMs) && perAttemptWaitMs > 0) cfg.perAttemptWaitMs = perAttemptWaitMs;
    if (Number.isFinite(pollIntervalMs) && pollIntervalMs > 0) cfg.pollIntervalMs = pollIntervalMs;
    return cfg as WindsurfCascadeBusyRetryConfig;
  }

  private async sendCascadeMessageWithBusyRetry(args: {
    apiKey: string;
    cascadeId: string;
    text: string;
    sessionId: string;
    modelEnum: number;
    modelUid: string;
    nativeMode?: boolean;
    nativeAllowlist?: WindsurfCascadeToolStepKind[];
    additionalSteps?: Buffer[];
    mcpMode?: boolean;
  }): Promise<void> {
    const busyRetryCfg = this.resolveCascadeBusyRetryConfig();
    await executeWindsurfCascadeBusyRetry(
      { cascadeId: args.cascadeId, sessionId: args.sessionId },
      {
        sendMessage: () => this.sendCascadeMessage(args),
        sleep: (ms) => this.sleepWindsurfCascadeBusyRetry(ms),
        log: (stage, details) => this.logWindsurfStage(stage, details),
        config: busyRetryCfg,
        pollIdle: async () => {
          try {
            const statusResponse = await this.grpcUnaryLocal(
              `${WINDSURF_LS_SERVICE}/GetCascadeTrajectory`,
              this.buildGetTrajectoryRequest(args.cascadeId),
            );
            const status = this.parseTrajectoryStatus(statusResponse);
            return { idle: status === 1 };
          } catch {
            return { idle: false };
          }
        },
      },
    );
  }

  private async snapshotWindsurfCascadeProviderRequest(args: {
    cascadeId: string;
    text: string;
    sessionId: string;
    modelEnum: number;
    modelUid: string;
    nativeMode?: boolean;
    nativeAllowlist?: WindsurfCascadeToolStepKind[];
    additionalSteps?: Buffer[];
    mcpMode?: boolean;
  }, payload: Buffer): Promise<void> {
    const context = this.createProviderContext();
    const additionalSteps = Array.isArray(args.additionalSteps) ? args.additionalSteps.filter((step) => Buffer.isBuffer(step) && step.length > 0) : [];
    const additionalStepDiagnostics = additionalSteps.map((step) => {
      const fields = parseProtoFields(step);
      const typeEnum = getProtoField(fields, 1, 0)?.value ?? null;
      const oneofFields = fields
        .filter((field) => field.wireType === 2 && field.fieldNo !== 1 && field.fieldNo !== 4)
        .map((field) => field.fieldNo);
      return {
        bytes: step.length,
        typeEnum,
        oneofFields,
      };
    });
    const text = String(args.text || '');
    try {
      await writeProviderSnapshot({
        phase: 'provider-request',
        requestId: context.requestId,
        data: {
          transport: 'windsurf-local-cascade-grpc',
          grpcPath: `${WINDSURF_LS_SERVICE}/SendUserCascadeMessage`,
          cascadeId: args.cascadeId,
          sessionId: args.sessionId,
          modelEnum: args.modelEnum,
          modelUid: args.modelUid,
          nativeMode: args.nativeMode === true,
          nativeAllowlist: args.nativeAllowlist || [],
          additionalStepsCount: additionalSteps.length,
          additionalStepDiagnostics,
          mcpMode: args.mcpMode === true,
          payloadBytes: payload.length,
          textBytes: Buffer.byteLength(text, 'utf8'),
          text,
          promptDiagnostics: {
            hasApplyPatch: text.includes('apply_patch'),
          },
        },
        url: `grpc://127.0.0.1:${this.getPinnedGrpcRuntime()?.lsPort || 'unknown'}${WINDSURF_LS_SERVICE}/SendUserCascadeMessage`,
        entryEndpoint: context.metadata?.entryEndpoint as string | undefined,
        clientRequestId: typeof context.runtimeMetadata?.clientRequestId === 'string' ? context.runtimeMetadata.clientRequestId : undefined,
        providerKey: context.providerKey,
        providerId: context.providerId,
      });
    } catch (snapshotError) {
      const reason = snapshotError instanceof Error ? snapshotError.message : String(snapshotError ?? 'unknown');
      console.warn(`[windsurf.snapshot.provider-request] failed requestId=${context.requestId} providerKey=${context.providerKey || ''} error=${reason}`);
    }
  }

  private async pollCascadeTrajectorySteps(args: {
    cascadeId: string;
    model: string;
    stepOffset?: number;
    promptChars?: number;
    customTools?: Array<Record<string, unknown>>;
    nativeTools?: Array<Record<string, unknown>>;
    completedNativeToolCallIds?: string[];
    completedNativeToolSignatures?: string[];
  }): Promise<{
    candidate: Record<string, unknown>;
    usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } | null;
    stepOffset: number;
  }> {
    try {
      void args.model;
      // Use pollMaxWaitMs from provider config, defaulting to 120s
      const maxWaitMs = this.windsurfRuntime?.pollMaxWaitMs ?? 120_000;
      const pollIntervalMs = 500;
      const idleGraceMs = 1_500;
      const configuredColdStallBaseMs = Number((this.windsurfRuntime as Record<string, unknown>)?.coldStallBaseMs);
      const coldStallBaseMs = Number.isFinite(configuredColdStallBaseMs) && configuredColdStallBaseMs > 0
        ? configuredColdStallBaseMs
        : 30_000;
      const configuredWarmStallMs = Number((this.windsurfRuntime as Record<string, unknown>)?.warmStallMs);
      const warmStallMs = Number.isFinite(configuredWarmStallMs) && configuredWarmStallMs > 0
        ? configuredWarmStallMs
        : 45_000;
      const configuredThinkingWarmStallMs = Number((this.windsurfRuntime as Record<string, unknown>)?.warmStallThinkingMs);
      const warmStallThinkingMs = Number.isFinite(configuredThinkingWarmStallMs) && configuredThinkingWarmStallMs > 0
        ? configuredThinkingWarmStallMs
        : 120_000;
      const configuredToolWarmStallMs = Number((this.windsurfRuntime as Record<string, unknown>)?.warmStallToolActiveMs);
      const warmStallToolActiveMs = Number.isFinite(configuredToolWarmStallMs) && configuredToolWarmStallMs > 0
        ? configuredToolWarmStallMs
        : 180_000;
      const configuredStableToolCallReturnMs = Number((this.windsurfRuntime as Record<string, unknown>)?.stableToolCallReturnMs);
      const stableToolCallReturnMs = Number.isFinite(configuredStableToolCallReturnMs) && configuredStableToolCallReturnMs > 0
        ? configuredStableToolCallReturnMs
        : 5_000;
      const promptChars = Math.max(0, Number.isFinite(Number(args.promptChars)) ? Number(args.promptChars) : 0);
      const coldStallMs = Math.min(maxWaitMs, coldStallBaseMs + Math.floor(promptChars / 1500) * 5_000);
      const startedAt = Date.now();
      let lastText = '';
      let lastThinking = '';
      let lastToolCallSignature = '';
      let usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } | null = null;
      let sawActive = false;
      let sawText = false;
      let idleCount = 0;
      let lastGrowthAt = startedAt;
      const completedNativeToolCallIds = new Set(Array.isArray(args.completedNativeToolCallIds) ? args.completedNativeToolCallIds : []);
      const completedNativeToolSignatures = new Set(Array.isArray(args.completedNativeToolSignatures) ? args.completedNativeToolSignatures : []);
      const stepOffset = Number.isFinite(Number(args.stepOffset)) && Number(args.stepOffset) >= 0
        ? Math.floor(Number(args.stepOffset))
        : 0;
      let lastStepCount = 0;
      let lastPollLogAt = 0;
      let lastPollLogKey = '';
      let pendingToolCandidate: Record<string, unknown> | null = null;
      let pendingToolStepOffset = stepOffset;

      while (Date.now() - startedAt < maxWaitMs) {
        const stepsResponse = await this.grpcUnaryLocal(
          `${WINDSURF_LS_SERVICE}/GetCascadeTrajectorySteps`,
          this.buildGetTrajectoryStepsRequest(args.cascadeId, stepOffset),
        );
        const steps = this.parseTrajectorySteps(stepsResponse);
        const nextStepOffset = stepOffset + steps.length;
        let accumulatedText = '';
        let accumulatedThinking = '';
        const toolCalls: Array<Record<string, unknown>> = [];
        const seenToolCallIds = new Set<string>();

        if (steps.length > lastStepCount) {
          lastStepCount = steps.length;
          lastGrowthAt = Date.now();
        }

        for (const step of steps) {
          if (step && typeof step === 'object') {
            const row = step as Record<string, unknown>;
            if (typeof row.errorText === 'string' && row.errorText.trim()) {
              throw createWindsurfProviderError(row.errorText.trim(), {
                code: 'WINDSURF_UPSTREAM_TRANSIENT',
                status: 502,
                retryable: true,
              });
            }
            if (typeof row.responseText === 'string' && row.responseText) {
              accumulatedText += row.responseText;
            } else if (typeof row.text === 'string' && row.text) {
              accumulatedText += row.text;
            }
            if (typeof row.thinking === 'string' && row.thinking) {
              accumulatedThinking += row.thinking;
            }
            if (row.usage && typeof row.usage === 'object') {
              usage = row.usage as { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
            }
            if (Array.isArray(row.toolCalls)) {
              for (const rawCall of row.toolCalls as Array<Record<string, unknown>>) {
                if (typeof rawCall.result === 'string' && rawCall.result.length > 0) continue;
                const rawName = typeof rawCall.name === 'string' ? rawCall.name : '';
                const rawArgsJson = typeof rawCall.argumentsJson === 'string' ? rawCall.argumentsJson : '{}';
                const rawId = typeof rawCall.id === 'string' ? rawCall.id.trim() : '';
                if (rawId && completedNativeToolCallIds.has(rawId)) continue;
                if (rawName) {
                  try {
                    const parsedArgs = JSON.parse(rawArgsJson);
                    if (parsedArgs && typeof parsedArgs === 'object' && !Array.isArray(parsedArgs)) {
                      const signature = this.buildWindsurfNativeToolSignature(rawName, parsedArgs as Record<string, unknown>);
                      if (completedNativeToolSignatures.has(signature)) continue;
                    }
                  } catch {
                    // malformed upstream arguments are preserved for the normal parser below
                  }
                }
                const id = rawId || `${rawName || 'tool'}:${rawArgsJson}:${toolCalls.length}`;
                if (seenToolCallIds.has(id)) continue;
                seenToolCallIds.add(id);
                toolCalls.push({
                  id,
                  type: 'function',
                  function: {
                    name: rawName,
                    arguments: rawArgsJson,
                  },
                });
              }
            }
          }
        }

        const toolCallSignature = toolCalls.map((toolCall) => {
          const fn = toolCall.function && typeof toolCall.function === 'object' ? toolCall.function as Record<string, unknown> : {};
          return `${String(toolCall.id || '')}:${String(fn.name || '')}:${String(fn.arguments || '')}`;
        }).join('|');
        if (accumulatedText.length > lastText.length || accumulatedThinking.length > lastThinking.length || toolCallSignature !== lastToolCallSignature) {
          lastGrowthAt = Date.now();
        }
        if (accumulatedText) sawText = true;

        if (toolCalls.length > 0) {
          pendingToolCandidate = this.parseCascadeAssistantTurnSync({
            role: 'assistant',
            content: accumulatedText,
            ...(accumulatedThinking ? { reasoning_content: accumulatedThinking } : {}),
            tool_calls: toolCalls,
          }, [...(args.nativeTools || []), ...(args.customTools || [])]);
          pendingToolStepOffset = nextStepOffset;
        }

        lastText = accumulatedText || lastText;
        lastThinking = accumulatedThinking || lastThinking;
        lastToolCallSignature = toolCallSignature;

        const statusResponse = await this.grpcUnaryLocal(
          `${WINDSURF_LS_SERVICE}/GetCascadeTrajectory`,
          this.buildGetTrajectoryRequest(args.cascadeId),
        );
        const status = this.parseTrajectoryStatus(statusResponse);
        const elapsedMs = Date.now() - startedAt;
        const textBytes = Buffer.byteLength(accumulatedText, 'utf8');
        const thinkingBytes = Buffer.byteLength(accumulatedThinking, 'utf8');
        const pollLogKey = [status, steps.length, textBytes, thinkingBytes, toolCalls.length, idleCount].join(':');
        const pollTraceEnabled = /^(1|true|trace)$/i.test(String(process.env.ROUTECODEX_WINDSURF_DEBUG || process.env.RCC_WINDSURF_DEBUG || '').trim());
        if (pollLogKey !== lastPollLogKey || (pollTraceEnabled && Date.now() - lastPollLogAt >= 10_000)) {
          lastPollLogKey = pollLogKey;
          lastPollLogAt = Date.now();
          console.log(`[windsurf.poll.status] ${JSON.stringify({ cascadeId: args.cascadeId, status, steps: steps.length, pollStepOffset: stepOffset, textBytes, thinkingBytes, toolCalls: toolCalls.length, idleCount, elapsedMs })}`);
        }
        if (status !== 1) {
          sawActive = true;
          idleCount = 0;
          const elapsed = Date.now() - startedAt;
          const msSinceGrowth = Date.now() - lastGrowthAt;
          if (elapsed > coldStallMs && !sawText && !lastThinking && toolCalls.length === 0) {
            throw createWindsurfProviderError(`[windsurf] Cascade planner stalled with no output after ${Math.round(coldStallMs / 1000)}s`, {
              code: 'WINDSURF_CASCADE_STALLED',
              status: 504,
              retryable: false,
            });
          }
          if (!sawText && !lastThinking && !pendingToolCandidate && msSinceGrowth > coldStallBaseMs) {
            this.logWindsurfStage('poll.coldNoGrowthStall', {
              cascadeId: args.cascadeId,
              status,
              msSinceGrowth,
              coldStallBaseMs,
              pollStepOffset: stepOffset,
            });
            throw createWindsurfProviderError(`[windsurf] Cascade planner stalled with no visible output and no new steps for ${Math.round(coldStallBaseMs / 1000)}s`, {
              code: 'WINDSURF_CASCADE_STALLED',
              status: 504,
              retryable: false,
            });
          }
          const hasActiveStep = steps.some((step) => step && typeof step === 'object' && Number((step as Record<string, unknown>).status) === 1);
          const warmSignal = sawText || Boolean(lastThinking) || Boolean(pendingToolCandidate);
          const warmCeilingMs = pendingToolCandidate && hasActiveStep
            ? warmStallToolActiveMs
            : lastThinking
              ? warmStallThinkingMs
              : warmStallMs;
          if (warmSignal && msSinceGrowth > warmCeilingMs) {
            this.logWindsurfStage('poll.warmStall', {
              cascadeId: args.cascadeId,
              status,
              msSinceGrowth,
              warmCeilingMs,
              textBytes: Buffer.byteLength(lastText, 'utf8'),
              thinkingBytes: Buffer.byteLength(lastThinking, 'utf8'),
              pendingTool: Boolean(pendingToolCandidate),
              hasActiveStep,
              pollStepOffset: stepOffset,
            });
            throw createWindsurfProviderError(`[windsurf] Cascade planner stalled after progress — no new output for ${Math.round(warmCeilingMs / 1000)}s`, {
              code: 'WINDSURF_CASCADE_STALLED',
              status: 504,
              retryable: false,
            });
          }
        } else {
          const elapsed = Date.now() - startedAt;
          if (!sawActive && elapsed <= idleGraceMs) {
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
            continue;
          }
          idleCount += 1;
          const growthSettled = Date.now() - lastGrowthAt > pollIntervalMs * 2;
          const canBreak = sawText ? idleCount >= 2 && growthSettled : idleCount >= 4;
          if (canBreak) {
            const finalStepsResponse = await this.grpcUnaryLocal(
              `${WINDSURF_LS_SERVICE}/GetCascadeTrajectorySteps`,
              this.buildGetTrajectoryStepsRequest(args.cascadeId, stepOffset),
            );
            const finalSteps = this.parseTrajectorySteps(finalStepsResponse);
            const finalStepOffset = stepOffset + finalSteps.length;
            let finalText = '';
            let finalThinking = '';
            for (const step of finalSteps) {
              if (!step || typeof step !== 'object') continue;
              const row = step as Record<string, unknown>;
              finalText += typeof row.responseText === 'string' && row.responseText ? row.responseText : typeof row.text === 'string' ? row.text : '';
              finalThinking += typeof row.thinking === 'string' ? row.thinking : '';
            }
            const finalContent = finalText || lastText || '';
            const finalReasoning = finalThinking || lastThinking || '';
            if (pendingToolCandidate) {
              return { candidate: pendingToolCandidate, usage, stepOffset: Math.max(pendingToolStepOffset, finalStepOffset) };
            }
            if (!finalContent.trim() && !finalReasoning.trim() && (completedNativeToolCallIds.size > 0 || completedNativeToolSignatures.size > 0)) {
              this.logWindsurfStage('poll.emptyAfterNativeResult', {
                cascadeId: args.cascadeId,
                steps: finalSteps.length,
                completedNativeToolCallIds: Array.from(completedNativeToolCallIds),
                completedNativeToolSignatures: Array.from(completedNativeToolSignatures),
                customTools: (args.customTools || []).map((tool) => {
                  const fn = tool && typeof tool === 'object' && !Array.isArray(tool) ? tool.function as Record<string, unknown> | undefined : undefined;
                  return typeof fn?.name === 'string' ? fn.name : '';
                }).filter(Boolean),
              });
              await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
              continue;
            }
            const candidate = this.parseCascadeAssistantTurnSync({
              role: 'assistant',
              content: finalContent,
              ...(finalReasoning ? { reasoning_content: finalReasoning } : {}),
            }, args.customTools || []);
            return { candidate, usage, stepOffset: finalStepOffset };
          }
        }

        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }

      throw createWindsurfProviderError('[windsurf] GetCascadeTrajectorySteps poll timeout', {
        code: 'WINDSURF_FETCH_TIMEOUT',
        status: 504,
        retryable: true,
      });
    } catch (error) {
      throw this.handleWindsurfCascadeTransportFailure(error);
    }
  }

  private async ensureWindsurfCascadeWarmup(apiKey: string, sessionId: string, force = false): Promise<void> {
    if (force) {
      this.resetWindsurfCascadeTransportState('force-warmup');
      this.windsurfCascadeSessionIdOverride = sessionId;
    }
    if (this.windsurfCascadeWarmupPromise) {
      await this.windsurfCascadeWarmupPromise;
      return;
    }
    const workspacePath = this.resolveManagedWorkspacePath(apiKey);
    await fs.mkdir(workspacePath, { recursive: true });
    const runWarmupStage = async (stage: string, operation: () => Promise<unknown>, timeoutMs: number, continueOnNonTransportError = true): Promise<void> => {
      let timer: NodeJS.Timeout | null = null;
      try {
        console.log(`[windsurf.warmup.stage.start] ${stage}`);
        await Promise.race([
          operation(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(createWindsurfProviderError(`windsurf warmup timeout: ${stage}`, {
              code: 'WINDSURF_FETCH_TIMEOUT',
              status: 504,
              retryable: true,
            })), timeoutMs);
          }),
        ]);
        console.log(`[windsurf.warmup.stage.end] ${stage}`);
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error || '');
        const retryable = error && typeof error === 'object' && (error as Record<string, unknown>).retryable === true;
        const knownNonTransport = /path is already tracked/i.test(message);
        const transportLike = !knownNonTransport && (retryable || /pending stream has been canceled|ECONNRESET|ERR_HTTP2|session closed|stream closed|panel state|timeout/i.test(message));
        this.logWindsurfStage('warmup.stage.failed', { stage, error: message, transportLike });
        console.warn(`[windsurf.warmup.stage.failed] ${JSON.stringify({ stage, message, transportLike })}`);
        if (transportLike || !continueOnNonTransportError) {
          throw error;
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    this.windsurfCascadeWarmupPromise = (async () => {
      let userStatusResponse: Buffer = Buffer.alloc(0);
      await runWarmupStage('GetUserStatus', async () => {
        userStatusResponse = await this.grpcUnaryLocal(
          `${WINDSURF_LS_SERVICE}/GetUserStatus`,
          this.buildGetUserStatusRequest(apiKey),
          10_000,
        );
      }, 10_000, false);
      const userStatusBytes = this.extractWindsurfUserStatusBytes(userStatusResponse);
      await runWarmupStage('UpdatePanelStateWithUserStatus', async () => {
        await this.grpcUnaryLocal(
          `${WINDSURF_LS_SERVICE}/UpdatePanelStateWithUserStatus`,
          this.buildUpdatePanelStateWithUserStatusRequest(apiKey, sessionId, userStatusBytes),
          5_000,
        );
      }, 5_000, false);
      await runWarmupStage('InitializeCascadePanelState', async () => {
        await this.grpcUnaryLocal(
          `${WINDSURF_LS_SERVICE}/InitializeCascadePanelState`,
          this.buildInitializePanelStateRequest(apiKey, sessionId),
          5_000,
        );
      }, 5_000, false);
      await runWarmupStage('AddTrackedWorkspace', async () => {
        await this.grpcUnaryLocal(
          `${WINDSURF_LS_SERVICE}/AddTrackedWorkspace`,
          this.buildAddTrackedWorkspaceRequest(workspacePath),
          5_000,
        );
      }, 5_000, true);
    })();
    try {
      await this.windsurfCascadeWarmupPromise;
    } catch (error) {
      this.resetWindsurfCascadeTransportState('warmup-failed');
      throw error;
    }
  }

  private grpcFrame(payload: Buffer): Buffer {
    const frame = Buffer.alloc(5 + payload.length);
    frame[0] = 0;
    frame.writeUInt32BE(payload.length, 1);
    payload.copy(frame, 5);
    return frame;
  }

  private decodeGrpcFramePayload(payload: Buffer, compressed: number): Buffer {
    if (compressed === 0) return payload;
    if (compressed === 1) return gunzipSync(payload);
    throw createWindsurfProviderError(`[windsurf] unsupported grpc frame compression flag=${compressed}`, {
      code: 'WINDSURF_RESPONSE_PARSE_FAILED',
      status: 502,
      retryable: false,
    });
  }

  private stripGrpcFrame(buf: Buffer): Buffer {
    if (buf.length >= 5) {
      const compressed = buf[0] ?? 0;
      const messageLength = buf.readUInt32BE(1);
      if (buf.length >= 5 + messageLength) {
        return this.decodeGrpcFramePayload(buf.subarray(5, 5 + messageLength), compressed);
      }
    }
    return buf;
  }

  private extractGrpcFrames(buf: Buffer): Buffer[] {
    const frames: Buffer[] = [];
    let offset = 0;
    while (offset + 5 <= buf.length) {
      const compressed = buf[offset] ?? 0;
      const messageLength = buf.readUInt32BE(offset + 1);
      if (offset + 5 + messageLength > buf.length) {
        break;
      }
      frames.push(this.decodeGrpcFramePayload(buf.subarray(offset + 5, offset + 5 + messageLength), compressed));
      offset += 5 + messageLength;
    }
    return frames;
  }

  private getLocalGrpcSession(): http2.ClientHttp2Session {
    const runtime = this.getPinnedGrpcRuntime() || this.resolveLiveLocalGrpcRuntime();
    const port = runtime.lsPort;
    if (!port) {
      throw createWindsurfProviderError('[windsurf] runtime lsPort missing for local cascade transport', {
        code: 'WINDSURF_REQUEST_BUILD_FAILED',
        status: 501,
        retryable: false,
      });
    }
    const key = `localhost:${port}`;
    const existing = WindsurfChatProvider.http2SessionPool.get(key);
    if (existing && !existing.destroyed && !existing.closed) {
      return existing;
    }
    const session = http2.connect(`http://localhost:${port}`);
    session.on('error', () => {
      if (WindsurfChatProvider.http2SessionPool.get(key) === session) {
        WindsurfChatProvider.http2SessionPool.delete(key);
      }
    });
    session.on('close', () => {
      if (WindsurfChatProvider.http2SessionPool.get(key) === session) {
        WindsurfChatProvider.http2SessionPool.delete(key);
      }
    });
    try { session.unref(); } catch {}
    WindsurfChatProvider.http2SessionPool.set(key, session);
    return session;
  }

  private closeLocalGrpcSession(): void {
    const port = (this.getPinnedGrpcRuntime() || this.resolveLiveLocalGrpcRuntime()).lsPort;
    if (!port) return;
    const key = `localhost:${port}`;
    const session = WindsurfChatProvider.http2SessionPool.get(key);
    if (session) {
      try { session.close(); } catch {}
      WindsurfChatProvider.http2SessionPool.delete(key);
    }
  }

  private closeLocalGrpcSessionForPort(port: number): void {
    if (!port) return;
    const key = `localhost:${port}`;
    const session = WindsurfChatProvider.http2SessionPool.get(key);
    if (session) {
      try { session.close(); } catch {}
      WindsurfChatProvider.http2SessionPool.delete(key);
    }
  }

  private execFileUtf8(command: string, args: string[]): string {
    return childProcess.execFileSync(command, args, { encoding: 'utf8' });
  }


  private resolveWindsurfManagedLsKey(): string {
    return this.resolveCascadeRuntimeQueueKey();
  }

  private resolveWindsurfManagedLsBinaryPath(): string {
    const candidates = [
      '/Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf/bin/language_server_macos_arm',
      path.join(os.homedir(), '.windsurf', 'language_server_macos_arm'),
    ];
    for (const candidate of candidates) {
      try {
        if (childProcess.execFileSync('test', ['-x', candidate], { stdio: 'ignore' }) === undefined) {
          return candidate;
        }
      } catch {
        // try next
      }
    }
    return candidates[0]!;
  }

  private isTcpPortListening(port: number): boolean {
    try {
      const stdout = this.execFileUtf8('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']);
      return stdout.includes(`:${port}`);
    } catch {
      return false;
    }
  }

  private findFreeManagedLsPort(preferredPort: number): number {
    let port = preferredPort;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (!this.isTcpPortListening(port)) return port;
      port += 1;
    }
    throw createWindsurfProviderError(`[windsurf] no free local LS port starting at ${preferredPort}`, {
      code: 'WINDSURF_SERVICE_UNREACHABLE',
      status: 503,
      retryable: true,
    });
  }

  private async waitManagedLsPortReady(port: number, timeoutMs = 25_000): Promise<void> {
    const started = Date.now();
    let lastError: unknown = null;
    while (Date.now() - started < timeoutMs) {
      try {
        await new Promise<void>((resolve, reject) => {
          const session = http2.connect(`http://localhost:${port}`);
          const timer = setTimeout(() => {
            try { session.close(); } catch {}
            reject(new Error('timeout'));
          }, 1000);
          session.once('connect', () => {
            clearTimeout(timer);
            try { session.close(); } catch {}
            resolve();
          });
          session.once('error', (error) => {
            clearTimeout(timer);
            try { session.close(); } catch {}
            reject(error);
          });
        });
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw createWindsurfProviderError(`[windsurf] managed LS port ${port} not ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`, {
      code: 'WINDSURF_SERVICE_UNREACHABLE',
      status: 503,
      retryable: true,
    });
  }

  private async ensureManagedLocalGrpcRuntime(): Promise<WindsurfManagedLocalGrpcRuntime> {
    const key = this.resolveWindsurfManagedLsKey();
    const existing = WINDSURF_MANAGED_LS_POOL.get(key);
    if (existing && existing.ready && existing.process.exitCode == null && existing.process.signalCode == null && this.isTcpPortListening(existing.port)) {
      return existing;
    }
    const live = this.findPreferredManagedWindsurfRuntimeForKey(key);
    if (live?.lsPort && this.isTcpPortListening(live.lsPort)) {
      const adopted: WindsurfManagedLocalGrpcRuntime = {
        port: live.lsPort,
        csrfToken: live.csrfToken || this.windsurfRuntime.csrfToken || WINDSURF_MANAGED_LS_CSRF,
        process: {
          exitCode: null,
          signalCode: null,
          kill: () => false,
        } as unknown as childProcess.ChildProcess,
        ready: true,
        sessionId: null,
        workspaceInit: null,
      };
      this.logWindsurfStage('managedLs.adopt', { key, port: adopted.port });
      WINDSURF_MANAGED_LS_POOL.set(key, adopted);
      this.terminateStaleManagedLocalGrpcRuntimes(key, live.lsPort);
      return adopted;
    }
    const pending = WINDSURF_MANAGED_LS_PENDING.get(key);
    if (pending) return pending;
    const promise = (async () => {
      this.terminateStaleManagedLocalGrpcRuntimes(key);
      const preferred = this.windsurfRuntime.lsPort && this.windsurfRuntime.lsPort > 0
        ? this.windsurfRuntime.lsPort
        : WINDSURF_MANAGED_LS_DEFAULT_PORT;
      const port = this.findFreeManagedLsPort(preferred);
      const csrfToken = this.windsurfRuntime.csrfToken || WINDSURF_MANAGED_LS_CSRF;
      const binary = this.resolveWindsurfManagedLsBinaryPath();
      const codeiumDir = this.resolveManagedLsCodeiumDir(key);
      const databaseDir = path.join(codeiumDir, 'db');
      await fs.mkdir(databaseDir, { recursive: true });
      const args = [
        '--api_server_url=https://server.self-serve.windsurf.com',
        `--server_port=${port}`,
        `--csrf_token=${csrfToken}`,
        '--register_user_url=https://api.codeium.com/register_user/',
        `--codeium_dir=${codeiumDir}`,
        `--database_dir=${databaseDir}`,
        '--detect_proxy=false',
      ];
      this.logWindsurfStage('managedLs.spawn', { key, port, binary });
      const proc = childProcess.spawn(binary, args, { stdio: 'ignore', env: process.env, detached: false });
      proc.unref?.();
      proc.on('exit', (code, signal) => {
        this.logWindsurfStage('managedLs.exit', { key, port, code, signal });
        const current = WINDSURF_MANAGED_LS_POOL.get(key);
        if (current?.process === proc) {
          WINDSURF_MANAGED_LS_POOL.delete(key);
          this.closeLocalGrpcSessionForPort(port);
        }
      });
      proc.on('error', (error) => {
        this.logWindsurfStage('managedLs.error', { key, port, error: error.message });
      });
      const runtime: WindsurfManagedLocalGrpcRuntime = {
        port, csrfToken, process: proc, ready: false, sessionId: null, workspaceInit: null,
      };
      WINDSURF_MANAGED_LS_POOL.set(key, runtime);
      await this.waitManagedLsPortReady(port);
      runtime.ready = true;
      return runtime;
    })().finally(() => {
      WINDSURF_MANAGED_LS_PENDING.delete(key);
    });
    WINDSURF_MANAGED_LS_PENDING.set(key, promise);
    return promise;
  }

  private async resolveManagedRuntimeOptions(): Promise<WindsurfProviderRuntimeOptions> {
    const managed = await this.ensureManagedLocalGrpcRuntime();
    return {
      ...this.windsurfRuntime,
      lsPort: managed.port,
      csrfToken: managed.csrfToken,
      sessionId: managed.sessionId || this.windsurfRuntime.sessionId,
    };
  }

  private resolveManagedWorkspacePath(apiKey: string): string {
    const configured = typeof this.windsurfRuntime.workspacePath === 'string' ? this.windsurfRuntime.workspacePath.trim() : '';
    if (configured) return configured;
    const wsId = createHash('sha256').update(apiKey || '').digest('hex').slice(0, 16);
    return path.join(os.tmpdir(), 'routecodex-windsurf-workspaces', `workspace-${wsId}`);
  }

  private parseWindsurfLiveLocalGrpcRuntimeLine(line: string): WindsurfLiveLocalGrpcRuntime | null {
    const match = String(line || '').trim().match(/^\s*(\d+)\s+(.+)$/);
    if (!match) return null;
    const pid = Number.parseInt(match[1] || '', 10);
    const command = match[2] || '';
    if (!(command.includes('/.windsurf/language_server_macos_arm') || command.includes('/extensions/windsurf/bin/language_server_macos_arm'))) return null;
    const portMatch = command.match(/--server_port=(\d+)/);
    const csrfMatch = command.match(/--csrf_token=([^\s]+)/);
    const codeiumDirMatch = command.match(/--codeium_dir=(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
    const lsPort = portMatch ? Number.parseInt(portMatch[1] || '', 10) : 0;
    if (!Number.isFinite(lsPort) || lsPort <= 0) return null;
    return {
      lsPort,
      csrfToken: csrfMatch?.[1],
      pid: Number.isFinite(pid) ? pid : undefined,
      command,
      codeiumDir: codeiumDirMatch?.[1] || codeiumDirMatch?.[2] || codeiumDirMatch?.[3],
      runChild: /(?:^|\s)--run_child(?:\s|$)/.test(command),
    };
  }

  private listLiveLocalGrpcRuntimes(): WindsurfLiveLocalGrpcRuntime[] {
    try {
      const stdout = this.execFileUtf8('ps', ['-Ao', 'pid=,command=']);
      return String(stdout || '')
        .split(/\r?\n/)
        .map((row) => this.parseWindsurfLiveLocalGrpcRuntimeLine(row))
        .filter((row): row is WindsurfLiveLocalGrpcRuntime => Boolean(row));
    } catch {
      return [];
    }
  }

  private findPreferredRoutecodexWindsurfRuntime(configuredPort?: number): WindsurfLiveLocalGrpcRuntime | null {
    const runtimes = this.listLiveLocalGrpcRuntimes();
    if (runtimes.length === 0) return null;
    if (configuredPort && Number.isFinite(configuredPort) && configuredPort > 0) {
      const exact = runtimes.find((row) => row.lsPort === configuredPort);
      if (exact) return exact;
    }
    const routecodexScoped = runtimes
      .filter((row) => /routecodex-windsurf-/i.test(String(row.command || '')))
      .sort((a, b) => Number(b.pid || 0) - Number(a.pid || 0));
    if (routecodexScoped.length > 0) return routecodexScoped[0] || null;
    return null;
  }

  private resolveManagedLsCodeiumDir(key: string): string {
    const safeKey = String(key || 'windsurf-default-runtime').replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(os.homedir(), '.rcc', 'windsurf-ls', safeKey);
  }

  private isSameFilesystemPath(left?: string, right?: string): boolean {
    if (!left || !right) return false;
    return path.resolve(left) === path.resolve(right);
  }

  private listManagedLocalGrpcRuntimesForKey(key: string): WindsurfLiveLocalGrpcRuntime[] {
    const expectedDir = this.resolveManagedLsCodeiumDir(key);
    return this.listLiveLocalGrpcRuntimes()
      .filter((runtime) => this.isSameFilesystemPath(runtime.codeiumDir, expectedDir));
  }

  private findPreferredManagedWindsurfRuntimeForKey(key: string): WindsurfLiveLocalGrpcRuntime | null {
    const runtimes = this.listManagedLocalGrpcRuntimesForKey(key)
      .sort((a, b) => {
        if (a.runChild !== b.runChild) return a.runChild ? 1 : -1;
        return Number(b.pid || 0) - Number(a.pid || 0);
      });
    return runtimes[0] || null;
  }

  private terminateStaleManagedLocalGrpcRuntimes(key: string, keepPort?: number): void {
    for (const runtime of this.listManagedLocalGrpcRuntimesForKey(key)) {
      const pid = runtime.pid;
      if (!pid || (keepPort && runtime.lsPort === keepPort)) continue;
      try {
        process.kill(pid, 'SIGTERM');
        this.logWindsurfStage('managedLs.staleTerm', { key, pid, keepPort });
      } catch (error) {
        this.logWindsurfStage('managedLs.staleTermFailed', {
          key,
          pid,
          keepPort,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private buildRoutecodexWindsurfRuntimeCandidates(): WindsurfProviderRuntimeOptions[] {
    const configured = this.windsurfRuntime || {};
    const runtimes = this.listLiveLocalGrpcRuntimes();
    if (runtimes.length === 0) return [configured];
    const byPort = new Map<number, WindsurfLiveLocalGrpcRuntime[]>();
    for (const runtime of runtimes) {
      if (!runtime?.lsPort) continue;
      const rows = byPort.get(runtime.lsPort) || [];
      rows.push(runtime);
      byPort.set(runtime.lsPort, rows);
    }
    const candidates: WindsurfProviderRuntimeOptions[] = [];
    for (const [port, rows] of byPort.entries()) {
      const preferred = rows
        .slice()
        .sort((a, b) => {
          const aRunChild = /(?:^|\s)--run_child(?:\s|$)/.test(String(a.command || '')) ? 1 : 0;
          const bRunChild = /(?:^|\s)--run_child(?:\s|$)/.test(String(b.command || '')) ? 1 : 0;
          if (bRunChild !== aRunChild) return bRunChild - aRunChild;
          return Number(b.pid || 0) - Number(a.pid || 0);
        })[0];
      if (!preferred) continue;
      candidates.push({
        ...configured,
        lsPort: port,
        csrfToken: preferred.csrfToken || configured.csrfToken,
      });
    }
    candidates.sort((a, b) => Number((b.lsPort || 0)) - Number((a.lsPort || 0)));
    if (configured.lsPort && !candidates.some((row) => row.lsPort === configured.lsPort)) {
      candidates.push(configured);
    }
    return candidates.length > 0 ? candidates : [configured];
  }

  private rememberWindsurfCascadeSessionBinding(
    sessionKey: string,
    binding: Omit<WindsurfCascadeSessionBinding, 'active' | 'lastUsedAtMs'> & Partial<Pick<WindsurfCascadeSessionBinding, 'active' | 'lastUsedAtMs'>>,
  ): void {
    const key = this.normalizeWindsurfSessionKey(sessionKey);
    const stepOffset = Number.isFinite(Number(binding.stepOffset)) && Number(binding.stepOffset) >= 0
      ? Math.floor(Number(binding.stepOffset))
      : 0;
    this.windsurfCascadeSessionBindings.set(key, { ...binding, stepOffset, active: binding.active ?? true, lastUsedAtMs: binding.lastUsedAtMs ?? Date.now() });
  }

  private async selectUsablePinnedGrpcRuntime(apiKey: string): Promise<{ sessionId: string; cascadeId: string; stepOffset: number }> {
    const scope = WindsurfChatProvider.cascadeRuntimeScope.getStore();
    const sessionKey = this.normalizeWindsurfSessionKey(scope?.sessionKey || 'provider-default-session');
    this.cleanupReleasedWindsurfSessions();
    const existing = this.windsurfCascadeSessionBindings.get(sessionKey);
    if (existing?.cascadeId && existing.sessionId) {
      if (existing.active === false) {
        this.windsurfCascadeSessionBindings.delete(sessionKey);
      } else {
      this.setPinnedGrpcRuntime(existing.runtime);
      this.windsurfCascadeSessionBindings.set(sessionKey, { ...existing, active: true, lastUsedAtMs: Date.now() });
      return {
        sessionId: existing.sessionId,
        cascadeId: existing.cascadeId,
        stepOffset: existing.stepOffset,
      };
      }
    }
    const managed = await this.resolveManagedRuntimeOptions();
    const candidates = [managed];
    let lastError: unknown = null;
    for (const candidate of candidates) {
      this.setPinnedGrpcRuntime(candidate);
      this.windsurfCascadeWarmupPromise = null;
      this.windsurfCascadeSessionIdOverride = null;
      this.closeLocalGrpcSession();
      try {
        const sessionId = this.resolveWindsurfCascadeSessionId(true);
        const cascadeId = await this.sendStartCascade({ apiKey, sessionId });
        const binding = { runtime: candidate, sessionId, cascadeId, stepOffset: 0, active: true, lastUsedAtMs: Date.now() };
        this.rememberWindsurfCascadeSessionBinding(sessionKey, binding);
        return binding;
      } catch (error) {
        lastError = error;
        this.logWindsurfStage('cascade.runtime.probe.failed', {
          lsPort: candidate.lsPort || null,
          error: error instanceof Error ? error.message : String(error),
        });
        this.clearPinnedGrpcRuntime();
        this.windsurfCascadeWarmupPromise = null;
        this.windsurfCascadeSessionIdOverride = null;
      }
    }
    throw this.classifyWindsurfCascadeError(lastError);
  }

  private resolveLiveLocalGrpcRuntime(): WindsurfProviderRuntimeOptions {
    const pinnedRuntime = this.getPinnedGrpcRuntime();
    if (pinnedRuntime) {
      return pinnedRuntime;
    }
    const configured = this.windsurfRuntime || {};
    const configuredPort = configured.lsPort;
    const live = this.findPreferredRoutecodexWindsurfRuntime(configuredPort);
    if (!live) {
      return configured;
    }
    return {
      ...configured,
      lsPort: live.lsPort || configured.lsPort,
      csrfToken: live.csrfToken || configured.csrfToken,
    };
  }

  private async grpcUnaryLocal(pathName: string, payload: Buffer, timeout = this.windsurfCascadeTimeoutMs): Promise<Buffer> {
    const runtime = this.getPinnedGrpcRuntime() || this.resolveLiveLocalGrpcRuntime();
    const csrfToken = typeof runtime.csrfToken === 'string' ? runtime.csrfToken.trim() : '';
    if (!csrfToken) {
      throw createWindsurfProviderError('[windsurf] runtime csrfToken missing for local cascade transport', {
        code: 'WINDSURF_REQUEST_BUILD_FAILED',
        status: 501,
        retryable: false,
      });
    }
    return await new Promise<Buffer>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout;
      const done = (fn: (value: any) => void, value: any) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        fn(value);
      };
      const session = this.getLocalGrpcSession();
      const chunks: Buffer[] = [];
      let grpcStatus = '0';
      let grpcMessage = '';
      this.logWindsurfStage('grpc.request', {
        pathName,
        lsPort: runtime.lsPort || null,
        payloadBytes: payload.length,
        payloadPrefixHex: payload.subarray(0, 48).toString('hex'),
      });
      if (this.shouldLogWindsurfGrpc(pathName)) {
        console.log(`[windsurf.grpc.start] ${JSON.stringify({ at: new Date().toISOString(), pathName, timeout, payloadBytes: payload.length })}`);
      }
      const req = session.request({
        ':method': 'POST',
        ':path': pathName,
        'content-type': 'application/grpc',
        te: 'trailers',
        'grpc-accept-encoding': 'identity,gzip,deflate',
        'user-agent': 'grpc-node/1.108.2',
        'x-codeium-csrf-token': csrfToken,
      });
      timer = setTimeout(() => {
        try { req.close(http2.constants.NGHTTP2_CANCEL); } catch {}
        this.closeLocalGrpcSession();
        done(reject, createWindsurfProviderError(`windsurf local grpc timeout: ${pathName}`, {
          code: 'WINDSURF_FETCH_TIMEOUT',
          status: 504,
          retryable: true,
        }));
      }, timeout);
      req.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      req.on('trailers', (trailers) => {
        grpcStatus = String(trailers['grpc-status'] ?? '0');
        grpcMessage = String(trailers['grpc-message'] ?? '');
      });
      req.on('end', () => {
        this.logWindsurfStage('grpc.end', { pathName, grpcStatus, grpcMessage, bytes: chunks.reduce((sum, chunk) => sum + chunk.length, 0) });
        if (this.shouldLogWindsurfGrpc(pathName, grpcStatus)) {
          console.log(`[windsurf.grpc.end] ${JSON.stringify({ at: new Date().toISOString(), pathName, grpcStatus, grpcMessage: grpcMessage ? decodeURIComponent(grpcMessage) : '', bytes: chunks.reduce((sum, chunk) => sum + chunk.length, 0) })}`);
        }
        if (grpcStatus !== '0') {
          const message = grpcMessage ? decodeURIComponent(grpcMessage) : `gRPC status ${grpcStatus}`;
          console.warn(`[windsurf.grpc.end] ${JSON.stringify({ at: new Date().toISOString(), pathName, grpcStatus, grpcMessage: message, bytes: chunks.reduce((sum, chunk) => sum + chunk.length, 0) })}`);
          done(reject, createWindsurfProviderError(message, {
            ...classifyWindsurfUpstreamPayloadError({ code: grpcStatus, message }),
          }));
          return;
        }
        const full = Buffer.concat(chunks);
        const frames = this.extractGrpcFrames(full);
        done(resolve, frames.length > 0 ? Buffer.concat(frames) : this.stripGrpcFrame(full));
      });
      req.on('error', (error) => {
        this.logWindsurfStage('grpc.error', { pathName, error: error instanceof Error ? error.message : String(error) });
        this.closeLocalGrpcSession();
        done(reject, createWindsurfProviderError(String(error instanceof Error ? error.message : error), {
          code: 'WINDSURF_UPSTREAM_TRANSIENT',
          status: 502,
          retryable: true,
        }));
      });
      req.write(this.grpcFrame(payload));
      req.end();
    });
  }

  private parseTrajectorySteps(bytes: Uint8Array): Array<Record<string, unknown>> {
    const fields = this.parseProtoFields(bytes);
    const steps = this.getAllProtoFields(fields, 1, 2);
    const out: Array<Record<string, unknown>> = [];

    const parseChatToolCall = (buf: Uint8Array): Record<string, unknown> => {
      const callFields = this.parseProtoFields(buf);
      return {
        id: this.readProtoString(callFields, 1),
        name: this.readProtoString(callFields, 2),
        argumentsJson: this.readProtoString(callFields, 3),
      };
    };

    const readErrorDetails = (buf: Uint8Array): string => {
      const details = this.parseProtoFields(buf);
      for (const fieldNo of [1, 2, 3]) {
        const field = this.getProtoField(details, fieldNo, 2);
        if (!field || !(field.value instanceof Uint8Array)) continue;
        const text = Buffer.from(field.value).toString('utf8').trim();
        if (text) return text.split('\n')[0]!.slice(0, 300);
      }
      return '';
    };

    for (const step of steps) {
      const sf = this.parseProtoFields(step.value as Uint8Array);
      const type = this.readProtoNumber(sf, 1) ?? 0;
      const status = this.readProtoNumber(sf, 4) ?? 0;
      const plannerField = this.getProtoField(sf, 20, 2);
      const row: Record<string, unknown> = {
        type,
        status,
        text: '',
        thinking: '',
        errorText: '',
        toolCalls: [],
        usage: null,
      };

      const stepMetaField = this.getProtoField(sf, 5, 2);
      if (stepMetaField) {
        const meta = this.parseProtoFields(stepMetaField.value as Uint8Array);
        const usageField = this.getProtoField(meta, 9, 2);
        if (usageField) {
          row.usage = this.parseWindsurfModelUsageStats(usageField.value as Uint8Array);
        }
      }

      const customField = this.getProtoField(sf, 45, 2);
      if (customField) {
        const cf = this.parseProtoFields(customField.value as Uint8Array);
        (row.toolCalls as Array<Record<string, unknown>>).push({
          id: this.readProtoString(cf, 1),
          name: this.readProtoString(cf, 4) || this.readProtoString(cf, 1) || 'custom_tool',
          argumentsJson: this.readProtoString(cf, 2),
          result: this.readProtoString(cf, 3),
        });
      }

      const mcpField = this.getProtoField(sf, 47, 2);
      if (mcpField) {
        const mf = this.parseProtoFields(mcpField.value as Uint8Array);
        const callField = this.getProtoField(mf, 2, 2);
        if (callField) {
          const toolCall = parseChatToolCall(callField.value as Uint8Array);
          toolCall.serverName = this.readProtoString(mf, 1);
          toolCall.result = this.readProtoString(mf, 3);
          (row.toolCalls as Array<Record<string, unknown>>).push(toolCall);
        }
      }

      const proposalField = this.getProtoField(sf, 49, 2);
      if (proposalField) {
        const pf = this.parseProtoFields(proposalField.value as Uint8Array);
        const callField = this.getProtoField(pf, 1, 2);
        if (callField) {
          (row.toolCalls as Array<Record<string, unknown>>).push(parseChatToolCall(callField.value as Uint8Array));
        }
      }

      const choiceField = this.getProtoField(sf, 50, 2);
      if (choiceField) {
        const cf = this.parseProtoFields(choiceField.value as Uint8Array);
        const calls = this.getAllProtoFields(cf, 1, 2).map((field) => parseChatToolCall(field.value as Uint8Array));
        if (calls.length > 0) {
          const chosenIndex = this.readProtoNumber(cf, 2) ?? 0;
          (row.toolCalls as Array<Record<string, unknown>>).push(calls[chosenIndex] || calls[0]!);
        }
      }

      const nativeStepFields: Array<[number, WindsurfCascadeToolStepKind]> = [
        [14, 'view_file'],
        [15, 'list_directory'],
        [23, 'write_to_file'],
        [28, 'run_command'],
        [13, 'grep_search'],
        [34, 'find'],
        [105, 'grep_search_v2'],
        [40, 'read_url_content'],
        [42, 'search_web'],
      ];
      for (const [fieldNo, kind] of nativeStepFields) {
        const nativeField = this.getProtoField(sf, fieldNo, 2);
        if (!nativeField) continue;
        const body = this.parseProtoFields(nativeField.value as Uint8Array);
        let argumentsJson = '';
        let result = '';
        try {
          if (kind === 'view_file') {
            argumentsJson = stableStringify({
              absolute_path_uri: this.readProtoString(body, 1),
              offset: this.readProtoNumber(body, 11) ?? 0,
              limit: this.readProtoNumber(body, 12) ?? 0,
              start_line: this.readProtoNumber(body, 2) ?? 0,
              end_line: this.readProtoNumber(body, 3) ?? 0,
            });
            result = this.readProtoString(body, 4);
          } else if (kind === 'run_command') {
            argumentsJson = stableStringify({
              command_line: this.readProtoString(body, 23) || this.readProtoString(body, 1),
              cwd: this.readProtoString(body, 2),
            });
            const combined = this.getProtoField(body, 21, 2);
            if (combined) {
              result = this.readProtoString(this.parseProtoFields(combined.value as Uint8Array), 1);
            }
            if (!result) {
              const stdout = this.readProtoString(body, 4);
              const stderr = this.readProtoString(body, 5);
              result = stdout + (stderr ? `
[stderr]
${stderr}` : '');
            }
          } else if (kind === 'grep_search_v2') {
            argumentsJson = stableStringify({
              pattern: this.readProtoString(body, 2),
              path: this.readProtoString(body, 3),
              glob: this.readProtoString(body, 4),
              output_mode: this.readProtoString(body, 5),
              head_limit: this.readProtoNumber(body, 12) ?? 0,
            });
            result = this.readProtoString(body, 15);
          } else if (kind === 'grep_search') {
            argumentsJson = stableStringify({
              query: this.readProtoString(body, 1),
              search_path_uri: this.readProtoString(body, 11),
            });
            result = this.readProtoString(body, 3);
          } else if (kind === 'find') {
            argumentsJson = stableStringify({
              pattern: this.readProtoString(body, 1),
              search_directory: this.readProtoString(body, 10),
            });
            result = this.readProtoString(body, 11);
          } else if (kind === 'list_directory') {
            argumentsJson = stableStringify({ directory_path_uri: this.readProtoString(body, 1) });
            result = this.getAllProtoFields(body, 2, 2)
              .map((field) => Buffer.from(field.value as Uint8Array).toString('utf8'))
              .join('\n');
          } else if (kind === 'write_to_file') {
            argumentsJson = stableStringify({
              target_file_uri: this.readProtoString(body, 1),
              code_content: this.getAllProtoFields(body, 2, 2).map((field) => Buffer.from(field.value as Uint8Array).toString('utf8')),
            });
          } else if (kind === 'search_web') {
            argumentsJson = stableStringify({ query: this.readProtoString(body, 1) });
            result = this.readProtoString(body, 5);
          } else if (kind === 'read_url_content') {
            argumentsJson = stableStringify({ url: this.readProtoString(body, 1) });
            result = this.readProtoString(body, 5);
          }
        } catch {
          argumentsJson = argumentsJson || '{}';
        }
        (row.toolCalls as Array<Record<string, unknown>>).push({
          id: `native:${kind}:${out.length}`,
          name: kind,
          argumentsJson,
          result,
          cascade_native: true,
        });
      }

      if (plannerField) {
        const pf = this.parseProtoFields(plannerField.value as Uint8Array);
        const responseText = this.readProtoString(pf, 1);
        const modifiedText = this.readProtoString(pf, 8);
        row.text = modifiedText || responseText;
        row.responseText = responseText;
        row.modifiedText = modifiedText;
        row.thinking = this.readProtoString(pf, 3);
      }

      const errMsgField = this.getProtoField(sf, 24, 2);
      if (errMsgField) {
        const errInner = this.getProtoField(this.parseProtoFields(errMsgField.value as Uint8Array), 3, 2);
        if (errInner) {
          row.errorText = readErrorDetails(errInner.value as Uint8Array);
        }
      }
      if (!row.errorText) {
        const errField = this.getProtoField(sf, 31, 2);
        if (errField) {
          row.errorText = readErrorDetails(errField.value as Uint8Array);
        }
      }

      out.push(row);
    }
    return out;
  }

  private parseJsonObject(raw: string, emptyMessage: string): Record<string, unknown> {
    const text = String(raw || '').trim();
    if (!text) {
      throw createWindsurfProviderError(emptyMessage, {
        code: 'WINDSURF_RESPONSE_PARSE_FAILED',
        status: 502,
        retryable: false,
      });
    }
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('invalid');
      }
      return parsed as Record<string, unknown>;
    } catch {
      throw createWindsurfProviderError('[windsurf] cascade poll response is not valid json object', {
        code: 'WINDSURF_RESPONSE_PARSE_FAILED',
        status: 502,
        retryable: false,
      });
    }
  }

  private buildGetChatCompletionsRequest(args: {
    apiKey: string;
    semanticConversation: WindsurfSemanticTurn[];
    model: string;
    tools?: Array<Record<string, unknown>>;
    toolChoice?: unknown;
  }): Record<string, unknown> {
    const prompts = this.buildChatMessagePromptsFromSemanticConversation(args.semanticConversation);
    const resolvedModel = resolveWindsurfChatCompletionsModel(args.model);
    const request: Record<string, unknown> = {
      metadata: buildWindsurfCascadeModelConfigsMetadata(args.apiKey),
      chatMessagePrompts: prompts,
      completionsRequest: {
        model: resolvedModel.enumValue,
        modelTag: resolvedModel.modelTag,
        configuration: {
          numCompletions: 1,
          maxTokens: 32768,
          temperature: 0,
        },
      },
    };
    return request;
  }

  private buildChatMessagePromptsFromSemanticConversation(semanticConversation: WindsurfSemanticTurn[]): Array<Record<string, unknown>> {
    const turns = Array.isArray(semanticConversation) ? semanticConversation : [];
    return turns.map((turn, index) => {
      if (turn.type === 'user') {
        return {
          messageId: `user-${index}`,
          source: WINDSURF_SOURCE_USER,
          prompt: turn.text,
        };
      }
      if (turn.type === 'assistant') {
        return {
          messageId: `assistant-${index}`,
          source: WINDSURF_SOURCE_ASSISTANT,
          prompt: turn.text,
          ...(Array.isArray(turn.tool_calls) && turn.tool_calls.length > 0
            ? {
                toolCalls: turn.tool_calls.map((toolCall) => ({
                  id: toolCall.call_id,
                  name: toolCall.name,
                  argumentsJson: stableStringify(toolCall.arguments),
                })),
              }
            : {}),
        };
      }
      return {
        messageId: `tool-${index}`,
        source: WINDSURF_SOURCE_TOOL,
        prompt: turn.output,
        toolCallId: turn.call_id,
        toolResultIsError: false,
      };
    });
  }

  private parseGetChatMessageResponse(raw: string | Uint8Array, meta?: WindsurfResponseMeta): {
    candidate: Record<string, unknown>;
    usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } | null;
  } {
    const bytes = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : Buffer.from(raw);
    const maybeJsonText = bytes.toString('utf8').trim();
    if ((maybeJsonText.startsWith('{') || maybeJsonText.startsWith('[')) && maybeJsonText.length > 0) {
      try {
        const payload = JSON.parse(maybeJsonText);
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
          const record = payload as Record<string, unknown>;
          if (record.error && typeof record.error === 'object') {
            const payloadError = record.error as Record<string, unknown>;
            throw createWindsurfProviderError(String(payloadError.message || 'windsurf upstream error'), {
              ...classifyWindsurfUpstreamPayloadError(payloadError),
            });
          }
          if (typeof record.code === 'string' || typeof record.message === 'string') {
            throw createWindsurfProviderError(String(record.message || 'windsurf upstream error'), {
              ...classifyWindsurfUpstreamPayloadError(record),
            });
          }
          const completionResponse = record.completionResponse && typeof record.completionResponse === 'object'
            ? record.completionResponse as Record<string, unknown>
            : record.completion_response && typeof record.completion_response === 'object'
              ? record.completion_response as Record<string, unknown>
              : null;
          if (Array.isArray(completionResponse?.completions)) {
            const completions = completionResponse.completions as unknown[];
            if (completions.length === 0) {
              throw createWindsurfProviderError('[windsurf] empty cascade candidate payload', {
                code: 'WINDSURF_RESPONSE_PARSE_FAILED',
                status: 502,
                retryable: false,
              });
            }
            const first = completions[0] && typeof completions[0] === 'object'
              ? completions[0] as Record<string, unknown>
              : null;
            if (!first) {
              throw createWindsurfProviderError('[windsurf] empty cascade candidate payload', {
                code: 'WINDSURF_RESPONSE_PARSE_FAILED',
                status: 502,
                retryable: false,
              });
            }
            const topLevelUsage = record.usage && typeof record.usage === 'object'
              ? record.usage as Record<string, unknown>
              : record.modelUsage && typeof record.modelUsage === 'object'
                ? record.modelUsage as Record<string, unknown>
                : record.model_usage && typeof record.model_usage === 'object'
                  ? record.model_usage as Record<string, unknown>
                  : null;
            const toolCalls = Array.isArray(first.toolCalls)
              ? first.toolCalls as Array<Record<string, unknown>>
              : Array.isArray(first.tool_calls)
                ? first.tool_calls as Array<Record<string, unknown>>
                : [];
            const candidate: Record<string, unknown> = {
              role: 'assistant',
              content: typeof first.text === 'string'
                ? first.text
                : typeof first.deltaText === 'string'
                  ? first.deltaText
                  : typeof first.delta_text === 'string'
                    ? String(first.delta_text)
                    : '',
            };
            const reasoningContent = typeof first.thinking === 'string'
              ? first.thinking
              : typeof first.reasoning_content === 'string'
                ? first.reasoning_content
                : typeof first.deltaThinking === 'string'
                  ? first.deltaThinking
                  : typeof first.delta_thinking === 'string'
                    ? String(first.delta_thinking)
                    : '';
            if (reasoningContent) {
              candidate.reasoning_content = reasoningContent;
            }
            if (toolCalls.length > 0) {
              candidate.tool_calls = toolCalls.map((row, index) => {
                const id = typeof row.id === 'string' ? row.id : `call_${index}`;
                const name = typeof row.name === 'string' ? row.name : '';
                const argumentsJson = typeof row.argumentsJson === 'string'
                  ? row.argumentsJson
                  : typeof row.arguments_json === 'string'
                    ? String(row.arguments_json)
                    : typeof row.input === 'string'
                      ? JSON.stringify({ input: row.input })
                      : row.input && typeof row.input === 'object'
                        ? stableStringify(row.input)
                        : '{}';
                return {
                  id,
                  type: 'function',
                  function: {
                    name,
                    arguments: argumentsJson,
                  },
                };
              });
            }
            const usage = topLevelUsage
              ? {
                  inputTokens: typeof topLevelUsage.inputTokens === 'number' ? topLevelUsage.inputTokens : typeof topLevelUsage.input_tokens === 'number' ? Number(topLevelUsage.input_tokens) : undefined,
                  outputTokens: typeof topLevelUsage.outputTokens === 'number' ? topLevelUsage.outputTokens : typeof topLevelUsage.output_tokens === 'number' ? Number(topLevelUsage.output_tokens) : undefined,
                  cacheReadTokens: typeof topLevelUsage.cacheReadTokens === 'number' ? topLevelUsage.cacheReadTokens : typeof topLevelUsage.cache_read_tokens === 'number' ? Number(topLevelUsage.cache_read_tokens) : undefined,
                  cacheWriteTokens: typeof topLevelUsage.cacheWriteTokens === 'number' ? topLevelUsage.cacheWriteTokens : typeof topLevelUsage.cache_write_tokens === 'number' ? Number(topLevelUsage.cache_write_tokens) : undefined,
                }
              : null;
            if (!candidate.content && !candidate.reasoning_content && !candidate.tool_calls) {
              throw createWindsurfProviderError('[windsurf] empty cascade candidate payload', {
                code: 'WINDSURF_RESPONSE_PARSE_FAILED',
                status: 502,
                retryable: false,
              });
            }
            return {
              candidate,
              usage,
            };
          }
        }
      } catch (error) {
        if (error instanceof Error && (error as unknown as Record<string, unknown>).code) {
          throw error;
        }
      }
    }
    let offset = 0;
    let textPart = '';
    let reasoningPart = '';
    const toolCallRows: Array<Record<string, unknown>> = [];
    let usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } | null = null;
    while (offset + 5 <= bytes.length) {
      const flags = bytes[offset] ?? 0;
      const length = bytes.readUInt32BE(offset + 1);
      offset += 5;
      if (offset + length > bytes.length) {
        throw createWindsurfProviderError(this.buildWindsurfConnectFrameErrorMessage(
          '[windsurf] truncated connect frame from GetChatMessage',
          {
            ...meta,
            totalBytes: bytes.length,
            frameOffset: offset - 5,
            declaredLength: length,
            remainingBytes: bytes.length - offset,
            flags,
            prefixHex: bytes.subarray(0, Math.min(bytes.length, 64)).toString('hex'),
          },
        ), {
          code: 'WINDSURF_RESPONSE_PARSE_FAILED',
          status: 502,
          retryable: false,
        });
      }
      const payloadBytes = bytes.subarray(offset, offset + length);
      offset += length;
      const payloadText = payloadBytes.toString('utf8').trim();
      if (!payloadText) continue;
      let payload: Record<string, unknown>;
      try {
        const value = JSON.parse(payloadText);
        if (!value || typeof value !== 'object') throw new Error('invalid');
        payload = value as Record<string, unknown>;
      } catch {
        const protoParsed = this.tryParseWindsurfCompletionDeltaProto(payloadBytes);
        if (!protoParsed) {
          throw createWindsurfProviderError(this.buildWindsurfConnectFrameErrorMessage(
            '[windsurf] invalid GetChatMessage connect json payload',
            {
              ...meta,
              totalBytes: bytes.length,
              frameOffset: offset - length - 5,
              declaredLength: length,
              remainingBytes: bytes.length - offset,
              flags,
              prefixHex: bytes.subarray(0, Math.min(bytes.length, 64)).toString('hex'),
            },
          ), {
            code: 'WINDSURF_RESPONSE_PARSE_FAILED',
            status: 502,
            retryable: false,
          });
        }
        payload = protoParsed;
      }
      const payloadError = payload.error && typeof payload.error === 'object'
        ? payload.error as Record<string, unknown>
        : null;
      if (payloadError) {
        throw createWindsurfProviderError(String(payloadError.message || 'windsurf upstream error'), {
          ...classifyWindsurfUpstreamPayloadError(payloadError),
        });
      }
      if (typeof payload.deltaText === 'string') {
        textPart += payload.deltaText;
      } else if (typeof payload.delta_text === 'string') {
        textPart += String(payload.delta_text);
      }
      if (typeof payload.deltaThinking === 'string') {
        reasoningPart += payload.deltaThinking;
      } else if (typeof payload.delta_thinking === 'string') {
        reasoningPart += String(payload.delta_thinking);
      }
      const deltaToolCalls = Array.isArray(payload.deltaToolCalls)
        ? payload.deltaToolCalls as Array<Record<string, unknown>>
        : Array.isArray(payload.delta_tool_calls)
          ? payload.delta_tool_calls as Array<Record<string, unknown>>
          : [];
      for (const row of deltaToolCalls) {
        toolCallRows.push(row);
      }
      const modelUsage = payload.usage && typeof payload.usage === 'object'
        ? payload.usage as Record<string, unknown>
        : payload.modelUsage && typeof payload.modelUsage === 'object'
          ? payload.modelUsage as Record<string, unknown>
          : payload.model_usage && typeof payload.model_usage === 'object'
            ? payload.model_usage as Record<string, unknown>
            : null;
      if (modelUsage) {
        usage = {
          inputTokens: typeof modelUsage.inputTokens === 'number' ? modelUsage.inputTokens : typeof modelUsage.input_tokens === 'number' ? Number(modelUsage.input_tokens) : undefined,
          outputTokens: typeof modelUsage.outputTokens === 'number' ? modelUsage.outputTokens : typeof modelUsage.output_tokens === 'number' ? Number(modelUsage.output_tokens) : undefined,
          cacheReadTokens: typeof modelUsage.cacheReadTokens === 'number' ? modelUsage.cacheReadTokens : typeof modelUsage.cache_read_tokens === 'number' ? Number(modelUsage.cache_read_tokens) : undefined,
          cacheWriteTokens: typeof modelUsage.cacheWriteTokens === 'number' ? modelUsage.cacheWriteTokens : typeof modelUsage.cache_write_tokens === 'number' ? Number(modelUsage.cache_write_tokens) : undefined,
        };
      }
      if ((flags & 0x02) !== 0) {
        break;
      }
    }
    if (!textPart && !reasoningPart && toolCallRows.length === 0) {
      throw createWindsurfProviderError('[windsurf] empty cascade candidate payload', {
        code: 'WINDSURF_RESPONSE_PARSE_FAILED',
        status: 502,
        retryable: false,
      });
    }
    const candidate: Record<string, unknown> = {
      role: 'assistant',
      content: textPart,
    };
    if (reasoningPart) {
      candidate.reasoning_content = reasoningPart;
    }
    if (toolCallRows.length > 0) {
      candidate.tool_calls = toolCallRows.map((row, index) => {
        const id = typeof row.id === 'string' ? row.id : `call_${index}`;
        const name = typeof row.name === 'string' ? row.name : '';
        const argumentsJson = typeof row.argumentsJson === 'string'
          ? row.argumentsJson
          : typeof row.arguments_json === 'string'
            ? String(row.arguments_json)
            : typeof row.input === 'string'
              ? JSON.stringify({ input: row.input })
              : row.input && typeof row.input === 'object'
                ? stableStringify(row.input)
                : '{}';
        return {
          id,
          type: 'function',
          function: {
            name,
            arguments: argumentsJson,
          },
        };
      });
    }
    return {
      candidate,
      usage,
    };
  }

  private getWindsurfPollMaxWaitMs(): number {
    return typeof this.windsurfRuntime.pollMaxWaitMs === 'number' && this.windsurfRuntime.pollMaxWaitMs > 0
      ? this.windsurfRuntime.pollMaxWaitMs
      : 600_000;
  }


  private async readFetchResponseText(response: {
    text?: (() => Promise<string>) | undefined;
    arrayBuffer?: (() => Promise<ArrayBuffer>) | undefined;
  }): Promise<string> {
    if (typeof response.text === 'function') {
      return await response.text();
    }
    if (typeof response.arrayBuffer === 'function') {
      return Buffer.from(await response.arrayBuffer()).toString('utf8');
    }
    throw createWindsurfProviderError('[windsurf] upstream response body reader missing', {
      code: 'WINDSURF_RESPONSE_PARSE_FAILED',
      status: 502,
      retryable: false,
    });
  }

  private async readFetchResponseBuffer(response: {
    arrayBuffer?: (() => Promise<ArrayBuffer>) | undefined;
    text?: (() => Promise<string>) | undefined;
  }): Promise<Buffer> {
    if (typeof response.arrayBuffer === 'function') {
      return Buffer.from(await response.arrayBuffer());
    }
    if (typeof response.text === 'function') {
      return Buffer.from(await response.text(), 'utf8');
    }
    throw createWindsurfProviderError('[windsurf] upstream response body reader missing', {
      code: 'WINDSURF_RESPONSE_PARSE_FAILED',
      status: 502,
      retryable: false,
    });
  }

  private readWindsurfResponseMeta(response: unknown, body: Buffer): WindsurfResponseMeta {
    const headers = (response && typeof response === 'object' && 'headers' in (response as Record<string, unknown>))
      ? (response as { headers?: unknown }).headers
      : null;
    const getHeader = (name: string): string | undefined => {
      if (!headers) return undefined;
      const normalized = name.toLowerCase();
      const source = headers as {
        get?: (name: string) => string | null;
        [key: string]: unknown;
      };
      if (typeof source.get === 'function') {
        const value = source.get(normalized) ?? source.get(name);
        return typeof value === 'string' && value.trim() ? value.trim() : undefined;
      }
      const record = source as Record<string, unknown>;
      for (const [key, value] of Object.entries(record)) {
        if (key.toLowerCase() === normalized && typeof value === 'string' && value.trim()) {
          return value.trim();
        }
      }
      return undefined;
    };
    return {
      contentType: getHeader('content-type'),
      contentEncoding: getHeader('content-encoding') ?? getHeader('connect-content-encoding'),
      totalBytes: body.length,
      prefixHex: body.subarray(0, Math.min(body.length, 64)).toString('hex'),
    };
  }

  private maybeDecodeHttpContentEncoding(body: Buffer, encoding?: string): Buffer {
    const normalized = typeof encoding === 'string' ? encoding.trim().toLowerCase() : '';
    if (!normalized || normalized === 'identity') {
      return body;
    }
    if (normalized.includes('gzip')) {
      try {
        return gunzipSync(body);
      } catch (error) {
        throw createWindsurfProviderError(`[windsurf] failed to gunzip upstream response body: ${error instanceof Error ? error.message : String(error)}`, {
          code: 'WINDSURF_RESPONSE_PARSE_FAILED',
          status: 502,
          retryable: false,
        });
      }
    }
    return body;
  }

  private buildWindsurfConnectFrameErrorMessage(base: string, details: Record<string, unknown>): string {
    const compact = Object.entries(details)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(' ');
    return compact ? `${base} (${compact})` : base;
  }


  private resolveStandardToolNameFromCascadeToolName(name: string, nativeTools: Array<Record<string, unknown>> = []): { name: string; nativeKind?: WindsurfCascadeToolStepKind } {
    const normalized = windsurfToolLookupName(name);
    const mapped = WINDSURF_TOOL_MAP[normalized];
    if (!normalized || !mapped) return { name };
    const declared = collectWindsurfMappedTools(nativeTools);
    const matchingDeclared = declared.find((tool) => tool.kind === mapped.kind);
    if (!matchingDeclared?.name) return { name };
    return { name: matchingDeclared.name, nativeKind: mapped.kind };
  }

  private parseCascadeAssistantTurnSync(candidate: unknown, nativeTools: Array<Record<string, unknown>> = []): Record<string, unknown> {
    const record = candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : {};
    const rawContent = Array.isArray(record.content) ? record.content : [];
    const rawTopLevelToolCalls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolCalls: Array<Record<string, unknown>> = [];
    const seenToolCallIds = new Set<string>();

    if (typeof record.reasoning_content === 'string' && record.reasoning_content) {
      reasoningParts.push(record.reasoning_content);
    }
    if (typeof record.content === 'string' && record.content) {
      textParts.push(record.content);
    }

    for (const entry of rawTopLevelToolCalls) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const row = entry as Record<string, unknown>;
      const fn = row.function && typeof row.function === 'object' ? row.function as Record<string, unknown> : {};
      const callId = typeof row.id === 'string'
        ? row.id.trim()
        : typeof row.call_id === 'string'
          ? String(row.call_id).trim()
          : '';
      const name = typeof fn.name === 'string'
        ? fn.name.trim()
        : typeof row.name === 'string'
          ? String(row.name).trim()
          : '';
      const rawArgs = typeof fn.arguments === 'string'
        ? fn.arguments
        : fn.arguments && typeof fn.arguments === 'object' && !Array.isArray(fn.arguments)
          ? fn.arguments as Record<string, unknown>
          : typeof row.arguments === 'string'
            ? String(row.arguments)
            : row.arguments && typeof row.arguments === 'object' && !Array.isArray(row.arguments)
              ? row.arguments as Record<string, unknown>
              : typeof row.input === 'string'
                ? { input: row.input }
                : row.input && typeof row.input === 'object' && !Array.isArray(row.input)
                  ? row.input as Record<string, unknown>
                  : null;
      let args: Record<string, unknown> = {};
      try {
        if (typeof rawArgs === 'string') {
          const parsed = JSON.parse(rawArgs);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>;
          } else {
            throw new Error('[windsurf] assistant tool call arguments must be valid json object');
          }
        } else if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
          args = rawArgs as Record<string, unknown>;
        } else {
          throw new Error('[windsurf] assistant tool call arguments must be valid json object');
        }
      } catch {
        throw new Error('[windsurf] assistant tool call arguments must be valid json object');
      }
      if (!name) {
        throw new Error('[windsurf] assistant tool call missing name');
      }
      if (!callId) {
        throw new Error('[windsurf] assistant tool call missing call_id');
      }
      const resolvedToolName = this.resolveStandardToolNameFromCascadeToolName(name, nativeTools);
      const standardArgs = resolvedToolName.nativeKind ? reverseWindsurfNativeToolArguments(resolvedToolName.name, resolvedToolName.nativeKind, args) : args;
      const argsJson = stableStringify(standardArgs);
      if (seenToolCallIds.has(callId)) {
        throw new Error('[windsurf] duplicate assistant tool call id in assistant candidate');
      }
      seenToolCallIds.add(callId);
      toolCalls.push({
        id: callId,
        type: 'function',
        function: {
          name: resolvedToolName.name,
          arguments: argsJson,
        },
      });
    }

    const hasTopLevelToolCalls = toolCalls.length > 0;

    for (const item of rawContent) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const block = item as Record<string, unknown>;
      const type = typeof block.type === 'string' ? block.type.trim().toLowerCase() : '';
      if (type === 'text' || type === 'output_text') {
        const text = typeof block.text === 'string' ? block.text : '';
        if (text) {
          textParts.push(text);
        }
        continue;
      }
      if (type === 'function_call_output' || type === 'custom_tool_call_output' || type === 'tool_result') {
        throw new Error('[windsurf] assistant candidate mixed content with embedded tool result block');
      }
      if (type !== 'tool_call' && type !== 'function_call' && type !== 'custom_tool_call') {
        continue;
      }
      if (hasTopLevelToolCalls) {
        throw new Error('[windsurf] assistant response mixed top-level tool_calls with content tool call');
      }
      const callId = typeof block.call_id === 'string'
        ? block.call_id.trim()
        : typeof block.id === 'string'
          ? block.id.trim()
          : '';
      const name = typeof block.name === 'string' ? block.name.trim() : '';
      if (!name) {
        throw new Error('[windsurf] assistant tool call missing name');
      }
      if (!callId) {
        throw new Error('[windsurf] assistant tool call missing call_id');
      }
      let args: Record<string, unknown>;
      if (type === 'custom_tool_call') {
        if (typeof block.input === 'string') {
          args = { input: block.input };
        } else if (block.input && typeof block.input === 'object' && !Array.isArray(block.input)) {
          args = block.input as Record<string, unknown>;
        } else {
          args = {};
        }
      } else if (type === 'function_call' && typeof block.arguments === 'string') {
        try {
          const parsed = JSON.parse(block.arguments);
          if (!(parsed && typeof parsed === 'object' && !Array.isArray(parsed))) {
            throw new Error('[windsurf] assistant tool call arguments must be valid json object');
          }
          args = parsed as Record<string, unknown>;
        } catch {
          throw new Error('[windsurf] assistant tool call arguments must be valid json object');
        }
      } else if (block.arguments && typeof block.arguments === 'object' && !Array.isArray(block.arguments)) {
        args = block.arguments as Record<string, unknown>;
      } else {
        throw new Error('[windsurf] assistant tool call arguments must be object');
      }
      const resolvedToolName = this.resolveStandardToolNameFromCascadeToolName(name, nativeTools);
      const standardArgs = resolvedToolName.nativeKind ? reverseWindsurfNativeToolArguments(resolvedToolName.name, resolvedToolName.nativeKind, args) : args;
      const argsJson = stableStringify(standardArgs);
      if (seenToolCallIds.has(callId)) {
        throw new Error('[windsurf] duplicate assistant tool call id in assistant candidate');
      }
      seenToolCallIds.add(callId);
      toolCalls.push({
        id: callId,
        type: 'function',
        function: {
          name: resolvedToolName.name,
          arguments: argsJson,
        },
      });
    }

    let rawText = textParts.join('');
    if (/<\/?\s*(?:tool_call|function_call)\b/i.test(rawText)) {
      throw createWindsurfProviderError('[windsurf] legacy tool_call text protocol is not allowed in cascade assistant content', {
        code: 'WINDSURF_TOOL_PROTOCOL_CONFLICT',
        status: 400,
        retryable: false,
      });
    }
    if (rawText.includes('<|RCC|tool_calls>')) {
      throw createWindsurfProviderError('[windsurf] RCC text tool protocol is removed; MCP-only tool protocol required', {
        code: 'WINDSURF_TOOL_PROTOCOL_CONFLICT',
        status: 400,
        retryable: false,
      });
    }
    const text = rawText;
    const reasoning_content = reasoningParts.join('');
    if (!text && toolCalls.length === 0 && !reasoning_content) {
      throw new Error('[windsurf] empty assistant completion');
    }

    return {
      role: 'assistant',
      content: text,
      ...(reasoning_content ? { reasoning_content } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
  }

  private parseCascadeSemanticRoundtripSync(messages: unknown): WindsurfSemanticTurn[] {
    if (!Array.isArray(messages)) {
      return [];
    }
    const out: WindsurfSemanticTurn[] = [];
    const matchedCalls = new Map<string, { name: string }>();
    const completedToolCallIds = new Set<string>();
    const normalizeTextContent = (content: unknown): string => {
      if (typeof content === 'string') {
        return content;
      }
      if (!Array.isArray(content)) {
        return '';
      }
      const parts: string[] = [];
      for (const item of content) {
        if (!item || typeof item !== 'object') {
          continue;
        }
        const block = item as Record<string, unknown>;
        const type = typeof block.type === 'string' ? block.type.trim().toLowerCase() : '';
        if (type === 'input_text' || type === 'output_text' || type === 'text') {
          const text = typeof block.text === 'string' ? block.text : '';
          if (text) {
            parts.push(text);
          }
          continue;
        }
      }
      return parts.join('');
    };

    for (const item of messages) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const msg = item as Record<string, unknown>;
      const role = typeof msg.role === 'string' ? msg.role.trim().toLowerCase() : '';

      if (role === 'user') {
        const text = normalizeTextContent(msg.content);
        out.push({ type: 'user', text });
        continue;
      }

      if (role === 'assistant') {
        const toolCallsRaw = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        const contentBlocks = Array.isArray(msg.content) ? msg.content : [];
        const textParts: string[] = [];
        if (typeof msg.content === 'string') {
          textParts.push(msg.content);
        }
        const normalizedCalls: Array<{ call_id: string; name: string; arguments: Record<string, unknown> }> = [];
        const seenHistoryToolCallIds = new Set<string>();

        for (const entry of toolCallsRaw) {
          if (!entry || typeof entry !== 'object') {
            continue;
          }
          const row = entry as Record<string, unknown>;
          const fn = row.function && typeof row.function === 'object' ? row.function as Record<string, unknown> : {};
          const callId = typeof row.call_id === 'string' ? row.call_id.trim() : typeof row.id === 'string' ? String(row.id).trim() : '';
          const name = typeof fn.name === 'string' ? fn.name.trim() : typeof row.name === 'string' ? String(row.name).trim() : '';
          const rawArgs = typeof fn.arguments === 'string'
            ? fn.arguments
            : fn.arguments && typeof fn.arguments === 'object' && !Array.isArray(fn.arguments)
              ? fn.arguments as Record<string, unknown>
              : typeof row.arguments === 'string'
                ? String(row.arguments)
                : row.arguments && typeof row.arguments === 'object' && !Array.isArray(row.arguments)
                  ? row.arguments as Record<string, unknown>
                  : typeof row.input === 'string'
                    ? { input: row.input }
                    : row.input && typeof row.input === 'object' && !Array.isArray(row.input)
                      ? row.input as Record<string, unknown>
                      : null;
          let args: Record<string, unknown> = {};
          try {
            if (typeof rawArgs === 'string') {
              const parsed = JSON.parse(rawArgs);
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                args = parsed as Record<string, unknown>;
              } else {
                throw new Error('[windsurf] assistant tool call arguments must be valid json object');
              }
            } else if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
              args = rawArgs as Record<string, unknown>;
            } else {
              throw new Error('[windsurf] assistant tool call arguments must be valid json object');
            }
          } catch {
            throw new Error('[windsurf] assistant tool call arguments must be valid json object');
          }
          if (!name) {
            throw new Error('[windsurf] assistant tool call missing name');
          }
          if (!callId) {
            throw new Error('[windsurf] assistant tool call missing call_id');
          }
          if (seenHistoryToolCallIds.has(callId)) {
            throw new Error('[windsurf] duplicate assistant tool call id in history');
          }
          seenHistoryToolCallIds.add(callId);
          normalizedCalls.push({ call_id: callId, name, arguments: args });
        }

        if (contentBlocks.length > 0) {
          const hasChatToolCalls = normalizedCalls.length > 0;
          for (const blockEntry of contentBlocks) {
            if (!blockEntry || typeof blockEntry !== 'object') {
              continue;
            }
            const block = blockEntry as Record<string, unknown>;
            const type = typeof block.type === 'string' ? block.type.trim().toLowerCase() : '';
            if (type === 'output_text' || type === 'text') {
              const blockText = typeof block.text === 'string' ? block.text : '';
              if (blockText) {
                textParts.push(blockText);
              }
              continue;
            }
            if (type !== 'tool_call' && type !== 'function_call' && type !== 'custom_tool_call' && type !== 'tool_use') {
              continue;
            }
            const callId = typeof block.call_id === 'string'
              ? block.call_id.trim()
              : typeof block.id === 'string'
                ? block.id.trim()
                : '';
            const name = typeof block.name === 'string' ? block.name.trim() : '';
            const rawArgs = typeof block.arguments === 'string'
              ? block.arguments
              : type === 'custom_tool_call' && typeof block.input === 'string'
                ? JSON.stringify({ input: block.input })
                : type === 'custom_tool_call' && block.input && typeof block.input === 'object' && !Array.isArray(block.input)
                  ? block.input
                  : type === 'tool_use' && block.input && typeof block.input === 'object' && !Array.isArray(block.input)
                    ? block.input
                    : block.arguments && typeof block.arguments === 'object' && !Array.isArray(block.arguments)
                      ? block.arguments
                      : '{}';
            let args: Record<string, unknown> = {};
            if (typeof rawArgs === 'string') {
              try {
                const parsed = JSON.parse(rawArgs);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                  args = parsed as Record<string, unknown>;
                } else {
                  throw new Error('[windsurf] assistant tool call arguments must be valid json object');
                }
              } catch {
                throw new Error('[windsurf] assistant tool call arguments must be valid json object');
              }
            } else if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
              args = rawArgs as Record<string, unknown>;
            } else {
              throw new Error('[windsurf] assistant tool call arguments must be valid json object');
            }
            if (!name) {
              throw new Error('[windsurf] assistant tool call missing name');
            }
            if (!callId) {
              throw new Error('[windsurf] assistant tool call missing call_id');
            }
            if (hasChatToolCalls) {
              if (seenHistoryToolCallIds.has(callId)) {
                throw new Error('[windsurf] duplicate assistant tool call id in history');
              }
              throw new Error('[windsurf] assistant history mixed chat tool_calls with content tool call');
            }
            if (seenHistoryToolCallIds.has(callId)) {
              throw new Error('[windsurf] duplicate assistant tool call id in history');
            }
            seenHistoryToolCallIds.add(callId);
            normalizedCalls.push({ call_id: callId, name, arguments: args });
          }
        }

        const text = textParts.join('');

        if (!text && normalizedCalls.length === 0) {
          throw new Error('[windsurf] empty assistant completion');
        }

        for (const call of normalizedCalls) {
          matchedCalls.set(call.call_id, {
            name: call.name,
          });
        }

        out.push({
          type: 'assistant',
          text,
          ...(normalizedCalls.length > 0 ? { tool_calls: normalizedCalls } : {}),
        });
        continue;
      }

      if (role === 'tool') {
        const parsedToolResult = this.parseCascadeToolResultTurnSync(msg, matchedCalls);
        if (completedToolCallIds.has(parsedToolResult.call_id)) {
          throw new Error('[windsurf] duplicate tool_result for completed tool call');
        }
        out.push(parsedToolResult);
        completedToolCallIds.add(parsedToolResult.call_id);
        continue;
      }
    }

    return out;
  }

  private parseCascadeToolResultTurnSync(
    message: unknown,
    matchedCalls: Map<string, { name: string }>,
  ): Extract<WindsurfSemanticTurn, { type: 'function_call_output' }> {
    const msg = message && typeof message === 'object' ? message as Record<string, unknown> : {};
    const extractNestedToolResultCallId = (content: unknown): string => {
      if (!Array.isArray(content)) {
        return '';
      }
      for (const item of content) {
        if (!item || typeof item !== 'object') {
          continue;
        }
        const block = item as Record<string, unknown>;
        const candidates = [
          block.tool_call_id,
          block.call_id,
          block.tool_use_id,
          block.id,
        ];
        for (const candidate of candidates) {
          if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim();
          }
        }
      }
      return '';
    };
    const callId = typeof msg.tool_call_id === 'string'
      ? msg.tool_call_id.trim()
      : typeof msg.id === 'string'
        ? msg.id.trim()
        : extractNestedToolResultCallId(msg.content);
    const name = typeof msg.name === 'string' ? msg.name.trim() : '';
    const normalizeToolResultContent = (content: unknown): string => {
      if (typeof content === 'string') {
        return content;
      }
      if (content == null) {
        return '';
      }
      if (Array.isArray(content)) {
        const parts: string[] = [];
        let sawStructuredBlock = false;
        for (const item of content) {
          if (!item || typeof item !== 'object') {
            continue;
          }
          const block = item as Record<string, unknown>;
          const type = typeof block.type === 'string' ? block.type.trim().toLowerCase() : '';
          if (type === 'text' || type === 'output_text') {
            sawStructuredBlock = true;
            const text = typeof block.text === 'string' ? block.text : '';
            if (text) {
              parts.push(text);
            }
            continue;
          }
          if (type === 'function_call_output' || type === 'tool_result' || type === 'custom_tool_call_output' || type === 'tool_message') {
            sawStructuredBlock = true;
            const nestedOutput = typeof block.output === 'string'
              ? block.output
              : block.output == null
                ? typeof block.content === 'string'
                  ? block.content
                  : block.content == null
                    ? ''
                    : JSON.stringify(block.content)
                : JSON.stringify(block.output);
            if (nestedOutput) {
              parts.push(nestedOutput);
            }
          }
        }
        if (sawStructuredBlock) {
          return parts.join('');
        }
      }
      return JSON.stringify(content);
    };
    const output = normalizeToolResultContent(msg.content);
    if (!callId || !matchedCalls.has(callId)) {
      throw new Error('[windsurf] orphan tool_result without matching assistant tool call');
    }
    const matched = matchedCalls.get(callId)!;
    const annotatedOutput = (
      matched.name === 'Read'
      && typeof output === 'string'
      && output
      && !/^\s*\d+\t/m.test(output)
      && ((/(?:file )?(?:content )?(?:unchanged|cached)/i.test(output) && output.length < 2000) || /truncated|截断|丢失/i.test(output.toLowerCase()))
    )
      ? `${output}\n\n[WindsurfAPI note: This Read result does not prove the full file body is available in the current conversation. If the task depends on full file contents, use Read with offset/limit or another content-bearing tool result before returning PASS.]`
      : output;
    return {
      type: 'function_call_output',
      call_id: callId,
      name: name || matched.name,
      output: annotatedOutput,
    };
  }

  private buildCascadeCompletionFromOutput(payload: {
    model: string;
    candidate: unknown;
    usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } | null;
    nativeTools?: Array<Record<string, unknown>>;
  }): Record<string, unknown> {
    const candidate = payload.candidate;
    if (!candidate || typeof candidate !== 'object') {
      throw new Error('[windsurf] empty cascade candidate payload');
    }

    const parsed = this.parseCascadeAssistantTurnSync(candidate, payload.nativeTools || []);
    const toolCalls = Array.isArray((parsed as Record<string, unknown>).tool_calls)
      ? ((parsed as Record<string, unknown>).tool_calls as unknown[])
      : [];
    const parsedRecord = parsed as Record<string, unknown>;
    const parsedContent = typeof parsedRecord.content === 'string' ? parsedRecord.content : '';
    const parsedReasoning = typeof parsedRecord.reasoning_content === 'string' ? parsedRecord.reasoning_content : '';
    if (
      toolCalls.length === 0
      && !parsedContent.trim()
      && parsedReasoning.trim()
      && !/thinking/i.test(String(payload.model || ''))
    ) {
      parsedRecord.content = parsedReasoning;
    }
    const usage = payload.usage && typeof payload.usage === 'object' ? payload.usage : null;
    const inputTokens = typeof usage?.inputTokens === 'number' ? usage.inputTokens : 0;
    const outputTokens = typeof usage?.outputTokens === 'number' ? usage.outputTokens : 0;
    const cacheReadTokens = typeof usage?.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0;
    const cacheWriteTokens = typeof usage?.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : 0;
    const promptTokens = inputTokens + cacheReadTokens;
    const totalTokens = promptTokens + outputTokens + cacheWriteTokens;

    const chatPayload: Record<string, unknown> = {
      id: `chatcmpl-${randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: payload.model,
      choices: [
        {
          index: 0,
          message: parsed,
          finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        },
      ],
      ...(toolCalls.length === 0 ? { tool_outputs: this.extractFunctionCallOutputRows(candidate) } : {}),
      ...(usage ? {
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: outputTokens,
          input_tokens: promptTokens,
          output_tokens: outputTokens,
          total_tokens: totalTokens,
          prompt_tokens_details: {
            cached_tokens: cacheReadTokens,
          },
          input_tokens_details: {
            cached_tokens: cacheReadTokens,
          },
          cache_creation_input_tokens: cacheWriteTokens,
          cache_read_input_tokens: cacheReadTokens,
          cascade_breakdown: {
            fresh_input_tokens: inputTokens,
            cache_read_tokens: cacheReadTokens,
            cache_write_tokens: cacheWriteTokens,
            output_tokens: outputTokens,
          },
        },
      } : {}),
    };
    return chatPayload;
  }

  private extractFunctionCallOutputRows(candidate: unknown): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (!value || typeof value !== 'object') return;
      const row = value as Record<string, unknown>;
      const type = typeof row.type === 'string' ? row.type.trim() : '';
      if (type === 'function_call_output' || type === 'tool_result' || type === 'custom_tool_call_output' || type === 'tool_message') {
        const callId = typeof row.call_id === 'string' && row.call_id.trim()
          ? row.call_id.trim()
          : typeof row.tool_call_id === 'string' && row.tool_call_id.trim()
            ? row.tool_call_id.trim()
            : typeof row.id === 'string' && row.id.trim()
              ? row.id.trim()
              : '';
        if (callId) {
          const output = typeof row.output === 'string'
            ? row.output
            : typeof row.content === 'string'
              ? row.content
              : row.output == null
                ? ''
                : JSON.stringify(row.output);
          out.push({ tool_call_id: callId, output });
        }
      }
      for (const value of Object.values(row)) visit(value);
    };
    visit(candidate);
    return out;
  }

  private classifyWindsurfCascadeError(error: unknown): Error {
    const source = error instanceof Error ? error : new Error(String(error));
    const structured = source as Error & Record<string, unknown>;
    const isAlreadyStructured = (
      typeof structured.code === 'string'
      && typeof structured.status === 'number'
      && typeof structured.retryable === 'boolean'
    );
    const normalizedSourceMessage = source.message.toLowerCase();
    const isStructuredWeeklyQuota =
      normalizedSourceMessage.includes('weekly usage quota has been exhausted')
      || normalizedSourceMessage.includes('weekly quota has been exhausted')
      || normalizedSourceMessage.includes('weekly usage quota exhausted');
    if (isAlreadyStructured && !isStructuredWeeklyQuota) {
      return structured;
    }
    if (isAlreadyStructured && isStructuredWeeklyQuota) {
      attachWindsurfErrorFields(structured, {
        code: 'WINDSURF_WEEKLY_QUOTA_EXHAUSTED',
        status: 429,
        retryable: false,
        rateLimitKind: 'daily_limit',
        cooldownOverrideMs: computeWindsurfQuotaCooldownUntilNextMidnightMs(),
        quotaScope: 'weekly',
        quotaReason: 'windsurf_weekly_exhausted',
      });
      return structured;
    }
    const classified = new Error(source.message) as Error & Record<string, unknown>;
    const sourceRecord = source as Error & { status?: unknown; response?: { status?: unknown; data?: unknown } };
    const responseData = sourceRecord.response?.data && typeof sourceRecord.response.data === 'object'
      ? sourceRecord.response.data as Record<string, unknown>
      : null;
    const nestedError = responseData?.error && typeof responseData.error === 'object'
      ? responseData.error as Record<string, unknown>
      : null;
    const upstreamStatus =
      typeof sourceRecord.status === 'number'
        ? sourceRecord.status
        : typeof sourceRecord.response?.status === 'number'
          ? sourceRecord.response.status
          : typeof nestedError?.code === 'number'
            ? nestedError.code
            : null;
    const statusText = typeof nestedError?.status === 'string' ? nestedError.status.toLowerCase() : '';
    const message = normalizedSourceMessage;
    const isWeeklyQuota =
      message.includes('weekly usage quota has been exhausted')
      || message.includes('weekly quota has been exhausted')
      || message.includes('weekly usage quota exhausted');
    const isPolicyBlocked =
      /cyber\s*verification|content[\s_-]+policy|policy[\s_-]+(?:violation|blocked|denied)|safety[\s_-]+(?:policy|blocked)|prompt[\s_-]+(?:rejected|blocked)\s+by[\s_-]+policy|usage[\s_-]+policy[\s_-]+violation/i.test(source.message);
    const isResourceExhausted =
      message.includes('resource_exhausted')
      || statusText === 'resource_exhausted'
      || message.includes('message limit')
      || message.includes('overall message rate limit')
      || message.includes('rate limit')
      || message.includes('reached your message limit for this model');
    const isInternalTransient =
      message.includes('an internal error occurred')
      || message.includes('internal error occurred');
    const isAuth =
      upstreamStatus === 401
      || statusText === 'unauthenticated'
      || message.includes('unauthenticated')
      || message.includes('invalid authentication credentials')
      || message.includes('permission_denied');
    const isServiceUnavailable =
      message.includes('econnrefused')
      || message.includes('connection refused')
      || message.includes('managed ls port')
      || message.includes('not ready')
      || message.includes('no free local ls port')
      || message.includes('runtime lsport missing');
    const isTransportTransient =
      message.includes('econnreset') ||
      message.includes('err_http2') ||
      message.includes('pending stream has been canceled') ||
      message.includes('err_http2_stream_cancel') ||
      message.includes('session closed') ||
      message.includes('stream closed');
    const isParseFailure =
      message.includes('[windsurf] empty cascade candidate payload')
      || message.includes('[windsurf] empty assistant completion')
      || message.includes('[windsurf] empty cascade poll response')
      || message.includes('[windsurf] cascade poll response is not valid json object')
      || message.includes('[windsurf] empty cascade_id from start response');
    attachWindsurfErrorFields(classified, {
      code: isWeeklyQuota
        ? 'WINDSURF_WEEKLY_QUOTA_EXHAUSTED'
        : isPolicyBlocked
          ? 'WINDSURF_POLICY_BLOCKED'
        : isInternalTransient || isTransportTransient
          ? 'WINDSURF_UPSTREAM_TRANSIENT'
        : isServiceUnavailable
          ? 'WINDSURF_SERVICE_UNREACHABLE'
        : isResourceExhausted
          ? 'WINDSURF_RATE_LIMITED'
        : isAuth
          ? 'WINDSURF_AUTH_FAILED'
          : isParseFailure
            ? 'WINDSURF_RESPONSE_PARSE_FAILED'
            : 'WINDSURF_SERVICE_UNREACHABLE',
      retryable: isWeeklyQuota || isResourceExhausted || isPolicyBlocked ? false : isAuth ? false : isParseFailure ? false : true,
      status: isWeeklyQuota || isResourceExhausted ? 429 : isPolicyBlocked ? 451 : isAuth ? 401 : isServiceUnavailable ? 503 : 502,
      rateLimitKind: isWeeklyQuota || isResourceExhausted ? 'daily_limit' : undefined,
      cooldownOverrideMs: isWeeklyQuota ? computeWindsurfQuotaCooldownUntilNextMidnightMs() : isResourceExhausted ? 24 * 60 * 60_000 : undefined,
      quotaScope: isWeeklyQuota ? 'weekly' : isResourceExhausted ? 'model' : undefined,
      quotaReason: isWeeklyQuota ? 'windsurf_weekly_exhausted' : isResourceExhausted ? 'windsurf_model_rate_limited' : undefined,
    });
    if (classified !== structured) {
      classified.cause = source;
    }
    return classified;
  }
}

function keyLikeSessionToken(value: unknown): boolean {
  return typeof value === 'string' && value.trim().startsWith('devin-session-token$');
}

function parseInlineWindsurfAccount(value: unknown): { email: string; passwordOrToken: string } | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  const idx = trimmed.indexOf('|');
  if (idx <= 0 || idx >= trimmed.length - 1) {
    return null;
  }
  return {
    email: trimmed.slice(0, idx).trim(),
    passwordOrToken: trimmed.slice(idx + 1).trim(),
  };
}

function normalizeWindsurfAuthRawType(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isManagedWindsurfAuthRawType(rawType: string): boolean {
  return rawType === 'windsurf-account' || rawType === 'windsurf-devin-token';
}
