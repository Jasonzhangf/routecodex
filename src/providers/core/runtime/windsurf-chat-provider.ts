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
import { ApiKeyAuthProvider } from '../../auth/apikey-auth.js';
import { resolveRccAuthDir } from '../../../config/user-data-paths.js';

const MERGE_EFFORT_MAP: Record<string, string> = {
  minimal: 'none', none: 'none', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh'
};
const VALID_EFFORTS = new Set(['minimal', 'none', 'low', 'medium', 'high', 'xhigh']);

const WINDSURF_AUTH1_PASSWORD_LOGIN_URL = 'https://windsurf.com/_devin-auth/password/login';
const WINDSURF_CHECK_LOGIN_METHOD_URL = 'https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/CheckUserLoginMethod';
const WINDSURF_POST_AUTH_URL = 'https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth';
const WINDSURF_POST_AUTH_URL_LEGACY = 'https://server.self-serve.windsurf.com/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth';
const WINDSURF_CASCADE_MODEL_CONFIGS_URL = 'https://server.codeium.com/exa.api_server_pb.ApiServerService/GetCascadeModelConfigs';
const WINDSURF_GET_CHAT_COMPLETIONS_URL = 'https://server.self-serve.windsurf.com/exa.api_server_pb.ApiServerService/GetChatCompletions';
const WINDSURF_LS_SERVICE = '/exa.language_server_pb.LanguageServerService';
const WINDSURF_CASCADE_TOOL_REINFORCEMENT = 'The functions listed above are available and callable. When the user\'s request can be answered by calling a function, emit a <tool_call> block as described. Use this exact format: <tool_call>{"name":"...","arguments":{...}}</tool_call>';
const WINDSURF_CASCADE_COMMUNICATION_NO_TOOLS = 'You are accessed via API. When asked about your identity, describe your actual underlying model name and provider accurately. Answer directly. STRICTLY respond in the exact same language the user used in their latest message (Chinese → Chinese, English → English, Japanese → Japanese; never switch mid-conversation).';
const WINDSURF_CASCADE_COMMUNICATION_WITH_TOOLS = 'You are accessed via API. When asked about your identity, describe your actual underlying model name and provider accurately. STRICTLY respond in the exact same language the user used in their latest message (Chinese → Chinese, English → English, Japanese → Japanese; never switch mid-conversation). Use the functions above when relevant.';

type WindsurfCascadeRuntimeScope = {
  pinnedRuntime: WindsurfProviderRuntimeOptions | null;
};

type WindsurfSessionCredential = {
  apiKey: string;
  sessionToken: string;
  auth1Token: string;
  accountId?: string;
  primaryOrgId?: string;
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
};

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
  if (!body || body.length === 0) {
    return Buffer.alloc(0);
  }
  return Buffer.concat([encodeProtoTag(fieldNo, 2), encodeProtoVarintValue(body.length), body]);
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

type WindsurfCascadeToolStepKind =
  | 'view_file'
  | 'run_command'
  | 'find'
  | 'grep_search_v2'
  | 'list_directory'
  | 'write_to_file'
  | 'read_url_content'
  | 'search_web';

type WindsurfCascadeMappedTool = {
  kind: WindsurfCascadeToolStepKind;
  forward: (args: Record<string, unknown>) => Record<string, unknown>;
  applyObservation?: (payload: Record<string, unknown>, observation: string) => void;
};

const WINDSURF_TOOL_MAP: Record<string, WindsurfCascadeMappedTool> = {
  read_file: {
    kind: 'view_file',
    forward: (args) => ({
      absolute_path_uri: buildFileUri(String(args.filePath ?? args.file_path ?? args.path ?? '')),
      ...(Number.isFinite(Number(args.offset)) && Number(args.offset) > 0 ? { offset: Number(args.offset) } : {}),
      ...(Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? { limit: Number(args.limit) } : {}),
    }),
    applyObservation: (payload, observation) => { payload.content = observation; },
  },
  read: {
    kind: 'view_file',
    forward: (args) => ({
      absolute_path_uri: buildFileUri(String(args.filePath ?? args.file_path ?? args.path ?? '')),
      ...(Number.isFinite(Number(args.offset)) && Number(args.offset) > 0 ? { offset: Number(args.offset) } : {}),
      ...(Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? { limit: Number(args.limit) } : {}),
    }),
    applyObservation: (payload, observation) => { payload.content = observation; },
  },
  view_file: {
    kind: 'view_file',
    forward: (args) => ({
      absolute_path_uri: buildFileUri(String(args.filePath ?? args.file_path ?? args.path ?? '')),
      ...(Number.isFinite(Number(args.offset)) && Number(args.offset) > 0 ? { offset: Number(args.offset) } : {}),
      ...(Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? { limit: Number(args.limit) } : {}),
    }),
    applyObservation: (payload, observation) => { payload.content = observation; },
  },
  exec_command: {
    kind: 'run_command',
    forward: (args) => ({
      command_line: String(args.cmd ?? args.command ?? args.input ?? ''),
      ...(typeof args.cwd === 'string' && args.cwd ? { cwd: args.cwd } : {}),
      blocking: true,
    }),
    applyObservation: (payload, observation) => {
      payload.combined_output = observation;
      payload.stdout = observation;
      payload.exit_code = 0;
    },
  },
  run_command: {
    kind: 'run_command',
    forward: (args) => ({
      command_line: String(args.cmd ?? args.command ?? args.input ?? ''),
      ...(typeof args.cwd === 'string' && args.cwd ? { cwd: args.cwd } : {}),
      blocking: true,
    }),
    applyObservation: (payload, observation) => {
      payload.combined_output = observation;
      payload.stdout = observation;
      payload.exit_code = 0;
    },
  },
  bash: {
    kind: 'run_command',
    forward: (args) => ({
      command_line: String(args.command ?? args.shell_command ?? args.cmd ?? ''),
      ...(typeof args.cwd === 'string' && args.cwd ? { cwd: args.cwd } : {}),
      blocking: true,
    }),
    applyObservation: (payload, observation) => {
      payload.combined_output = observation;
      payload.stdout = observation;
      payload.exit_code = 0;
    },
  },
  shell: {
    kind: 'run_command',
    forward: (args) => ({
      command_line: String(args.command ?? args.shell_command ?? args.cmd ?? ''),
      ...(typeof args.cwd === 'string' && args.cwd ? { cwd: args.cwd } : {}),
      blocking: true,
    }),
    applyObservation: (payload, observation) => {
      payload.combined_output = observation;
      payload.stdout = observation;
      payload.exit_code = 0;
    },
  },
  shell_command: {
    kind: 'run_command',
    forward: (args) => ({
      command_line: String(args.command ?? args.shell_command ?? args.cmd ?? ''),
      ...(typeof args.workdir === 'string' && args.workdir ? { cwd: args.workdir } : {}),
      ...(typeof args.cwd === 'string' && args.cwd && typeof args.workdir !== 'string' ? { cwd: args.cwd } : {}),
      blocking: true,
    }),
    applyObservation: (payload, observation) => {
      payload.combined_output = observation;
      payload.stdout = observation;
      payload.exit_code = 0;
    },
  },
  list_dir: {
    kind: 'list_directory',
    forward: (args) => ({
      directory_path_uri: buildFileUri(String(args.path ?? args.directory_path ?? args.cwd ?? '')),
      ...(typeof args.recursive === 'boolean' ? { recursive: args.recursive } : {}),
    }),
    applyObservation: (payload, observation) => {
      payload.children = observation.split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
    },
  },
  list_directory: {
    kind: 'list_directory',
    forward: (args) => ({
      directory_path_uri: buildFileUri(String(args.path ?? args.directory_path ?? args.filePath ?? '')),
      ...(typeof args.recursive === 'boolean' ? { recursive: args.recursive } : {}),
    }),
    applyObservation: (payload, observation) => {
      payload.children = observation.split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
    },
  },
  find: {
    kind: 'find',
    forward: (args) => ({
      pattern: String(args.pattern ?? ''),
      ...(typeof args.path === 'string' && args.path ? { search_directory: args.path } : {}),
    }),
    applyObservation: (payload, observation) => { payload.raw_output = observation; },
  },
  glob: {
    kind: 'find',
    forward: (args) => ({
      pattern: String(args.pattern ?? ''),
      ...(typeof args.path === 'string' && args.path ? { search_directory: args.path } : {}),
    }),
    applyObservation: (payload, observation) => { payload.raw_output = observation; },
  },
  grep: {
    kind: 'grep_search_v2',
    forward: (args) => ({
      pattern: String(args.pattern ?? ''),
      ...(typeof args.path === 'string' && args.path ? { path: args.path } : {}),
      ...(typeof args.glob === 'string' && args.glob ? { glob: args.glob } : {}),
      ...(typeof args['-i'] === 'boolean' ? { case_insensitive: args['-i'] } : {}),
    }),
    applyObservation: (payload, observation) => { payload.raw_output = observation; },
  },
  grep_search: {
    kind: 'grep_search_v2',
    forward: (args) => ({
      pattern: String(args.pattern ?? ''),
      ...(typeof args.path === 'string' && args.path ? { path: args.path } : {}),
      ...(typeof args.glob === 'string' && args.glob ? { glob: args.glob } : {}),
      ...(typeof args['-i'] === 'boolean' ? { case_insensitive: args['-i'] } : {}),
    }),
    applyObservation: (payload, observation) => { payload.raw_output = observation; },
  },
  grep_search_v2: {
    kind: 'grep_search_v2',
    forward: (args) => ({
      pattern: String(args.pattern ?? ''),
      ...(typeof args.path === 'string' && args.path ? { path: args.path } : {}),
      ...(typeof args.glob === 'string' && args.glob ? { glob: args.glob } : {}),
      ...(typeof args['-i'] === 'boolean' ? { case_insensitive: args['-i'] } : {}),
    }),
    applyObservation: (payload, observation) => { payload.raw_output = observation; },
  },
  write: {
    kind: 'write_to_file',
    forward: (args) => ({
      target_file_uri: buildFileUri(String(args.file_path ?? args.filePath ?? args.path ?? '')),
      code_content: typeof args.content === 'string'
        ? [args.content]
        : Array.isArray(args.content)
          ? args.content.map((entry) => String(entry))
          : [String(args.content ?? '')],
    }),
  },
  write_to_file: {
    kind: 'write_to_file',
    forward: (args) => ({
      target_file_uri: buildFileUri(String(args.target_file_uri ?? args.file_path ?? args.filePath ?? args.path ?? '')),
      code_content: Array.isArray(args.code_content)
        ? args.code_content.map((entry) => String(entry))
        : typeof args.content === 'string'
          ? [args.content]
          : [String(args.content ?? '')],
    }),
  },
  websearch: {
    kind: 'search_web',
    forward: (args) => ({
      query: String(args.query ?? args.q ?? ''),
      ...(Array.isArray(args.domains) && args.domains.length > 0
        ? { domain: String(args.domains[0]) }
        : typeof args.domain === 'string' && args.domain
          ? { domain: args.domain }
          : {}),
    }),
    applyObservation: (payload, observation) => { payload.summary = observation; },
  },
  toolsearch: {
    kind: 'search_web',
    forward: (args) => ({
      query: String(args.query ?? args.q ?? ''),
      ...(Array.isArray(args.domains) && args.domains.length > 0
        ? { domain: String(args.domains[0]) }
        : typeof args.domain === 'string' && args.domain
          ? { domain: args.domain }
          : {}),
    }),
    applyObservation: (payload, observation) => { payload.summary = observation; },
  },
  web_search: {
    kind: 'search_web',
    forward: (args) => ({
      query: String(args.query ?? args.q ?? ''),
      ...(Array.isArray(args.domains) && args.domains.length > 0
        ? { domain: String(args.domains[0]) }
        : typeof args.domain === 'string' && args.domain
          ? { domain: args.domain }
          : {}),
    }),
    applyObservation: (payload, observation) => { payload.summary = observation; },
  },
  webfetch: {
    kind: 'read_url_content',
    forward: (args) => ({
      url: String(args.url ?? args.uri ?? args.link ?? ''),
    }),
    applyObservation: (payload, observation) => { payload.summary = observation; },
  },
  read_url_content: {
    kind: 'read_url_content',
    forward: (args) => ({
      url: String(args.url ?? args.uri ?? args.link ?? ''),
    }),
    applyObservation: (payload, observation) => { payload.summary = observation; },
  },
};

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


