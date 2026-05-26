import http2 from 'node:http2';
import { gunzipSync } from 'node:zlib';
import { decideCompletedNativeToolCallPairing } from './history-tool-projection-block.js';

export type WindsurfCascadeRuntimeOptions = {
  lsPort?: number;
  csrfToken?: string;
};

export type WindsurfGrpcUnaryDeps = {
  getRuntime: () => WindsurfCascadeRuntimeOptions;
  getSession: () => http2.ClientHttp2Session;
  closeSession: () => void;
  createError: (message: string, fields?: Record<string, unknown>) => Error;
  classifyPayloadError: (payload: Record<string, unknown>) => Record<string, unknown>;
  logStage: (stage: string, payload: Record<string, unknown>) => void;
};

export type WindsurfCascadePollUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

export type WindsurfCascadePollResult = {
  candidate: Record<string, unknown>;
  usage: WindsurfCascadePollUsage | null;
};

export type WindsurfStartCascadeParsedResponse =
  | { ok: true; cascadeId: string }
  | { ok: false; reason: string };

export type WindsurfTrajectoryParsedStatus =
  | { ok: true; status: number }
  | { ok: false; reason: string };

export type WindsurfGeneratorParsedMetadata =
  | ({ ok: true } & WindsurfCascadePollUsage & { entryCount?: number })
  | { ok: false; reason: string };