function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`);
  return `{${entries.join(',')}}`;
}

type WindsurfResolvedToolChoice = {
  mode: 'auto' | 'required' | 'none';
  forceName: string | null;
};

function resolveWindsurfToolChoice(toolChoice: unknown): WindsurfResolvedToolChoice {
  if (toolChoice == null || toolChoice === 'auto') {
    return { mode: 'auto', forceName: null };
  }
  if (toolChoice === 'required') {
    return { mode: 'required', forceName: null };
  }
  if (toolChoice === 'none') {
    return { mode: 'none', forceName: null };
  }
  if (toolChoice && typeof toolChoice === 'object' && !Array.isArray(toolChoice)) {
    const row = toolChoice as Record<string, unknown>;
    if (row.type === 'function' && row.function && typeof row.function === 'object') {
      const fn = row.function as Record<string, unknown>;
      const name = typeof fn.name === 'string' ? fn.name.trim() : '';
      if (name) {
        return { mode: 'required', forceName: name };
      }
    }
  }
  return { mode: 'auto', forceName: null };
}

function buildWindsurfToolProtocolHeader(choice: WindsurfResolvedToolChoice): string {
  const lines = [
    'You have access to the following functions. They are REAL callable tools — the caller (a separate process on the user\'s actual machine) will execute them and return results in the next turn.',
    '',
    'To call a function, output ONE valid JSON object on a single line — starting with "{" and ending with "}". NO markdown code fence. NO prose before or after. NO leading commentary.',
    '',
    'Use this exact shape:',
    '{"function_call":{"name":"<function_name>","arguments":{<param>:<value>,...}}}',
    '',
    'Rules:',
    '1. Output ONLY the JSON object. NO ```json fence. NO "Here you go:" prefix. NO trailing explanation.',
    '2. "arguments" must be a JSON object whose keys match the function\'s parameter schema.',
    '3. The functions ARE available. DO NOT respond with "I cannot read files", "I don\'t have direct access", "please paste the file", or any similar refusal — those phrases are forbidden. Call the function instead.',
    '4. **NEVER FABRICATE OUTPUT.** Do NOT guess the result of a function call. Do NOT invent timestamps, file contents, command outputs, search results, or any other data that a function would have produced. If the user asks for the output of `echo $(date +%s)`, `ls`, `cat README.md`, or anything similar, you have NO way to know the answer — you MUST call the function. Hallucinated outputs are worse than refusing; the only correct response is the function_call JSON.',
    '5. If the user\'s request describes ANY action a function could perform — running a shell command, reading a file, searching the web, applying a patch — call that function. Do not "answer from memory" for these requests; memory cannot produce live data.',
    '6. After emitting one function_call JSON object, STOP generating immediately. The caller will run the function and feed the result back as a "tool" message.',
    '7. To call MULTIPLE functions in parallel, emit MULTIPLE JSON objects, one per line. Each line stands on its own.',
    '8. If — and only if — the user is plainly chatting (e.g. "hello", "thanks", "explain X concept") and no function is relevant, respond with plain text. Never mix plain text with JSON in the same response.',
    '9. The function-call result will arrive as a normal user/tool turn; you can call additional functions on subsequent turns until the task is done.',
    '',
  ];

  if (choice.mode === 'required' && choice.forceName) {
    lines.push('6. You MUST call at least one function for every request. Do NOT answer directly in plain text — always use a <tool_call>.');
    lines.push(`7. You MUST call the function "${choice.forceName}". No other function and no direct answer.`);
  } else if (choice.mode === 'required') {
    lines.push('6. You MUST call at least one function for every request. Do NOT answer directly in plain text — always use a <tool_call>.');
  } else if (choice.mode === 'none') {
    lines.push('6. Do NOT call any functions. Answer the user\'s question directly in plain text.');
  } else {
    lines.push('6. When a function is relevant to the user\'s request, you SHOULD call it rather than answering from memory. Prefer using a tool over guessing.');
  }

  return lines.join('\n');
}

function buildWindsurfToolSpecificRules(tools: Array<Record<string, unknown>>): string[] {
  const names = new Set(
    tools
      .map((tool) => {
        const fn = tool.function && typeof tool.function === 'object' ? tool.function as Record<string, unknown> : {};
        return typeof fn.name === 'string' ? fn.name.trim().toLowerCase() : '';
      })
      .filter(Boolean),
  );
  const lines: string[] = [];
  if (names.has('read')) {
    lines.push('- Read: use "file_path" exactly for the path argument. If the user gives a concrete path, copy that path exactly instead of substituting a workspace guess.');
  }
  if (names.has('shell_command')) {
    lines.push('- shell_command: put the complete shell command in "command" exactly as it should run.');
  }
  return lines;
}

function stripWindsurfSchemaDocs(schema: unknown, root: unknown = schema, refStack: string[] = []): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => stripWindsurfSchemaDocs(item, root, refStack));
  }
  if (!schema || typeof schema !== 'object') {
    return schema;
  }
  const row = schema as Record<string, unknown>;
  if (typeof row.$ref === 'string') {
    const ref = row.$ref;
    if (refStack.includes(ref)) {
      return { type: 'object' };
    }
    const resolved = resolveWindsurfLocalSchemaRef(ref, root);
    if (!resolved) {
      return { type: 'object' };
    }
    const siblings = Object.fromEntries(Object.entries(row).filter(([key]) => key !== '$ref'));
    return stripWindsurfSchemaDocs({ ...resolved, ...siblings }, root, [...refStack, ref]);
  }
  const keep = new Set(['type', 'enum', 'properties', 'items', 'required', 'oneOf', 'anyOf', 'allOf', 'const', 'format', 'additionalProperties']);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!keep.has(key)) continue;
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      const props: Record<string, unknown> = {};
      for (const [propKey, propValue] of Object.entries(value as Record<string, unknown>)) {
        props[propKey] = stripWindsurfSchemaDocs(propValue, root, refStack);
      }
      out[key] = props;
    } else if ((key === 'items' || key === 'oneOf' || key === 'anyOf' || key === 'allOf') && value !== undefined) {
      out[key] = stripWindsurfSchemaDocs(value, root, refStack);
    } else if (key === 'additionalProperties') {
      if (value === false) out[key] = false;
      else if (value && typeof value === 'object') out[key] = stripWindsurfSchemaDocs(value, root, refStack);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function resolveWindsurfLocalSchemaRef(ref: string, root: unknown): unknown {
  if (!ref.startsWith('#/')) {
    return null;
  }
  const parts = ref.slice(2).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  let current: unknown = root;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || Array.isArray(current) || !(part in (current as Record<string, unknown>))) {
      return null;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function firstWindsurfSentence(text: string): string {
  if (typeof text !== 'string' || !text) return '';
  const trimmed = text.trim().split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
  const matched = trimmed.match(/^.{1,160}?[.!?](?=\s|$)/);
  return (matched ? matched[0] : trimmed.slice(0, 160)).trim();
}

function buildWindsurfParamSignature(parameters: unknown): string {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return '';
  const row = parameters as Record<string, unknown>;
  const properties = row.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return '';
  const required = new Set(Array.isArray(row.required) ? row.required.filter((item): item is string => typeof item === 'string') : []);
  const parts: string[] = [];
  for (const [name, schema] of Object.entries(properties as Record<string, unknown>)) {
    const optional = required.has(name) ? '' : '?';
    let type = 'any';
    if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
      const schemaRow = schema as Record<string, unknown>;
      if (typeof schemaRow.type === 'string') type = schemaRow.type;
      else if (Array.isArray(schemaRow.type)) type = schemaRow.type.map((item) => String(item)).join('|');
      if (Array.isArray(schemaRow.enum) && schemaRow.enum.length <= 6) {
        type = schemaRow.enum.map((item) => JSON.stringify(item)).join('|');
      }
    }
    parts.push(`${name}${optional}: ${type}`);
  }
  return parts.join(', ');
}

const WINDSURF_WORKSPACE_STUB_OVERRIDE = 'Workspace path hidden; "<workspace>" is a redaction marker, NOT a path — never pass it to shell tools (shell reads "<" as redirection). Use "." for cwd or relative paths. If asked for cwd, say unavailable.';
const WINDSURF_TOOL_REINFORCEMENT = 'The functions listed above are available and callable. When the user\'s request can be answered by calling a function, emit a <tool_call> block as described. Use this exact format: <tool_call>{"name":"...","arguments":{...}}</tool_call>';

function extractWindsurfCallerEnvironment(messages: unknown): string {
  if (!Array.isArray(messages)) {
    return '';
  }
  const seen = new Set<string>();
  const out: string[] = [];
  const cwdPatterns = [
    /(?:^|\n)\s*(?:[-*]\s+)?(?:Primary|Current|Initial|Default|Active|Project|My\s+)?Working\s+directory\s*[:=]\s*`?([^`\n]+?)`?(?=\n|$)/i,
    /(?:^|\n)\s*(?:[-*]\s+)?cwd\s*[:=]\s*`?([^`\n]+?)`?(?=\n|$)/i,
    /<cwd>\s*([^<\n]+)\s*<\/cwd>/i,
  ];
  const patterns: Array<[string, RegExp, (value: string) => string]> = [
    ['cwd', cwdPatterns[0], (v) => `- Working directory: ${v}`],
    ['cwd', cwdPatterns[1], (v) => `- Working directory: ${v}`],
    ['cwd', cwdPatterns[2], (v) => `- Working directory: ${v}`],
    ['git', /(?:^|\n)\s*(?:[-*]\s+)?Is(?:\s+(?:directory\s+)?(?:a\s+)?)git\s+repo(?:sitory)?\s*[:=]\s*([^\n<]+)/i, (v) => `- Is the directory a git repo: ${v}`],
    ['platform', /(?:^|\n)\s*(?:[-*]\s+)?Platform\s*[:=]\s*([^\n<]+)/i, (v) => `- Platform: ${v}`],
    ['os', /(?:^|\n)\s*(?:[-*]\s+)?OS\s+[Vv]ersion\s*[:=]\s*([^\n<]+)/i, (v) => `- OS version: ${v}`],
  ];

  for (const item of messages) {
    if (!item || typeof item !== 'object') continue;
    const msg = item as Record<string, unknown>;
    let content = '';
    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content
        .filter((part) => part && typeof part === 'object' && ['text', 'input_text', 'output_text'].includes(String((part as Record<string, unknown>).type || '').trim().toLowerCase()))
        .map((part) => typeof (part as Record<string, unknown>).text === 'string' ? String((part as Record<string, unknown>).text) : '')
        .join('\n');
    }
    if (!content) continue;
    for (const [key, regex, formatter] of patterns) {
      if (seen.has(key)) continue;
      const match = content.match(regex);
      if (!match) continue;
      const value = String(match[1] || '').trim();
      if (!value || value === '<workspace>') continue;
      seen.add(key);
      out.push(formatter(value));
    }
  }

  return seen.has('cwd') ? out.join('\n') : '';
}

function buildWindsurfToolsPreamble(tools: Array<Record<string, unknown>>, toolChoice: unknown, environment?: string): string {
  if (!Array.isArray(tools) || tools.length === 0) {
    return '';
  }
  const lines: string[] = [];
  if (typeof environment === 'string' && environment.trim()) {
    lines.push('## Environment facts');
    lines.push('The facts below are provided by the calling agent and describe the active execution context. Tool calls operate on these paths.');
    lines.push('');
    lines.push(environment.trim());
    lines.push('');
    lines.push(WINDSURF_WORKSPACE_STUB_OVERRIDE);
    lines.push('');
  } else {
    lines.push(WINDSURF_WORKSPACE_STUB_OVERRIDE);
    lines.push('');
  }
  lines.push(buildWindsurfToolProtocolHeader(resolveWindsurfToolChoice(toolChoice)));
  lines.push('');
  lines.push(WINDSURF_TOOL_REINFORCEMENT);

  const specificRules = buildWindsurfToolSpecificRules(tools);
  if (specificRules.length > 0) {
    lines.push('');
    lines.push('Tool argument fidelity rules:');
    lines.push(...specificRules);
  }

  lines.push('');
  lines.push('Available functions:');
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') {
      continue;
    }
    const fn = tool.function && typeof tool.function === 'object' ? tool.function as Record<string, unknown> : {};
    const name = typeof fn.name === 'string' ? fn.name.trim() : '';
    if (!name) {
      continue;
    }
    lines.push('');
    lines.push(`### ${name}`);
    if (typeof fn.description === 'string' && fn.description.trim()) {
      lines.push(fn.description.trim());
    }
    if (fn.parameters !== undefined) {
      lines.push('Parameters:');
      lines.push('```json');
      lines.push(JSON.stringify(fn.parameters, null, 2));
      lines.push('```');
    }
  }
  return lines.join('\n');
}

function buildWindsurfSchemaCompactToolsPreamble(tools: Array<Record<string, unknown>>, toolChoice: unknown, environment?: string): string {
  if (!Array.isArray(tools) || tools.length === 0) {
    return '';
  }
  const lines: string[] = [];
  if (typeof environment === 'string' && environment.trim()) {
    lines.push('## Environment facts');
    lines.push('The facts below are provided by the calling agent and describe the active execution context. Tool calls operate on these paths.');
    lines.push('');
    lines.push(environment.trim());
    lines.push('');
    lines.push(WINDSURF_WORKSPACE_STUB_OVERRIDE);
    lines.push('');
  } else {
    lines.push(WINDSURF_WORKSPACE_STUB_OVERRIDE);
    lines.push('');
  }
  lines.push(buildWindsurfToolProtocolHeader(resolveWindsurfToolChoice(toolChoice)));
  const specificRules = buildWindsurfToolSpecificRules(tools);
  if (specificRules.length > 0) {
    lines.push('');
    lines.push('Tool argument fidelity rules:');
    lines.push(...specificRules);
  }
  lines.push('');
  lines.push('Available functions:');
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const fn = tool.function && typeof tool.function === 'object' ? tool.function as Record<string, unknown> : {};
    const name = typeof fn.name === 'string' ? fn.name.trim() : '';
    if (!name) continue;
    lines.push('');
    lines.push(`### ${name}`);
    if (typeof fn.description === 'string' && fn.description.trim()) {
      lines.push(firstWindsurfSentence(fn.description.trim()));
    }
    if (fn.parameters !== undefined) {
      lines.push(`Params: ${JSON.stringify(stripWindsurfSchemaDocs(fn.parameters))}`);
    }
  }
  return lines.join('\n');
}

function buildWindsurfSkinnyToolsPreamble(tools: Array<Record<string, unknown>>, toolChoice: unknown, environment?: string): string {
  if (!Array.isArray(tools) || tools.length === 0) {
    return '';
  }
  const lines: string[] = [];
  if (typeof environment === 'string' && environment.trim()) {
    lines.push('## Environment facts');
    lines.push(environment.trim());
    lines.push('');
    lines.push(WINDSURF_WORKSPACE_STUB_OVERRIDE);
    lines.push('');
  } else {
    lines.push(WINDSURF_WORKSPACE_STUB_OVERRIDE);
    lines.push('');
  }
  lines.push(buildWindsurfToolProtocolHeader(resolveWindsurfToolChoice(toolChoice)));
  const specificRules = buildWindsurfToolSpecificRules(tools);
  if (specificRules.length > 0) {
    lines.push('');
    lines.push('Tool argument fidelity rules:');
    lines.push(...specificRules);
  }
  lines.push('');
  lines.push('Available functions (signature shown; full JSON schemas omitted to fit upstream payload budget):');
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const fn = tool.function && typeof tool.function === 'object' ? tool.function as Record<string, unknown> : {};
    const name = typeof fn.name === 'string' ? fn.name.trim() : '';
    if (!name) continue;
    const sig = buildWindsurfParamSignature(fn.parameters);
    const desc = typeof fn.description === 'string' && fn.description.trim()
      ? firstWindsurfSentence(fn.description.trim())
      : '';
    if (sig && desc) lines.push(`- ${name}(${sig}) — ${desc}`);
    else if (sig) lines.push(`- ${name}(${sig})`);
    else if (desc) lines.push(`- ${name}() — ${desc}`);
    else lines.push(`- ${name}()`);
  }
  return lines.join('\n');
}

function buildWindsurfCompactToolsPreamble(tools: Array<Record<string, unknown>>, toolChoice: unknown, environment?: string): string {
  if (!Array.isArray(tools) || tools.length === 0) {
    return '';
  }
  const names = tools
    .map((tool) => {
      const fn = tool?.function && typeof tool.function === 'object' ? tool.function as Record<string, unknown> : {};
      return typeof fn.name === 'string' ? fn.name.trim() : '';
    })
    .filter(Boolean);
  if (names.length === 0) {
    return '';
  }
  const lines: string[] = [];
  if (typeof environment === 'string' && environment.trim()) {
    lines.push('## Environment facts');
    lines.push('The facts below are provided by the calling agent and describe the active execution context. Tool calls operate on these paths.');
    lines.push('');
    lines.push(environment.trim());
    lines.push('');
    lines.push(WINDSURF_WORKSPACE_STUB_OVERRIDE);
    lines.push('');
  } else {
    lines.push(WINDSURF_WORKSPACE_STUB_OVERRIDE);
    lines.push('');
  }
  lines.push(buildWindsurfToolProtocolHeader(resolveWindsurfToolChoice(toolChoice)));
  const specificRules = buildWindsurfToolSpecificRules(tools);
  if (specificRules.length > 0) {
    lines.push('');
    lines.push('Tool argument fidelity rules:');
    lines.push(...specificRules);
  }
  lines.push('');
  lines.push(`Available functions: ${names.join(', ')}.`);
  lines.push('Parameter schemas are omitted in this preamble due to total tool-list size. Match each <tool_call> to the function name; the calling agent will validate argument shapes when it executes the call.');
  return lines.join('\n');
}