export function encodeProtoVarintValue(value: number): Buffer {
  const parts: number[] = [];
  if (!Number.isFinite(value)) return Buffer.from([0]);
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

export function encodeProtoTag(fieldNo: number, wireType: number): Buffer {
  return encodeProtoVarintValue((fieldNo << 3) | wireType);
}

export function writeProtoVarintField(fieldNo: number, value: number): Buffer {
  return Buffer.concat([encodeProtoTag(fieldNo, 0), encodeProtoVarintValue(value)]);
}

export function writeProtoBoolField(fieldNo: number, value: boolean): Buffer {
  return writeProtoVarintField(fieldNo, value ? 1 : 0);
}

export function writeProtoStringField(fieldNo: number, value: string): Buffer {
  const body = Buffer.from(value, 'utf8');
  return Buffer.concat([encodeProtoTag(fieldNo, 2), encodeProtoVarintValue(body.length), body]);
}

export function writeProtoMessageField(fieldNo: number, body: Buffer): Buffer {
  if (!body || body.length === 0) return Buffer.alloc(0);
  return Buffer.concat([encodeProtoTag(fieldNo, 2), encodeProtoVarintValue(body.length), body]);
}

export function buildCascadeAdditionalStep(kind: string, payload: Record<string, unknown>): Buffer {
    const meta: Record<string, { typeEnum: number; oneofField: number }> = {
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
    const body = buildCascadeStepBody(kind, payload);
    return Buffer.concat([
      writeProtoVarintField(1, selected.typeEnum),
      writeProtoVarintField(4, 3),
      writeProtoMessageField(selected.oneofField, body),
    ]);
  }

export function buildCascadeStepBody(kind: string, payload: Record<string, unknown>): Buffer {
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

export function buildNativeCascadeToolConfig(allowlist: string[]): Buffer {
  const list = allowlist.length > 0 ? allowlist : ['view_file', 'run_command', 'grep_search_v2', 'find', 'list_directory'];
  const parts: Buffer[] = [];
  const includesKind = (kind: string) => list.includes(kind);
  if (includesKind('run_command')) parts.push(writeProtoMessageField(8, Buffer.alloc(0)));
  if (includesKind('view_file')) parts.push(writeProtoMessageField(10, Buffer.alloc(0)));
  if (includesKind('list_directory')) parts.push(writeProtoMessageField(19, Buffer.alloc(0)));
  if (includesKind('grep_search_v2')) parts.push(writeProtoMessageField(33, Buffer.alloc(0)));
  if (includesKind('find')) parts.push(writeProtoMessageField(5, Buffer.alloc(0)));
  for (const name of list) parts.push(writeProtoStringField(32, name));
  return Buffer.concat(parts);
}

export function buildSendCascadeMessageRequest(args: {
  cascadeId: string;
  text: string;
  metadata: Buffer;
  modelEnum: number;
  modelUid: string;
  nativeMode?: boolean;
  nativeAllowlist?: string[];
  additionalSteps?: Buffer[];
  noToolsCommunication: string;
  noToolsConstraint: string;
  createError: (message: string, fields?: Record<string, unknown>) => Error;
  toolPreamble?: unknown;
}): Buffer {
  const conversationalParts: Buffer[] = [
    writeProtoVarintField(4, args.nativeMode ? 1 : 3),
  ];
  if (typeof args.toolPreamble === 'string' && args.toolPreamble.length > 0) {
    throw args.createError('[windsurf] text tool preamble is deprecated for Cascade protocol', {
      code: 'WINDSURF_TEXT_TOOL_PROTOCOL_REMOVED',
      status: 500,
      retryable: false,
    });
  }
  if (!args.nativeMode) {
    conversationalParts.push(writeProtoMessageField(10, Buffer.concat([
      writeProtoVarintField(1, 1),
      writeProtoStringField(2, 'No tools are available.'),
    ])));
    conversationalParts.push(writeProtoMessageField(12, Buffer.concat([
      writeProtoVarintField(1, 1),
      writeProtoStringField(2, args.noToolsConstraint),
    ])));
    conversationalParts.push(writeProtoMessageField(13, Buffer.concat([
      writeProtoVarintField(1, 1),
      writeProtoStringField(2, args.noToolsCommunication),
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
  if (args.nativeMode) {
    plannerParts.push(writeProtoMessageField(13, buildNativeCascadeToolConfig(args.nativeAllowlist || [])));
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
    writeProtoMessageField(3, args.metadata),
    writeProtoMessageField(5, cascadeConfig),
    ...((args.additionalSteps || []).filter((step) => Buffer.isBuffer(step) && step.length > 0).map((step) => writeProtoMessageField(9, step))),
  ]);
}


export function buildWindsurfMetadataProto(args: {
  apiKey: string;
  sessionId: string;
  platform: string;
  hardware: string;
  version?: string;
  randomRequestId: number;
}): Buffer {
  const version = args.version || '2.0.67';
  return Buffer.concat([
    writeProtoStringField(1, 'windsurf'),
    writeProtoStringField(2, version),
    writeProtoStringField(3, args.apiKey),
    writeProtoStringField(4, 'en'),
    writeProtoStringField(5, args.platform),
    writeProtoStringField(7, version),
    writeProtoStringField(8, args.hardware),
    writeProtoVarintField(9, args.randomRequestId),
    writeProtoStringField(10, args.sessionId),
    writeProtoStringField(12, 'windsurf'),
  ]);
}

export function buildStartCascadeRequest(args: { metadata: Buffer }): Buffer {
  return Buffer.concat([
    writeProtoMessageField(1, args.metadata),
    writeProtoVarintField(4, 1),
    writeProtoVarintField(5, 1),
  ]);
}

export function buildInitializePanelStateRequest(args: { metadata: Buffer }): Buffer {
  return Buffer.concat([
    writeProtoMessageField(1, args.metadata),
    writeProtoVarintField(3, 1),
  ]);
}

export function buildHeartbeatRequest(args: { metadata: Buffer }): Buffer {
  return Buffer.concat([writeProtoMessageField(1, args.metadata)]);
}

export function buildAddTrackedWorkspaceRequest(workspacePath: string): Buffer {
  return writeProtoStringField(1, workspacePath);
}

export function buildUpdateWorkspaceTrustRequest(args: { metadata: Buffer; trusted: boolean }): Buffer {
  return Buffer.concat([
    writeProtoMessageField(1, args.metadata),
    writeProtoVarintField(2, args.trusted ? 1 : 0),
  ]);
}

export function buildGetTrajectoryRequest(cascadeId: string): Buffer {
  return writeProtoStringField(1, cascadeId);
}

export function buildGetTrajectoryStepsRequest(args: { cascadeId: string; stepOffset?: number }): Buffer {
  const stepOffset = args.stepOffset || 0;
  return Buffer.concat([
    writeProtoStringField(1, args.cascadeId),
    ...(stepOffset > 0 ? [writeProtoVarintField(2, stepOffset)] : []),
  ]);
}

export function buildGetGeneratorMetadataRequest(args: { cascadeId: string; offset?: number }): Buffer {
  const offset = args.offset || 0;
  return Buffer.concat([
    writeProtoStringField(1, args.cascadeId),
    ...(offset > 0 ? [writeProtoVarintField(2, offset)] : []),
  ]);
}

export function grpcFrame(payload: Buffer): Buffer {
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = 0;
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

export function decodeGrpcFramePayload(args: {
  payload: Buffer;
  compressed: number;
  createError: (message: string, fields?: Record<string, unknown>) => Error;
}): Buffer {
  if (args.compressed === 0) return args.payload;
  if (args.compressed === 1) return gunzipSync(args.payload);
  throw args.createError(`[windsurf] unrecognized grpc frame compression flag=${args.compressed}`, {
    code: 'WINDSURF_RESPONSE_PARSE_FAILED',
    status: 502,
    retryable: false,
  });
}

export function stripGrpcFrame(args: {
  buf: Buffer;
  createError: (message: string, fields?: Record<string, unknown>) => Error;
}): Buffer {
  const { buf } = args;
  if (buf.length >= 5) {
    const compressed = buf[0] ?? 0;
    const messageLength = buf.readUInt32BE(1);
    if (buf.length >= 5 + messageLength) {
      return decodeGrpcFramePayload({ payload: buf.subarray(5, 5 + messageLength), compressed, createError: args.createError });
    }
  }
  return buf;
}

export function extractGrpcFrames(args: {
  buf: Buffer;
  createError: (message: string, fields?: Record<string, unknown>) => Error;
}): Buffer[] {
  const frames: Buffer[] = [];
  let offset = 0;
  while (offset + 5 <= args.buf.length) {
    const compressed = args.buf[offset] ?? 0;
    const messageLength = args.buf.readUInt32BE(offset + 1);
    if (offset + 5 + messageLength > args.buf.length) {
      break;
    }
    frames.push(decodeGrpcFramePayload({
      payload: args.buf.subarray(offset + 5, offset + 5 + messageLength),
      compressed,
      createError: args.createError,
    }));
    offset += 5 + messageLength;
  }
  return frames;
}

export async function grpcUnaryLocal(args: {
  pathName: string;
  payload: Buffer;
  timeout: number;
  deps: WindsurfGrpcUnaryDeps;
}): Promise<Buffer> {
  const runtime = args.deps.getRuntime();
  const csrfToken = typeof runtime.csrfToken === 'string' ? runtime.csrfToken.trim() : '';
  if (!csrfToken) {
    throw args.deps.createError('[windsurf] runtime csrfToken missing for local cascade transport', {
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
    const session = args.deps.getSession();
    const chunks: Buffer[] = [];
    let grpcStatus = '0';
    let grpcMessage = '';
    args.deps.logStage('grpc.request', {
      pathName: args.pathName,
      lsPort: runtime.lsPort || null,
      payloadBytes: args.payload.length,
      payloadPrefixHex: args.payload.subarray(0, 48).toString('hex'),
    });
    const req = session.request({
      ':method': 'POST',
      ':path': args.pathName,
      'content-type': 'application/grpc',
      te: 'trailers',
      'grpc-accept-encoding': 'identity,gzip,deflate',
      'user-agent': 'grpc-node/1.108.2',
      'x-codeium-csrf-token': csrfToken,
    });
    const timer = setTimeout(() => {
      try { req.close(http2.constants.NGHTTP2_CANCEL); } catch {}
      args.deps.closeSession();
      done(reject, args.deps.createError(`windsurf local grpc timeout: ${args.pathName}`, {
        code: 'WINDSURF_FETCH_TIMEOUT',
        status: 504,
        retryable: true,
      }));
    }, args.timeout);
    req.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('trailers', (trailers) => {
      grpcStatus = String(trailers['grpc-status'] ?? '0');
      grpcMessage = String(trailers['grpc-message'] ?? '');
    });
    req.on('end', () => {
      clearTimeout(timer);
      args.deps.logStage('grpc.end', { pathName: args.pathName, grpcStatus, grpcMessage, bytes: chunks.reduce((sum, chunk) => sum + chunk.length, 0) });
      if (grpcStatus !== '0') {
        const message = grpcMessage ? decodeURIComponent(grpcMessage) : `gRPC status ${grpcStatus}`;
        done(reject, args.deps.createError(message, {
          ...args.deps.classifyPayloadError({ code: grpcStatus, message }),
        }));
        return;
      }
      const full = Buffer.concat(chunks);
      const frames = extractGrpcFrames({ buf: full, createError: args.deps.createError });
      done(resolve, frames.length > 0 ? Buffer.concat(frames) : stripGrpcFrame({ buf: full, createError: args.deps.createError }));
    });
    req.on('error', (error) => {
      clearTimeout(timer);
      args.deps.logStage('grpc.error', { pathName: args.pathName, error: error instanceof Error ? error.message : String(error) });
      args.deps.closeSession();
      done(reject, args.deps.createError(String(error instanceof Error ? error.message : error), {
        code: 'WINDSURF_UPSTREAM_TRANSIENT',
        status: 502,
        retryable: true,
      }));
    });
    req.write(grpcFrame(args.payload));
    req.end();
  });
}

export async function sendStartCascade(args: {
  apiKey: string;
  sessionId: string;
  ensureWarmup: (apiKey: string, sessionId: string) => Promise<void>;
  grpcUnary: (pathName: string, payload: Buffer) => Promise<Buffer>;
  buildRequest: (apiKey: string, sessionId: string) => Buffer;
  parseResponse: (bytes: Uint8Array) => WindsurfStartCascadeParsedResponse;
  createError: (message: string, fields?: Record<string, unknown>) => Error;
  handleTransportFailure: (error: unknown) => Error;
  servicePath: string;
}): Promise<string> {
  try {
    await args.ensureWarmup(args.apiKey, args.sessionId);
    const response = await args.grpcUnary(
      `${args.servicePath}/StartCascade`,
      args.buildRequest(args.apiKey, args.sessionId),
    );
    const parsed = args.parseResponse(response);
    if (!parsed.ok) {
      throw args.createError(`[windsurf] StartCascade response parse failed: ${parsed.reason}`, {
        code: 'WINDSURF_RESPONSE_PARSE_FAILED',
        status: 502,
        retryable: false,
        parseReason: parsed.reason,
      });
    }
    const cascadeId = parsed.cascadeId;
    if (!cascadeId) {
      throw args.createError('[windsurf] StartCascade returned empty cascade_id', {
        code: 'WINDSURF_RESPONSE_PARSE_FAILED',
        status: 502,
        retryable: false,
      });
    }
    return cascadeId;
  } catch (error) {
    throw args.handleTransportFailure(error);
  }
}

export async function sendCascadeMessage(args: {
  request: {
    apiKey: string;
    cascadeId: string;
    text: string;
    sessionId: string;
    modelEnum: number;
    modelUid: string;
    nativeMode?: boolean;
    nativeAllowlist?: string[];
    additionalSteps?: Buffer[];
  };
  buildRequest: (request: any) => Buffer;
  snapshotRequest: (request: any, payload: Buffer) => Promise<void>;
  grpcUnary: (pathName: string, payload: Buffer) => Promise<Buffer>;
  handleTransportFailure: (error: unknown) => Error;
  servicePath: string;
}): Promise<void> {
  const payload = args.buildRequest(args.request);
  await args.snapshotRequest(args.request, payload);
  try {
    await args.grpcUnary(
      `${args.servicePath}/SendUserCascadeMessage`,
      payload,
    );
  } catch (error) {
    throw args.handleTransportFailure(error);
  }
}

export async function ensureWindsurfCascadeWarmup(args: {
  apiKey: string;
  sessionId: string;
  force?: boolean;
  getWarmupPromise: () => Promise<void> | null;
  setWarmupPromise: (promise: Promise<void> | null) => void;
  setSessionIdOverride: (sessionId: string | null) => void;
  resetTransportState: (reason: string) => void;
  resolveWorkspacePath: (apiKey: string) => string;
  mkdir: (path: string) => Promise<unknown>;
  grpcUnary: (pathName: string, payload: Buffer, timeout: number) => Promise<Buffer>;
  buildInitializePanelStateRequest: (apiKey: string, sessionId: string) => Buffer;
  buildAddTrackedWorkspaceRequest: (workspacePath: string) => Buffer;
  buildUpdateWorkspaceTrustRequest: (apiKey: string, sessionId: string, trusted: boolean) => Buffer;
  buildHeartbeatRequest: (apiKey: string, sessionId: string) => Buffer;
  servicePath: string;
}): Promise<void> {
  if (args.force) {
    args.resetTransportState('force-warmup');
    args.setSessionIdOverride(args.sessionId);
  }
  const existing = args.getWarmupPromise();
  if (existing) {
    await existing;
    return;
  }
  const workspacePath = args.resolveWorkspacePath(args.apiKey);
  await args.mkdir(workspacePath);
  const promise = (async () => {
    await args.grpcUnary(
      `${args.servicePath}/InitializeCascadePanelState`,
      args.buildInitializePanelStateRequest(args.apiKey, args.sessionId),
      5_000,
    );
    try {
      await args.grpcUnary(
        `${args.servicePath}/AddTrackedWorkspace`,
        args.buildAddTrackedWorkspaceRequest(workspacePath),
        5_000,
      );
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error || '');
      if (!/path is already tracked/i.test(message)) {
        throw error;
      }
    }
    await args.grpcUnary(
      `${args.servicePath}/UpdateWorkspaceTrust`,
      args.buildUpdateWorkspaceTrustRequest(args.apiKey, args.sessionId, true),
      5_000,
    );
    await args.grpcUnary(
      `${args.servicePath}/Heartbeat`,
      args.buildHeartbeatRequest(args.apiKey, args.sessionId),
      5_000,
    );
  })();
  args.setWarmupPromise(promise);
  try {
    await promise;
  } catch (error) {
    args.resetTransportState('warmup-failed');
    throw error;
  }
}

export async function pollCascadeTrajectorySteps(args: {
  cascadeId: string;
  model: string;
  rccTextTools?: Array<Record<string, unknown>>;
  completedNativeToolCallIds?: string[];
  completedNativeToolSignatures?: string[];
  grpcUnary: (pathName: string, payload: Buffer) => Promise<Buffer>;
  buildGetTrajectoryStepsRequest: (cascadeId: string, offset: number) => Buffer;
  buildGetTrajectoryRequest: (cascadeId: string) => Buffer;
  buildGetGeneratorMetadataRequest?: (cascadeId: string, offset: number) => Buffer;
  parseTrajectorySteps: (bytes: Uint8Array) => Array<Record<string, unknown>>;
  parseTrajectoryStatus: (bytes: Uint8Array) => WindsurfTrajectoryParsedStatus;
  parseGeneratorMetadata?: (bytes: Uint8Array) => WindsurfGeneratorParsedMetadata;
  parseAssistantTurn: (candidate: unknown, rccTextTools?: Array<Record<string, unknown>>) => Record<string, unknown>;
  createError: (message: string, fields?: Record<string, unknown>) => Error;
  handleTransportFailure: (error: unknown) => Error;
  logStage: (stage: string, payload: Record<string, unknown>) => void;
  lookupToolName: (name: string) => string;
  stableStringify: (value: unknown) => string;
  servicePath: string;
}): Promise<WindsurfCascadePollResult> {
  try {
    void args.model;
    const maxWaitMs = 120_000;
    const pollIntervalMs = 500;
    const idleGraceMs = 1_500;
    const startedAt = Date.now();
    let lastText = '';
    let lastThinking = '';
    let usage: WindsurfCascadePollUsage | null = null;
    let sawActive = false;
    let sawText = false;
    let idleCount = 0;
    let lastGrowthAt = startedAt;
    let lastStepCount = 0;
    let generatorMetadataOffset = 0;
    const completedNativeToolStrategy = {
      name: 'completed_native_tool_result_pairing' as const,
      completedCallIds: new Set(Array.isArray(args.completedNativeToolCallIds) ? args.completedNativeToolCallIds : []),
      completedSignatures: new Set(Array.isArray(args.completedNativeToolSignatures) ? args.completedNativeToolSignatures : []),
    };

    while (Date.now() - startedAt < maxWaitMs) {
      const stepsResponse = await args.grpcUnary(
        `${args.servicePath}/GetCascadeTrajectorySteps`,
        args.buildGetTrajectoryStepsRequest(args.cascadeId, 0),
      );
      const steps = args.parseTrajectorySteps(stepsResponse);
      let observedStepUsage = false;
      for (const step of steps) {
        if (!step || typeof step !== 'object') continue;
        const row = step as Record<string, unknown>;
        if (row.usage && typeof row.usage === 'object') {
          usage = row.usage as WindsurfCascadePollUsage;
          observedStepUsage = true;
        }
      }
      if (!observedStepUsage && args.buildGetGeneratorMetadataRequest && args.parseGeneratorMetadata) {
        const generatorMetadataResponse = await args.grpcUnary(
          `${args.servicePath}/GetCascadeTrajectoryGeneratorMetadata`,
          args.buildGetGeneratorMetadataRequest(args.cascadeId, generatorMetadataOffset),
        );
        const generatorMetadataUsage = args.parseGeneratorMetadata(generatorMetadataResponse);
        if (!generatorMetadataUsage.ok) {
          if (generatorMetadataUsage.reason === 'empty_meta_entries' || generatorMetadataUsage.reason === 'missing_usage_entries') {
            args.logStage('poll.generatorMetadata.empty', {
              cascadeId: args.cascadeId,
              offset: generatorMetadataOffset,
              reason: generatorMetadataUsage.reason,
            });
          } else {
            throw args.createError(`[windsurf] generator metadata parse failed: ${generatorMetadataUsage.reason}`, {
              code: 'WINDSURF_RESPONSE_PARSE_FAILED',
              status: 502,
              retryable: false,
              parseReason: generatorMetadataUsage.reason,
            });
          }
        } else if (generatorMetadataUsage) {
          usage = {
            inputTokens: generatorMetadataUsage.inputTokens,
            outputTokens: generatorMetadataUsage.outputTokens,
            cacheReadTokens: generatorMetadataUsage.cacheReadTokens,
            cacheWriteTokens: generatorMetadataUsage.cacheWriteTokens,
          };
          generatorMetadataOffset += typeof generatorMetadataUsage.entryCount === 'number' ? generatorMetadataUsage.entryCount : 0;
        }
      }
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
            throw args.createError(row.errorText.trim(), {
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
          if (Array.isArray(row.toolCalls)) {
            for (const rawCall of row.toolCalls as Array<Record<string, unknown>>) {
              const rawName = typeof rawCall.name === 'string' ? rawCall.name : '';
              const rawArgsJson = typeof rawCall.argumentsJson === 'string' ? rawCall.argumentsJson : '{}';
              const rawId = typeof rawCall.id === 'string' ? rawCall.id.trim() : '';
              if (rawId && completedNativeToolStrategy.completedCallIds.has(rawId)) {
                args.logStage('poll.toolCall.pairingDecision', {
                  cascadeId: args.cascadeId,
                  action: 'skip_completed_tool_call',
                  reason: 'call_id_already_completed',
                  toolCallId: rawId,
                  toolName: rawName || null,
                });
                continue;
              }
              const pairingDecision = decideCompletedNativeToolCallPairing({
                rawCall,
                strategy: completedNativeToolStrategy,
                lookupName: args.lookupToolName,
                stableStringify: args.stableStringify,
              });
              if (pairingDecision.action === 'skip_completed_native_tool_call') {
                args.logStage('poll.nativeToolCall.pairingDecision', {
                  cascadeId: args.cascadeId,
                  action: pairingDecision.action,
                  reason: pairingDecision.reason,
                  strategy: pairingDecision.strategy,
                  toolCallId: rawId || null,
                  toolName: rawName || null,
                });
                continue;
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

      if (accumulatedText.length > lastText.length || accumulatedThinking.length > lastThinking.length || toolCalls.length > 0) {
        lastGrowthAt = Date.now();
      }
      if (accumulatedText) sawText = true;

      if (toolCalls.length > 0) {
        const candidate = args.parseAssistantTurn({
          role: 'assistant',
          content: accumulatedText,
          ...(accumulatedThinking ? { reasoning_content: accumulatedThinking } : {}),
          tool_calls: toolCalls,
        }, args.rccTextTools || []);
        return { candidate, usage };
      }

      lastText = accumulatedText || lastText;
      lastThinking = accumulatedThinking || lastThinking;

      const statusResponse = await args.grpcUnary(
        `${args.servicePath}/GetCascadeTrajectory`,
        args.buildGetTrajectoryRequest(args.cascadeId),
      );
      const statusParsed = args.parseTrajectoryStatus(statusResponse);
      if (!statusParsed.ok) {
        throw args.createError(`[windsurf] trajectory status parse failed: ${statusParsed.reason}`, {
          code: 'WINDSURF_RESPONSE_PARSE_FAILED',
          status: 502,
          retryable: false,
          parseReason: statusParsed.reason,
        });
      }
      const status = statusParsed.status;
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
        if (canBreak) {
          const finalStepsResponse = await args.grpcUnary(
            `${args.servicePath}/GetCascadeTrajectorySteps`,
            args.buildGetTrajectoryStepsRequest(args.cascadeId, 0),
          );
          const finalSteps = args.parseTrajectorySteps(finalStepsResponse);
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
          if (!finalContent.trim() && !finalReasoning.trim() && (completedNativeToolStrategy.completedCallIds.size > 0 || completedNativeToolStrategy.completedSignatures.size > 0)) {
            args.logStage('poll.emptyAfterNativeResult', {
              cascadeId: args.cascadeId,
              steps: finalSteps.length,
              strategy: completedNativeToolStrategy.name,
              completedNativeToolCallIds: Array.from(completedNativeToolStrategy.completedCallIds),
              completedNativeToolSignatures: Array.from(completedNativeToolStrategy.completedSignatures),
              rccTextTools: (args.rccTextTools || []).map((tool) => {
                const fn = tool && typeof tool === 'object' && !Array.isArray(tool) ? tool.function as Record<string, unknown> | undefined : undefined;
                return typeof fn?.name === 'string' ? fn.name : '';
              }).filter(Boolean),
            });
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
            continue;
          }
          const candidate = args.parseAssistantTurn({
            role: 'assistant',
            content: finalContent,
            ...(finalReasoning ? { reasoning_content: finalReasoning } : {}),
          }, args.rccTextTools || []);
          if (!usage) {
            args.logStage('poll.generatorMetadata.optional_missing', {
              cascadeId: args.cascadeId,
              offset: generatorMetadataOffset,
              reason: 'stream_completed_without_usage',
            });
          }
          return { candidate, usage };
        }
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw args.createError('[windsurf] GetCascadeTrajectorySteps poll timeout', {
      code: 'WINDSURF_FETCH_TIMEOUT',
      status: 504,
      retryable: true,
    });
  } catch (error) {
    throw args.handleTransportFailure(error);
  }
}