type WindsurfToolPreambleBudgetResult = {
  ok: boolean;
  preamble: string;
  fullBytes: number;
  finalBytes: number;
  compacted: boolean;
  tier: 'empty' | 'full' | 'schema-compact' | 'skinny' | 'names-only';
  softBytes: number;
  hardBytes: number;
};

export function applyWindsurfToolPreambleBudget(
  tools: Array<Record<string, unknown>>,
  toolChoice: unknown,
  environment = '',
  options?: { softBytes?: number; hardBytes?: number },
): WindsurfToolPreambleBudgetResult {
  const softBytes = options?.softBytes ?? 24000;
  const hardBytes = options?.hardBytes ?? 48000;
  const tiers = [
    { tier: 'full' as const, build: buildWindsurfToolsPreamble },
    { tier: 'schema-compact' as const, build: buildWindsurfSchemaCompactToolsPreamble },
    { tier: 'skinny' as const, build: buildWindsurfSkinnyToolsPreamble },
    { tier: 'names-only' as const, build: buildWindsurfCompactToolsPreamble },
  ];
  const full = tiers[0].build(tools, toolChoice, environment);
  if (!full) {
    return { ok: true, preamble: '', fullBytes: 0, finalBytes: 0, compacted: false, tier: 'empty', softBytes, hardBytes };
  }
  const fullBytes = Buffer.byteLength(full, 'utf8');
  let chosen: { tier: 'full' | 'schema-compact' | 'skinny' | 'names-only'; preamble: string; bytes: number } = {
    tier: 'full',
    preamble: full,
    bytes: fullBytes,
  };
  for (const tier of tiers) {
    const text = tier.tier === 'full' ? full : tier.build(tools, toolChoice, environment);
    const bytes = Buffer.byteLength(text, 'utf8');
    chosen = { tier: tier.tier, preamble: text, bytes };
    if (bytes <= softBytes) break;
  }
  const compacted = chosen.tier !== 'full';
  if (chosen.bytes > hardBytes) {
    return { ok: false, preamble: chosen.preamble, fullBytes, finalBytes: chosen.bytes, compacted, tier: chosen.tier, softBytes, hardBytes };
  }
  return { ok: true, preamble: chosen.preamble, fullBytes, finalBytes: chosen.bytes, compacted, tier: chosen.tier, softBytes, hardBytes };
}

function buildFileUri(value: string): string {
  const path = value.trim();
  if (!path) return '';
  if (/^file:\/\//i.test(path)) return path;
  return path.startsWith('/') ? `file://${path}` : path;
}

function flattenToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === 'string') {
        parts.push(item);
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      const block = item as Record<string, unknown>;
      const type = typeof block.type === 'string' ? block.type.trim().toLowerCase() : '';
      if ((type === 'text' || type === 'output_text') && typeof block.text === 'string') parts.push(block.text);
      else if (typeof block.output === 'string') parts.push(block.output);
      else if (typeof block.content === 'string') parts.push(block.content);
    }
    return parts.join('');
  }
  return JSON.stringify(content);
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

function createWindsurfProviderError(message: string, fields: Partial<WindsurfFailureClass> = {}): Error {
  const error = new Error(message) as Error & Record<string, unknown>;
  attachWindsurfErrorFields(error, {
    code: fields.code || 'WINDSURF_SERVICE_UNREACHABLE',
    retryable: fields.retryable ?? false,
    status: fields.status ?? 502,
    rateLimitKind: fields.rateLimitKind,
    cooldownOverrideMs: fields.cooldownOverrideMs,
    quotaScope: fields.quotaScope,
    quotaReason: fields.quotaReason,
  });
  return error;
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
    };
  }
  if (looksLikeInternalError || looksLikeTransportTransient) {
    return {
      code: 'WINDSURF_UPSTREAM_TRANSIENT',
      status: 502,
      retryable: true,
    };
  }
  return {
    code: isTrueRateLimit ? 'WINDSURF_RATE_LIMITED' : 'WINDSURF_SERVICE_UNREACHABLE',
    status: isTrueRateLimit ? 429 : 502,
    retryable: isTrueRateLimit ? false : true,
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
  rateLimitKind?: 'daily_limit' | 'short_lived';
  cooldownOverrideMs?: number;
  quotaScope?: 'weekly' | 'model';
  quotaReason?: string;
};

type WindsurfSemanticTurn =
  | { type: 'user'; text: string }
  | { type: 'assistant'; text: string; tool_calls?: Array<{ call_id: string; name: string; arguments: Record<string, unknown> }> }
  | { type: 'function_call_output'; call_id: string; name?: string; output: string };

function contentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      const block = part as Record<string, unknown>;
      const type = typeof block.type === 'string' ? block.type.toLowerCase() : '';
      if (typeof block.text === 'string') return block.text;
      if (type === 'image' || type === 'image_url' || type === 'input_image') return '[Image omitted from text history]';
      return JSON.stringify(block);
    }).join('');
  }
  return content == null ? '' : JSON.stringify(content);
}

function escapeHistoryTag(text: string, tag: string): string {
  return text.replaceAll(`</${tag}>`, `<\\/${tag}>`);
}

function compactSystemPromptForCascade(sysText: string): string {
  if (!sysText) return sysText;
  return sysText.replace(/(^|[\n.!?]\s*)You are /g, '$1The assistant is ');
}

function cascadeHistoryBudget(modelUid: string): number {
  const normalized = String(modelUid || '').toLowerCase();
  if (normalized.includes('gpt-5.5') || normalized.includes('gpt-5.4')) return 96_000;
  if (normalized.includes('gpt-5.3')) return 64_000;
  return 48_000;
}

function mergeReasoningEffortIntoModel(model: string, body: Record<string, unknown>): string {
  const effort = String((body.reasoning_effort as string) || (((body.reasoning as Record<string, unknown>)?.effort) as string) || '').toLowerCase().trim();
  if (!effort || !VALID_EFFORTS.has(effort)) return model;
  for (const e of VALID_EFFORTS) if (model.toLowerCase().endsWith('-' + e)) return model;
  const merged = `${model}-${MERGE_EFFORT_MAP[effort] || effort}`;
  return WINDSURF_MODEL_SET.has(merged.toLowerCase()) ? merged : model;
}

function attachWindsurfErrorFields(target: Error & Record<string, unknown>, c: WindsurfFailureClass): void {
  target.code = c.code;
  target.status = c.status;
  target.retryable = c.retryable;
  target.upstreamCode = c.code;
  target.providerFamily = 'windsurf';
  target.type = 'windsurf_upstream_error';
  if (c.rateLimitKind) {
    target.rateLimitKind = c.rateLimitKind;
  }
  if (typeof c.cooldownOverrideMs === 'number' && Number.isFinite(c.cooldownOverrideMs) && c.cooldownOverrideMs > 0) {
    target.cooldownOverrideMs = c.cooldownOverrideMs;
  }
  if (c.quotaScope) {
    target.quotaScope = c.quotaScope;
  }
  if (c.quotaReason) {
    target.quotaReason = c.quotaReason;
  }
}

export class WindsurfChatProvider extends HttpTransportProvider {
  static readonly WindsurfConnectSseTransform = WindsurfConnectSseTransform;
  private static readonly http2SessionPool = new Map<string, http2.ClientHttp2Session>();
  private static readonly cascadeRuntimeScope = new AsyncLocalStorage<WindsurfCascadeRuntimeScope>();
  private static readonly cascadeRuntimeQueues = new Map<string, Promise<void>>();
  private readonly windsurfRuntime: ReturnType<typeof normalizeWindsurfProviderRuntimeOptions>;
  private windsurfSessionCredential: WindsurfSessionCredential | null = null;
  private windsurfSessionCredentialPromise: Promise<WindsurfSessionCredential | null> | null = null;
  private windsurfForceRefreshLogin = false;
  private windsurfCascadeWarmupPromise: Promise<void> | null = null;
  private windsurfCascadeSessionIdOverride: string | null = null;

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
  }

  protected override getServiceProfile() {
    const base = super.getServiceProfile();
    return { ...base, supportsTools: true, supportsVision: true, supportsThinking: true, streamingModes: ['sse'] };
  }

  public override async checkHealth(): Promise<boolean> {
    try {
      const apiKey = await this.resolveCascadeApiKey();
      await this.fetchCascadeModelConfigsForSite(apiKey);
      return true;
    } catch {
      return false;
    }
  }

  protected override async preprocessRequest(request: UnknownObject): Promise<UnknownObject> {
    const req = { ...request } as Record<string, unknown>;
    const body = (req.body as Record<string, unknown>) || req;

    if (Array.isArray(body.tools as unknown[])) {
      const tools = body.tools as Array<Record<string, unknown>>;
      if (tools.length > 0) {
        const environment = extractWindsurfCallerEnvironment(body.messages);
        const preambleBudget = applyWindsurfToolPreambleBudget(tools, body.tool_choice, environment);
        if (!preambleBudget.ok) {
          throw createWindsurfProviderError(
            `windsurf tools preamble exceeds hard budget (${preambleBudget.finalBytes} > ${preambleBudget.hardBytes})`,
            {
              code: 'WINDSURF_TOOL_PREAMBLE_TOO_LARGE',
              status: 400,
              retryable: false,
            },
          );
        }
        if (preambleBudget.preamble) {
          body.tools_preamble = preambleBudget.preamble;
          body.windsurf_tools_preamble_tier = preambleBudget.tier;
        } else {
          delete body.tools_preamble;
          delete body.windsurf_tools_preamble_tier;
        }
        body.windsurf_declared_tools = tools;
        if (body.tool_choice !== undefined) {
          body.windsurf_tool_choice = body.tool_choice;
          delete body.tool_choice;
        }
        delete body.tools;
      }
    }

    if (typeof body.model === 'string' && body.model.startsWith('windsurf.')) body.model = body.model.slice('windsurf.'.length);
    if (typeof body.model === 'string' && body.model.length > 0) body.model = mergeReasoningEffortIntoModel(body.model, body);

    return req;
  }

  protected override async sendRequestInternal(request: UnknownObject): Promise<unknown> {
    const existingScope = WindsurfChatProvider.cascadeRuntimeScope.getStore();
    if (!existingScope) {
      return await this.runExclusiveCascadeRuntime(async () => {
        return await WindsurfChatProvider.cascadeRuntimeScope.run({ pinnedRuntime: null }, async () => this.sendRequestInternal(request));
      });
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
      hasToolsPreamble: typeof body.tools_preamble === 'string' && body.tools_preamble.length > 0,
      wantsSse,
    });
    const apiKey = await this.resolveCascadeApiKey();
    let lastError: unknown = null;
    let lastCascadeId = '';
    const maxCascadeAttempts = 2;
    for (let attempt = 1; attempt <= maxCascadeAttempts; attempt += 1) {
      try {
        const semanticConversation = this.parseCascadeSemanticRoundtripSync(body.messages);
        const resumeMeta = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
          ? (body.metadata as Record<string, unknown>).responsesResume
          : undefined;
        const isSubmitContinuation = resumeMeta && typeof resumeMeta === 'object' && !Array.isArray(resumeMeta);
        void wantsSse;
        if (!this.getPinnedGrpcRuntime()) {
          this.setPinnedGrpcRuntime(await this.resolveManagedRuntimeOptions());
        }
        const resolvedModel = resolveWindsurfChatCompletionsModel(model);
        const toolPreamble = typeof body.tools_preamble === 'string' ? body.tools_preamble : '';
        const text = this.buildCascadePromptText(body.messages, semanticConversation, resolvedModel.modelTag, toolPreamble);
        const isPanelMissing = (error: unknown): boolean => /panel state not found|not_found.*panel/i.test(String(error instanceof Error ? error.message : error || ''));
        const isExpiredCascade = (error: unknown): boolean => /not_found.*(cascade|trajectory)|(?:cascade|trajectory).*not[ _-]?found|expired.*cascade|unknown.*cascade/i.test(String(error instanceof Error ? error.message : error || ''));
        const isUntrustedWorkspace = (error: unknown): boolean => /untrusted workspace|workspace.*not.*trusted/i.test(String(error instanceof Error ? error.message : error || ''));

        let sessionId: string;
        let cascadeId: string;
        try {
          const selected = await this.selectUsablePinnedGrpcRuntime(apiKey);
          sessionId = selected.sessionId;
          cascadeId = selected.cascadeId;
        } catch (error) {
          if (!isPanelMissing(error)) {
            throw error;
          }
          this.resetWindsurfCascadeTransportState('panel-missing-start');
          const selected = await this.selectUsablePinnedGrpcRuntime(apiKey);
          sessionId = selected.sessionId;
          cascadeId = selected.cascadeId;
        }
        lastCascadeId = cascadeId;

        try {
          await this.sendCascadeMessage({
            apiKey,
            cascadeId,
            text,
            sessionId,
            modelEnum: resolvedModel.enumValue,
            modelUid: resolvedModel.modelTag,
            toolPreamble,
            additionalSteps: isSubmitContinuation ? [] : this.buildCascadeAdditionalStepsFromSemanticConversation(semanticConversation),
          });
        } catch (error) {
          if (!isPanelMissing(error) && !isExpiredCascade(error) && !isUntrustedWorkspace(error)) {
            throw error;
          }
          this.resetWindsurfCascadeTransportState('send-rewarm');
          const selected = await this.selectUsablePinnedGrpcRuntime(apiKey);
          sessionId = selected.sessionId;
          cascadeId = selected.cascadeId;
          lastCascadeId = cascadeId;
          await this.sendCascadeMessage({
            apiKey,
            cascadeId,
            text,
            sessionId,
            modelEnum: resolvedModel.enumValue,
            modelUid: resolvedModel.modelTag,
            toolPreamble,
            additionalSteps: isSubmitContinuation ? [] : this.buildCascadeAdditionalStepsFromSemanticConversation(semanticConversation),
          });
        }
        const output = await this.pollCascadeTrajectorySteps({
          cascadeId,
          model,
        });
        return this.buildCascadeCompletionFromOutput({
          model,
          candidate: output.candidate,
          usage: output.usage,
        });
      } catch (error) {
        lastError = error;
        const classified = this.classifyWindsurfCascadeError(error) as Error & Record<string, unknown>;
        const retryableTransport = classified.code === 'WINDSURF_UPSTREAM_TRANSIENT' && attempt < maxCascadeAttempts;
        this.logWindsurfStage('sendRequestInternal.error', {
          cascadeId: lastCascadeId || null,
          attempt,
          retryableTransport,
          error: error instanceof Error ? error.message : String(error),
        });
        if (!retryableTransport) {
          throw classified;
        }
        this.resetWindsurfCascadeTransportState(`retryable-transport-${attempt}`);
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      } finally {
        this.clearPinnedGrpcRuntime();
      }
    }
    this.logWindsurfStage('sendRequestInternal.error', {
      cascadeId: lastCascadeId || null,
      attempt: maxCascadeAttempts,
      retryableTransport: false,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
    throw this.classifyWindsurfCascadeError(lastError);
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

  private clearManagedWindsurfSessionCredential(): void {
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
      || message.includes('permission_denied')
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
      const postAuthBody = Buffer.alloc(0);
      let parsed = {
        sessionToken: '',
        accountId: undefined as string | undefined,
        primaryOrgId: undefined as string | undefined,
        error: undefined as string | undefined,
      };
      let lastErr: Error | null = null;
      const postAuthRequest = {
        method: 'POST',
        headers: postAuthHeaders,
        body: postAuthBody as unknown,
      } as RequestInit;
      for (const endpoint of [WINDSURF_POST_AUTH_URL, WINDSURF_POST_AUTH_URL_LEGACY]) {
        try {
          this.logWindsurfStage('sessionCredential.postAuth.begin', { endpoint, loginEmail });
          const response = await this.fetchWithTimeout(endpoint, postAuthRequest, 30000);
          const raw = await response.text();
          const maybeJson = (() => { try { return JSON.parse(raw); } catch { return raw; } })();
          const result = this.parseWindsurfPostAuthPayload(maybeJson);
          if (response.ok && result.sessionToken) {
            this.logWindsurfStage('sessionCredential.postAuth.done', {
              endpoint,
              loginEmail,
              accountId: result.accountId || null,
            });
            parsed = {
              sessionToken: result.sessionToken,
              accountId: result.accountId,
              primaryOrgId: result.primaryOrgId,
              error: undefined,
            };
            lastErr = null;
            break;
          }
          lastErr = createWindsurfProviderError(result.error || `windsurf post auth failed: ${response.status}`, {
            code: 'WINDSURF_POSTAUTH_FAILED',
            status: response.status || 502,
            retryable: response.status >= 500,
          });
        } catch (error) {
          this.logWindsurfStage('sessionCredential.postAuth.error', {
            endpoint,
            loginEmail,
            error: error instanceof Error ? error.message : String(error),
          });
          lastErr = error instanceof Error
            ? error
            : createWindsurfProviderError(String(error), {
                code: 'WINDSURF_POSTAUTH_FAILED',
                status: 502,
                retryable: true,
              });
        }
      }
      if (!parsed.sessionToken) {
        throw lastErr ?? createWindsurfProviderError('windsurf session token missing', {
          code: 'WINDSURF_SESSION_TOKEN_MISSING',
          status: 401,
          retryable: false,
        });
      }
      this.windsurfSessionCredential = {
        apiKey: parsed.sessionToken,
        sessionToken: parsed.sessionToken,
        auth1Token,
        accountId: parsed.accountId,
        primaryOrgId: parsed.primaryOrgId,
      };
      (auth as unknown as { config?: { apiKey?: string } }).config!.apiKey = parsed.sessionToken;
      await this.persistWindsurfSessionCredential(cfg, this.windsurfSessionCredential);
      this.logWindsurfStage('sessionCredential.ready', {
        loginEmail,
        accountId: parsed.accountId || null,
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

  private async resolveCascadeApiKey(): Promise<string> {
    await this.ensureWindsurfSessionCredential();
    const raw = this.readApiKey();
    if (keyLikeSessionToken(raw)) {
      return raw;
    }
    return this.readApiKey();
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
        status: response.status || (response.status === 401 ? 401 : 502),
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


  private buildCascadeAdditionalStepsFromSemanticConversation(semanticConversation: WindsurfSemanticTurn[]): Buffer[] {
    const out: Buffer[] = [];
    const toolResultById = new Map<string, string>();
    for (const turn of semanticConversation) {
      if (turn.type === 'function_call_output') {
        toolResultById.set(turn.call_id, turn.output);
      }
    }
    for (const turn of semanticConversation) {
      if (turn.type !== 'assistant' || !Array.isArray(turn.tool_calls)) continue;
      for (const toolCall of turn.tool_calls) {
        const mapped = WINDSURF_TOOL_MAP[String(toolCall.name || '').toLowerCase()];
        if (!mapped) continue;
        const payload = mapped.forward(toolCall.arguments || {});
        const observation = toolResultById.get(toolCall.call_id);
        if (typeof observation === 'string' && mapped.applyObservation) {
          mapped.applyObservation(payload, observation);
        }
        const encoded = this.buildCascadeAdditionalStep(mapped.kind, payload);
        if (encoded.length > 0) out.push(encoded);
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

  private buildWindsurfMetadataProto(apiKey: string, sessionId: string): Buffer {
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
      writeProtoStringField(10, sessionId),
      writeProtoStringField(12, 'windsurf'),
    ]);
  }

  private buildStartCascadeRequest(apiKey: string, sessionId: string): Buffer {
    return Buffer.concat([
      writeProtoMessageField(1, this.buildWindsurfMetadataProto(apiKey, sessionId)),
      writeProtoVarintField(4, 1),
      writeProtoVarintField(5, 1),
    ]);
  }

  private buildSendCascadeMessageRequest(args: {
    apiKey: string;
    cascadeId: string;
    text: string;
    sessionId: string;
    modelEnum: number;
    modelUid: string;
    toolPreamble?: string;
    additionalSteps?: Buffer[];
  }): Buffer {
    const conversationalParts: Buffer[] = [
      writeProtoVarintField(4, 3),
    ];
    if (args.toolPreamble) {
      conversationalParts.push(writeProtoMessageField(12, Buffer.concat([
        writeProtoVarintField(1, 1),
        writeProtoStringField(2, `${args.toolPreamble}\n\n${WINDSURF_CASCADE_TOOL_REINFORCEMENT}`),
      ])));
      conversationalParts.push(writeProtoMessageField(13, Buffer.concat([
        writeProtoVarintField(1, 1),
        writeProtoStringField(2, WINDSURF_CASCADE_COMMUNICATION_WITH_TOOLS),
      ])));
    } else {
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
    if (!args.toolPreamble) {
      plannerParts.push(writeProtoMessageField(11, Buffer.concat([
        writeProtoVarintField(1, 1),
        writeProtoStringField(2, ''),
      ])));
    }
    const cascadeConfig = Buffer.concat([
      writeProtoMessageField(1, Buffer.concat(plannerParts)),
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

  private resetWindsurfCascadeTransportState(reason: string): void {
    this.logWindsurfStage('cascade.transport.reset', { reason });
    this.closeLocalGrpcSession();
    this.windsurfCascadeWarmupPromise = null;
    this.windsurfCascadeSessionIdOverride = null;
    this.clearPinnedGrpcRuntime();
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
    const auth = (this.config.config as Record<string, unknown>).auth as Record<string, unknown> | undefined;
    const alias = typeof auth?.accountAlias === 'string' && auth.accountAlias.trim() ? auth.accountAlias.trim() : '';
    const account = typeof auth?.account === 'string' && auth.account.trim() ? auth.account.trim() : '';
    return alias || account || 'windsurf-default-runtime';
  }

  private async runExclusiveCascadeRuntime<T>(operation: () => Promise<T>): Promise<T> {
    const key = this.resolveCascadeRuntimeQueueKey();
    const previous = WindsurfChatProvider.cascadeRuntimeQueues.get(key) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    WindsurfChatProvider.cascadeRuntimeQueues.set(key, previous.then(() => current, () => current));
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (WindsurfChatProvider.cascadeRuntimeQueues.get(key) === current) {
        WindsurfChatProvider.cascadeRuntimeQueues.delete(key);
      }
    }
  }

  private extractLatestCascadeUserText(semanticConversation: WindsurfSemanticTurn[]): string {
    for (let index = semanticConversation.length - 1; index >= 0; index -= 1) {
      const turn = semanticConversation[index];
      if (turn?.type === 'user' && typeof turn.text === 'string' && turn.text.trim()) {
        return turn.text;
      }
    }
    throw createWindsurfProviderError('[windsurf] cascade semantic conversation missing terminal user text', {
      code: 'WINDSURF_REQUEST_BUILD_FAILED',
      status: 400,
      retryable: false,
    });
  }

  private formatCascadeHistoryToolCall(name: string, args: Record<string, unknown>, callId: string): string {
    return `<tool_call>${JSON.stringify({ name, arguments: args, id: callId })}</tool_call>`;
  }

  private formatCascadeHistoryToolResult(callId: string, output: string): string {
    return `<tool_result tool_call_id="${escapeHistoryTag(callId, 'tool_result')}">\n${escapeHistoryTag(output, 'tool_result')}\n</tool_result>`;
  }

  private buildCascadeHistoryTurnText(turn: WindsurfSemanticTurn): string {
    if (turn.type === 'assistant') {
      const parts: string[] = [];
      if (turn.text) parts.push(turn.text);
      if (Array.isArray(turn.tool_calls)) {
        for (const call of turn.tool_calls) {
          parts.push(this.formatCascadeHistoryToolCall(call.name, call.arguments, call.call_id));
        }
      }
      return parts.join('\n');
    }
    if (turn.type === 'function_call_output') {
      return this.formatCascadeHistoryToolResult(turn.call_id, turn.output);
    }
    return turn.text;
  }

  private buildCascadePromptText(messages: unknown, semanticConversation: WindsurfSemanticTurn[], modelUid: string, toolPreamble = ''): string {
    const rawMessages = Array.isArray(messages) ? messages.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object') : [];
    const systemMsgs = rawMessages.filter((msg) => String(msg.role || '').trim().toLowerCase() === 'system');
    const convo = semanticConversation.filter((turn) => turn.type === 'user' || turn.type === 'assistant' || turn.type === 'function_call_output');
    let sysText = systemMsgs.map((msg) => contentToString(msg.content)).join('\n').trim();
    if (sysText) sysText = compactSystemPromptForCascade(sysText);

    const applyUserToolPreamble = (text: string): string => {
      const preamble = typeof toolPreamble === 'string' ? toolPreamble.trim() : '';
      return preamble ? `${preamble}\n\n${text}` : text;
    };

    if (convo.length <= 1) {
      const latest = applyUserToolPreamble(this.extractLatestCascadeUserText(semanticConversation));
      return sysText ? `${sysText}\n\n${latest}` : latest;
    }

    const maxHistoryBytes = cascadeHistoryBudget(modelUid);
    const lines: string[] = [];
    let historyBytes = sysText ? sysText.length : 0;
    let firstIncluded = 0;
    for (let index = convo.length - 2; index >= 0; index -= 1) {
      const turn = convo[index]!;
      const tag = turn.type === 'user' || turn.type === 'function_call_output' ? 'human' : 'assistant';
      const line = `<${tag}>\n${escapeHistoryTag(this.buildCascadeHistoryTurnText(turn), tag)}\n</${tag}>`;
      if (historyBytes + line.length > maxHistoryBytes && lines.length > 0) {
        firstIncluded = index + 1;
        break;
      }
      lines.unshift(line);
      historyBytes += line.length;
      firstIncluded = index;
    }
    const latest = applyUserToolPreamble(this.extractLatestCascadeUserText(semanticConversation));
    let text = `The following is a multi-turn conversation. You MUST remember and use all information from prior turns.\n\n${lines.join('\n\n')}\n\n<human>\n${latest}\n</human>`;
    if (firstIncluded > 0) {
      text = `<truncation_note>The conversation above is truncated — ${firstIncluded} earlier turns were dropped due to length limits. The user's original task and the most recent tool results are preserved. Do NOT ask the user to repeat their task; continue from the latest context.</truncation_note>\n\n${text}`;
    }
    return sysText ? `${sysText}\n\n${text}` : text;
  }

  private async sendStartCascade(args: {
    apiKey: string;
    sessionId: string;
  }): Promise<string> {
    try {
      await this.ensureWindsurfCascadeWarmup(args.apiKey, args.sessionId);
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
    if (classified.code === 'WINDSURF_UPSTREAM_TRANSIENT') {
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
    toolPreamble?: string;
    additionalSteps?: Buffer[];
  }): Promise<void> {
    try {
      await this.grpcUnaryLocal(
        `${WINDSURF_LS_SERVICE}/SendUserCascadeMessage`,
        this.buildSendCascadeMessageRequest(args),
      );
    } catch (error) {
      throw this.handleWindsurfCascadeTransportFailure(error);
    }
  }

  private async pollCascadeTrajectorySteps(args: {
    cascadeId: string;
    model: string;
  }): Promise<{
    candidate: Record<string, unknown>;
    usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } | null;
  }> {
    try {
      void args.model;
      const maxWaitMs = 120_000;
      const pollIntervalMs = 500;
      const idleGraceMs = 1_500;
      const startedAt = Date.now();
      let lastText = '';
      let lastThinking = '';
      let usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } | null = null;
      let sawActive = false;
      let sawText = false;
      let idleCount = 0;
      let lastGrowthAt = startedAt;
      let lastStepCount = 0;

      while (Date.now() - startedAt < maxWaitMs) {
        const stepsResponse = await this.grpcUnaryLocal(
          `${WINDSURF_LS_SERVICE}/GetCascadeTrajectorySteps`,
          this.buildGetTrajectoryStepsRequest(args.cascadeId, 0),
        );
        const steps = this.parseTrajectorySteps(stepsResponse);
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
                const id = typeof rawCall.id === 'string' && rawCall.id ? rawCall.id : `${typeof rawCall.name === 'string' ? rawCall.name : 'tool'}:${typeof rawCall.argumentsJson === 'string' ? rawCall.argumentsJson : '{}'}:${toolCalls.length}`;
                if (seenToolCallIds.has(id)) continue;
                seenToolCallIds.add(id);
                toolCalls.push({
                  id,
                  type: 'function',
                  function: {
                    name: typeof rawCall.name === 'string' ? rawCall.name : '',
                    arguments: typeof rawCall.argumentsJson === 'string' ? rawCall.argumentsJson : '{}',
                  },
                });
              }
            }
          }
        }

        if (accumulatedText.length > lastText.length || accumulatedThinking.length > lastThinking.length || toolCalls.length > 0) {
          lastGrowthAt = Date.now();
        }
        if (accumulatedText) sawText = true;

        const textualToolCalls = toolCalls.length > 0 ? [] : this.extractToolCallsFromText(accumulatedText);
        const markupToolCalls = textualToolCalls.map((call) => ({
          id: call.id || `call_${createHash('sha256').update(`${call.name}:${stableStringify(call.arguments)}`).digest('hex').slice(0, 16)}`,
          type: 'function',
          function: {
            name: call.name,
            arguments: stableStringify(call.arguments),
          },
        }));
        if (toolCalls.length > 0 || markupToolCalls.length > 0) {
          const finalToolCalls = toolCalls.length > 0 ? toolCalls : markupToolCalls;
          return {
            candidate: {
              role: 'assistant',
              content: markupToolCalls.length > 0 ? this.stripToolCallMarkup(accumulatedText) : accumulatedText,
              ...(accumulatedThinking ? { reasoning_content: accumulatedThinking } : {}),
              tool_calls: finalToolCalls,
            },
            usage,
          };
        }

        lastText = accumulatedText || lastText;
        lastThinking = accumulatedThinking || lastThinking;

        const statusResponse = await this.grpcUnaryLocal(
          `${WINDSURF_LS_SERVICE}/GetCascadeTrajectory`,
          this.buildGetTrajectoryRequest(args.cascadeId),
        );
        const status = this.parseTrajectoryStatus(statusResponse);
        if (status !== 1) {
          sawActive = true;
          idleCount = 0;
        } else {
          const elapsed = Date.now() - startedAt;
          if (!sawActive && elapsed <= idleGraceMs) {
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
            continue;
          }
          idleCount += 1;
          const growthSettled = Date.now() - lastGrowthAt > pollIntervalMs * 2;
          const canBreak = sawText ? idleCount >= 2 && growthSettled : idleCount >= 4;
          if (canBreak && (lastText || lastThinking)) {
            const finalStepsResponse = await this.grpcUnaryLocal(
              `${WINDSURF_LS_SERVICE}/GetCascadeTrajectorySteps`,
              this.buildGetTrajectoryStepsRequest(args.cascadeId, 0),
            );
            const finalSteps = this.parseTrajectorySteps(finalStepsResponse);
            let finalText = '';
            let finalThinking = '';
            for (const step of finalSteps) {
              if (!step || typeof step !== 'object') continue;
              const row = step as Record<string, unknown>;
              finalText += typeof row.responseText === 'string' && row.responseText ? row.responseText : typeof row.text === 'string' ? row.text : '';
              finalThinking += typeof row.thinking === 'string' ? row.thinking : '';
            }
            return {
              candidate: {
                role: 'assistant',
                content: finalText || lastText || '',
                ...((finalThinking || lastThinking) ? { reasoning_content: finalThinking || lastThinking } : {}),
              },
              usage,
            };
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
    this.windsurfCascadeWarmupPromise = (async () => {
      await this.grpcUnaryLocal(
        `${WINDSURF_LS_SERVICE}/InitializeCascadePanelState`,
        this.buildInitializePanelStateRequest(apiKey, sessionId),
        5_000,
      );
      try {
        await this.grpcUnaryLocal(
          `${WINDSURF_LS_SERVICE}/AddTrackedWorkspace`,
          this.buildAddTrackedWorkspaceRequest(workspacePath),
          5_000,
        );
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error || '');
        if (!/path is already tracked/i.test(message)) {
          throw error;
        }
      }
      await this.grpcUnaryLocal(
        `${WINDSURF_LS_SERVICE}/UpdateWorkspaceTrust`,
        this.buildUpdateWorkspaceTrustRequest(apiKey, sessionId, true),
        5_000,
      );
      await this.grpcUnaryLocal(
        `${WINDSURF_LS_SERVICE}/Heartbeat`,
        this.buildHeartbeatRequest(apiKey, sessionId),
        5_000,
      );
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
      status: 502,
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
      status: 502,
      retryable: true,
    });
  }

  private async ensureManagedLocalGrpcRuntime(): Promise<WindsurfManagedLocalGrpcRuntime> {
    const key = this.resolveWindsurfManagedLsKey();
    const existing = WINDSURF_MANAGED_LS_POOL.get(key);
    if (existing && existing.ready && existing.process.exitCode == null && existing.process.signalCode == null && this.isTcpPortListening(existing.port)) {
      return existing;
    }
    const pending = WINDSURF_MANAGED_LS_PENDING.get(key);
    if (pending) return pending;
    const promise = (async () => {
      const preferred = this.windsurfRuntime.lsPort && this.windsurfRuntime.lsPort > 0
        ? this.windsurfRuntime.lsPort
        : WINDSURF_MANAGED_LS_DEFAULT_PORT;
      const port = this.findFreeManagedLsPort(preferred);
      const csrfToken = this.windsurfRuntime.csrfToken || WINDSURF_MANAGED_LS_CSRF;
      const binary = this.resolveWindsurfManagedLsBinaryPath();
      const codeiumDir = path.join(os.homedir(), '.rcc', 'windsurf-ls', key);
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
      const proc = childProcess.spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
      proc.stdout?.on('data', (chunk) => this.logWindsurfStage('managedLs.stdout', { key, text: String(chunk).slice(0, 500) }));
      proc.stderr?.on('data', (chunk) => this.logWindsurfStage('managedLs.stderr', { key, text: String(chunk).slice(0, 500) }));
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
    return path.join(os.homedir(), '.rcc', 'windsurf-workspaces', `workspace-${wsId}`);
  }

  private parseWindsurfLiveLocalGrpcRuntimeLine(line: string): WindsurfLiveLocalGrpcRuntime | null {
    const match = String(line || '').trim().match(/^\s*(\d+)\s+(.+)$/);
    if (!match) return null;
    const pid = Number.parseInt(match[1] || '', 10);
    const command = match[2] || '';
    if (!(command.includes('/.windsurf/language_server_macos_arm') || command.includes('/extensions/windsurf/bin/language_server_macos_arm'))) return null;
    const portMatch = command.match(/--server_port=(\d+)/);
    const csrfMatch = command.match(/--csrf_token=([^\s]+)/);
    const lsPort = portMatch ? Number.parseInt(portMatch[1] || '', 10) : 0;
    if (!Number.isFinite(lsPort) || lsPort <= 0) return null;
    return {
      lsPort,
      csrfToken: csrfMatch?.[1],
      pid: Number.isFinite(pid) ? pid : undefined,
      command,
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

  private async selectUsablePinnedGrpcRuntime(apiKey: string): Promise<{ sessionId: string; cascadeId: string }> {
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
        await this.ensureWindsurfCascadeWarmup(apiKey, sessionId);
        const response = await this.grpcUnaryLocal(
          `${WINDSURF_LS_SERVICE}/StartCascade`,
          this.buildStartCascadeRequest(apiKey, sessionId),
        );
        const cascadeId = this.parseStartCascadeResponse(response);
        if (!cascadeId) {
          throw createWindsurfProviderError('[windsurf] StartCascade returned empty cascade_id', {
            code: 'WINDSURF_RESPONSE_PARSE_FAILED',
            status: 502,
            retryable: false,
          });
        }
        return { sessionId, cascadeId };
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

  private async grpcUnaryLocal(pathName: string, payload: Buffer, timeout = 30_000): Promise<Buffer> {
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
      const done = (fn: (value: any) => void, value: any) => {
        if (settled) return;
        settled = true;
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
      const req = session.request({
        ':method': 'POST',
        ':path': pathName,
        'content-type': 'application/grpc',
        te: 'trailers',
        'grpc-accept-encoding': 'identity,gzip,deflate',
        'user-agent': 'grpc-node/1.108.2',
        'x-codeium-csrf-token': csrfToken,
      });
      const timer = setTimeout(() => {
        try { req.close(http2.constants.NGHTTP2_CANCEL); } catch {}
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
        clearTimeout(timer);
        this.logWindsurfStage('grpc.end', { pathName, grpcStatus, grpcMessage, bytes: chunks.reduce((sum, chunk) => sum + chunk.length, 0) });
        if (grpcStatus !== '0') {
          const message = grpcMessage ? decodeURIComponent(grpcMessage) : `gRPC status ${grpcStatus}`;
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
        clearTimeout(timer);
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
    toolPreamble?: string;
    tools?: Array<Record<string, unknown>>;
    toolChoice?: unknown;
  }): Record<string, unknown> {
    const prompts = this.buildChatMessagePromptsFromSemanticConversation(args.semanticConversation);
    const resolvedModel = resolveWindsurfChatCompletionsModel(args.model);
    const request: Record<string, unknown> = {
      metadata: buildWindsurfCascadeModelConfigsMetadata(args.apiKey),
      chatMessagePrompts: prompts,
      ...(typeof args.toolPreamble === 'string' && args.toolPreamble.length > 0
        ? { systemPrompt: args.toolPreamble }
        : {}),
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


  private safeParseJsonValue(raw: string): unknown {
    if (typeof raw !== 'string') return null;
    try {
      return JSON.parse(raw);
    } catch {
      // WindsurfAPI salvage behavior: tolerate one complete balanced JSON
      // object embedded in extra text/trailing braces.
    }
    const text = raw.trim();
    const start = text.search(/[\[{]/);
    if (start < 0) return null;
    const open = text[start]!;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const ch = text[index]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, index + 1));
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }

  private extractToolCallsFromParsedValue(parsed: unknown): Array<{ name: string; arguments: Record<string, unknown>; id?: string }> {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    const record = parsed as Record<string, unknown>;
    const rows: unknown[] = Array.isArray(record.tool_calls) ? record.tool_calls : [record];
    const out: Array<{ name: string; arguments: Record<string, unknown>; id?: string }> = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      const item = row as Record<string, unknown>;
      const inner = item.function_call && typeof item.function_call === 'object' && !Array.isArray(item.function_call)
        ? item.function_call as Record<string, unknown>
        : item.function && typeof item.function === 'object' && !Array.isArray(item.function)
          ? item.function as Record<string, unknown>
          : item.tool_call && typeof item.tool_call === 'object' && !Array.isArray(item.tool_call)
            ? item.tool_call as Record<string, unknown>
            : item;
      const name = typeof inner.name === 'string' ? inner.name.trim() : '';
      if (!name || !('arguments' in inner)) continue;
      const rawArgs = inner.arguments;
      const parsedArgs = typeof rawArgs === 'string'
        ? this.safeParseJsonValue(rawArgs)
        : rawArgs;
      const args = parsedArgs && typeof parsedArgs === 'object' && !Array.isArray(parsedArgs)
        ? parsedArgs as Record<string, unknown>
        : {};
      const id = typeof item.id === 'string' && item.id.trim()
        ? item.id.trim()
        : typeof inner.id === 'string' && inner.id.trim()
          ? inner.id.trim()
          : undefined;
      out.push({ name, arguments: args, ...(id ? { id } : {}) });
    }
    return out;
  }

  private extractToolCallsFromMarkup(text: string): Array<{ name: string; arguments: Record<string, unknown>; id?: string }> {
    const out: Array<{ name: string; arguments: Record<string, unknown>; id?: string }> = [];
    const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const raw = (match[1] || '').trim();
      if (!raw) continue;
      const parsed = this.safeParseJsonValue(raw);
      const calls = this.extractToolCallsFromParsedValue(parsed);
      if (calls.length === 0) {
        throw new Error('[windsurf] assistant tool_call markup must contain a valid tool call json object');
      }
      out.push(...calls);
    }
    return out;
  }

  private extractToolCallsFromJsonText(text: string): Array<{ name: string; arguments: Record<string, unknown>; id?: string }> {
    const trimmed = text.trim();
    if (!trimmed) return [];
    const parsed = this.safeParseJsonValue(trimmed);
    if (!parsed) return [];
    if (Array.isArray(parsed)) {
      return parsed.flatMap((item) => this.extractToolCallsFromParsedValue(item));
    }
    return this.extractToolCallsFromParsedValue(parsed);
  }

  private extractToolCallsFromText(text: string): Array<{ name: string; arguments: Record<string, unknown>; id?: string }> {
    const markup = this.extractToolCallsFromMarkup(text);
    return markup.length > 0 ? markup : this.extractToolCallsFromJsonText(text);
  }

  private stripToolCallMarkup(text: string): string {
    return text.replace(/<tool_call>\s*[\s\S]*?\s*<\/tool_call>/gi, '').trim();
  }

  private parseCascadeAssistantTurnSync(candidate: unknown): Record<string, unknown> {
    const record = candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : {};
    const rawContent = Array.isArray(record.content) ? record.content : [];
    const rawTopLevelToolCalls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolCalls: Array<Record<string, unknown>> = [];
    const seenToolCallIds = new Set<string>();
    const seenToolCallSignatures = new Set<string>();

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
      if (seenToolCallIds.has(callId)) {
        throw new Error('[windsurf] duplicate assistant tool call id in assistant candidate');
      }
      seenToolCallIds.add(callId);
      const signature = `${name}:${stableStringify(args)}`;
      if (seenToolCallSignatures.has(signature)) {
        throw new Error('[windsurf] duplicate assistant tool call signature in assistant candidate');
      }
      seenToolCallSignatures.add(signature);
      toolCalls.push({
        id: callId,
        type: 'function',
        function: {
          name,
          arguments: stableStringify(args),
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
      if (seenToolCallIds.has(callId)) {
        throw new Error('[windsurf] duplicate assistant tool call id in assistant candidate');
      }
      seenToolCallIds.add(callId);
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
      toolCalls.push({
        id: callId,
        type: 'function',
        function: {
          name,
          arguments: stableStringify(args),
        },
      });
      const signature = `${name}:${stableStringify(args)}`;
      if (seenToolCallSignatures.has(signature)) {
        throw new Error('[windsurf] duplicate assistant tool call signature in assistant candidate');
      }
      seenToolCallSignatures.add(signature);
    }

    const rawText = textParts.join('');
    const markupToolCalls = hasTopLevelToolCalls ? [] : this.extractToolCallsFromMarkup(rawText);
    const jsonTextToolCalls = hasTopLevelToolCalls || markupToolCalls.length > 0 ? [] : this.extractToolCallsFromJsonText(rawText);
    const textualToolCalls = markupToolCalls.length > 0 ? markupToolCalls : jsonTextToolCalls;
    if (textualToolCalls.length > 0) {
      for (const call of textualToolCalls) {
        const callId = call.id || `call_${createHash('sha256').update(`${call.name}:${stableStringify(call.arguments)}`).digest('hex').slice(0, 16)}`;
        if (seenToolCallIds.has(callId)) {
          throw new Error('[windsurf] duplicate assistant tool call id in assistant candidate');
        }
        seenToolCallIds.add(callId);
        const signature = `${call.name}:${stableStringify(call.arguments)}`;
        if (seenToolCallSignatures.has(signature)) {
          throw new Error('[windsurf] duplicate assistant tool call signature in assistant candidate');
        }
        seenToolCallSignatures.add(signature);
        toolCalls.push({
          id: callId,
          type: 'function',
          function: {
            name: call.name,
            arguments: stableStringify(call.arguments),
          },
        });
      }
    }
    const text = textualToolCalls.length > 0 ? (markupToolCalls.length > 0 ? this.stripToolCallMarkup(rawText) : '') : rawText;
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
    const matchedCalls = new Map<string, { name: string; signature: string }>();
    const completedToolCallIds = new Set<string>();
    let lastMatchedRoundSignatures: string[] = [];

    const buildSignature = (name: string, args: Record<string, unknown>): string => `${name}:${stableStringify(args)}`;
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
        lastMatchedRoundSignatures = [];
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
        const seenHistoryToolCallSignatures = new Set<string>();

        for (const entry of toolCallsRaw) {
          if (!entry || typeof entry !== 'object') {
            continue;
          }
          const row = entry as Record<string, unknown>;
          const fn = row.function && typeof row.function === 'object' ? row.function as Record<string, unknown> : {};
          const callId = typeof row.id === 'string' ? row.id.trim() : typeof row.call_id === 'string' ? String(row.call_id).trim() : '';
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
          const signature = buildSignature(name, args);
          if (seenHistoryToolCallSignatures.has(signature)) {
            throw new Error('[windsurf] duplicate assistant tool call signature in history');
          }
          seenHistoryToolCallSignatures.add(signature);
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
            const signature = buildSignature(name, args);
            if (hasChatToolCalls) {
              if (seenHistoryToolCallIds.has(callId)) {
                throw new Error('[windsurf] duplicate assistant tool call id in history');
              }
              if (seenHistoryToolCallSignatures.has(signature)) {
                throw new Error('[windsurf] duplicate assistant tool call signature in history');
              }
              throw new Error('[windsurf] assistant history mixed chat tool_calls with content tool call');
            }
            if (seenHistoryToolCallIds.has(callId)) {
              throw new Error('[windsurf] duplicate assistant tool call id in history');
            }
            seenHistoryToolCallIds.add(callId);
            if (seenHistoryToolCallSignatures.has(signature)) {
              throw new Error('[windsurf] duplicate assistant tool call signature in history');
            }
            seenHistoryToolCallSignatures.add(signature);
            normalizedCalls.push({ call_id: callId, name, arguments: args });
          }
        }

        const text = textParts.join('');

        if (!text && normalizedCalls.length === 0) {
          throw new Error('[windsurf] empty assistant completion');
        }

        if (lastMatchedRoundSignatures.length > 0 && normalizedCalls.length > 0) {
          const current = normalizedCalls.map((entry) => buildSignature(entry.name, entry.arguments)).sort();
          const previous = [...lastMatchedRoundSignatures].sort();
          if (current.length === previous.length && current.every((value, index) => value === previous[index])) {
            throw new Error('[windsurf] upstream repeated prior tool call after tool_result');
          }
        }

        for (const call of normalizedCalls) {
          matchedCalls.set(call.call_id, {
            name: call.name,
            signature: buildSignature(call.name, call.arguments),
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
        const matched = matchedCalls.get(parsedToolResult.call_id)!;
        out.push(parsedToolResult);
        completedToolCallIds.add(parsedToolResult.call_id);
        if (!lastMatchedRoundSignatures.includes(matched.signature)) {
          lastMatchedRoundSignatures = [...lastMatchedRoundSignatures, matched.signature];
        }
        continue;
      }
    }

    return out;
  }

  private parseCascadeToolResultTurnSync(
    message: unknown,
    matchedCalls: Map<string, { name: string; signature: string }>,
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
  }): Record<string, unknown> {
    const candidate = payload.candidate;
    if (!candidate || typeof candidate !== 'object') {
      throw new Error('[windsurf] empty cascade candidate payload');
    }

    const parsed = this.parseCascadeAssistantTurnSync(candidate);
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

    return {
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
  }

  private classifyWindsurfCascadeError(error: unknown): Error {
    const source = error instanceof Error ? error : new Error(String(error));
    const structured = source as Error & Record<string, unknown>;
    const isAlreadyStructured = (
      typeof structured.code === 'string'
      && typeof structured.status === 'number'
      && typeof structured.retryable === 'boolean'
    );
    if (isAlreadyStructured) {
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
    const message = source.message.toLowerCase();
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
    const isUnavailable =
      message.includes('connect') ||
      message.includes('econnreset') ||
      message.includes('err_http2') ||
      message.includes('econnrefused') ||
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
        : isInternalTransient || isUnavailable
          ? 'WINDSURF_UPSTREAM_TRANSIENT'
        : isResourceExhausted
          ? 'WINDSURF_RATE_LIMITED'
        : isAuth
          ? 'WINDSURF_AUTH_FAILED'
          : isParseFailure
            ? 'WINDSURF_RESPONSE_PARSE_FAILED'
            : 'WINDSURF_SERVICE_UNREACHABLE',
      retryable: isWeeklyQuota || isResourceExhausted || isPolicyBlocked ? false : isAuth ? false : isParseFailure ? false : true,
      status: isWeeklyQuota || isResourceExhausted ? 429 : isPolicyBlocked ? 451 : isAuth ? 401 : 502,
      rateLimitKind: isWeeklyQuota || isResourceExhausted ? 'daily_limit' : undefined,
      cooldownOverrideMs: isWeeklyQuota || isResourceExhausted ? 24 * 60 * 60_000 : undefined,
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
