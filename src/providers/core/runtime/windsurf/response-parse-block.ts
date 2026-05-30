import { randomUUID } from 'crypto';
import { Transform } from 'node:stream';
import { gunzipSync } from 'node:zlib';

type WindsurfErrorFactory = (message: string, fields?: Record<string, unknown>) => Error;

export type WindsurfFailureClass = {
  code: string;
  retryable: boolean;
  status: number;
  upstreamCode?: string;
  upstreamStatus?: number;
  upstreamMessage?: string;
  parseReason?: string;
  rateLimitKind?: 'daily_limit' | 'short_lived';
  cooldownOverrideMs?: number;
  quotaScope?: 'weekly' | 'model';
  quotaReason?: string;
};

export type WindsurfCascadeCompletionUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

export type WindsurfCascadeCompletionBuildArgs = {
  model: string;
  candidate: unknown;
  usage?: WindsurfCascadeCompletionUsage | null;
  parseAssistantTurn: (candidate: unknown) => Record<string, unknown>;
};

export type WindsurfNormalizedUsageRecord = {
  prompt_tokens: number;
  completion_tokens: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  prompt_tokens_details: { cached_tokens: number };
  input_tokens_details: { cached_tokens: number };
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cascade_breakdown: {
    fresh_input_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    output_tokens: number;
  };
};

export type WindsurfUsageNormalizationResult =
  | { ok: true; usage: WindsurfNormalizedUsageRecord }
  | { ok: false; reason: 'missing_usage_object' };

export type ProtoField = {
  fieldNo: number;
  wireType: number;
  value: number | Uint8Array;
};

export type WindsurfConnectFramePayloadParseResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: Error & Record<string, unknown> };

export type WindsurfCompletionDeltaProtoParseResult =
  | { ok: true; payload: Record<string, unknown> }
  | {
      ok: false;
      reason:
        | 'empty_proto_fields'
        | 'malformed_proto_varint'
        | 'malformed_proto_field_length'
        | 'malformed_proto_field_range'
        | 'unsupported_proto_wire_type'
        | 'empty_completion_delta_signal'
        | 'malformed_usage_proto';
    };

export type WindsurfProtoFieldParseResult =
  | { ok: true; fields: ProtoField[] }
  | {
      ok: false;
      reason:
        | 'malformed_proto_varint'
        | 'malformed_proto_field_length'
        | 'malformed_proto_field_range'
        | 'unsupported_proto_wire_type';
    };

export type WindsurfProtoVarintDecodeResult =
  | { ok: true; value: number; consumed: number }
  | { ok: false; reason: 'malformed_proto_varint' };

export type WindsurfProtoVarintLegacyDecodeResult =
  | { ok: true; value: number; consumed: number }
  | { ok: false; reason: 'malformed_proto_varint' };

export type WindsurfUsageStatsParseResult =
  | {
      ok: true;
      usage: {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
      };
    }
  | {
      ok: false;
      reason:
        | 'empty_proto_fields'
        | 'malformed_proto_varint'
        | 'malformed_proto_field_length'
        | 'malformed_proto_field_range'
        | 'unsupported_proto_wire_type';
    };

export type WindsurfUsageStatsLegacyParseResult =
  | {
      ok: true;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    }
  | {
      ok: false;
      reason:
        | 'empty_proto_fields'
        | 'malformed_proto_varint'
        | 'malformed_proto_field_length'
        | 'malformed_proto_field_range'
        | 'unsupported_proto_wire_type';
    };

export type WindsurfGeneratorMetadataParseResult =
  | {
      ok: true;
      usage: {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        entryCount: number;
      };
    }
  | {
      ok: false;
      reason:
        | 'empty_meta_entries'
        | 'missing_usage_entries'
        | 'malformed_meta_entry'
        | 'malformed_usage_proto';
    };

export type WindsurfStartCascadeResponseParseResult =
  | { ok: true; cascadeId: string }
  | {
      ok: false;
      reason:
        | 'malformed_proto_varint'
        | 'malformed_proto_field_length'
        | 'malformed_proto_field_range'
        | 'unsupported_proto_wire_type'
        | 'missing_cascade_id';
    };

export type WindsurfTrajectoryStatusParseResult =
  | { ok: true; status: number }
  | {
      ok: false;
      reason:
        | 'malformed_proto_varint'
        | 'malformed_proto_field_length'
        | 'malformed_proto_field_range'
        | 'unsupported_proto_wire_type'
        | 'missing_status';
    };

export type WindsurfTrajectoryStepsParseResult =
  | { ok: true; steps: Array<Record<string, unknown>> }
  | {
      ok: false;
      reason:
        | 'malformed_proto_varint'
        | 'malformed_proto_field_length'
        | 'malformed_proto_field_range'
        | 'unsupported_proto_wire_type'
        | 'malformed_step_envelope'
        | 'malformed_tool_call'
        | 'malformed_error_details'
        | 'malformed_native_step'
        | 'malformed_native_run_command_result'
        | 'malformed_planner_step'
        | 'malformed_step_meta'
        | 'malformed_step_error_wrapper'
        | 'malformed_usage_proto';
    };

function defaultWindsurfConnectFrameError(message: string, fields: Record<string, unknown> = {}): Error {
  const error = new Error(message) as Error & Record<string, unknown>;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) error[key] = value;
  }
  return error;
}

export function parseWindsurfConnectFramePayloadText(args: {
  payloadText: string;
  createFrameError?: WindsurfErrorFactory;
}): WindsurfConnectFramePayloadParseResult {
  const createFrameError = args.createFrameError || defaultWindsurfConnectFrameError;
  try {
    const parsed = JSON.parse(args.payloadText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        ok: false,
        error: createFrameError('[windsurf] malformed SSE connect frame: expected JSON object payload', {
          code: 'WINDSURF_SSE_MALFORMED_FRAME',
          status: 502,
          retryable: true,
        }) as Error & Record<string, unknown>,
      };
    }
    return {
      ok: true,
      payload: parsed as Record<string, unknown>,
    };
  } catch (error) {
    return {
      ok: false,
      error: createFrameError(`[windsurf] malformed SSE connect frame: ${error instanceof Error ? error.message : String(error)}`, {
        code: 'WINDSURF_SSE_MALFORMED_FRAME',
        status: 502,
        retryable: true,
      }) as Error & Record<string, unknown>,
    };
  }
}

export function parseWindsurfConnectFramePayloadTextOrThrow(args: {
  payloadText: string;
  createFrameError?: WindsurfErrorFactory;
}): Record<string, unknown> {
  const result = parseWindsurfConnectFramePayloadText(args);
  if (result.ok) {
    return result.payload;
  }
  throw result.error;
}

export function computeWindsurfQuotaCooldownUntilNextMidnightMs(nowMs = Date.now()): number {
  const now = Number.isFinite(nowMs) && nowMs > 0 ? nowMs : Date.now();
  const d = new Date(now);
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
  const ttl = next - now;
  return Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : 24 * 60 * 60_000;
}

export function attachWindsurfErrorFields(target: Error & Record<string, unknown>, c: WindsurfFailureClass): void {
  target.code = c.code;
  target.status = c.status;
  target.retryable = c.retryable;
  target.upstreamCode = c.upstreamCode || c.code;
  if (typeof c.upstreamStatus === 'number' && Number.isFinite(c.upstreamStatus)) {
    target.upstreamStatus = c.upstreamStatus;
  }
  if (typeof c.parseReason === 'string' && c.parseReason.trim()) {
    target.parseReason = c.parseReason.trim();
  }
  target.providerFamily = 'windsurf';
  target.type = 'windsurf_upstream_error';
  if (c.rateLimitKind) target.rateLimitKind = c.rateLimitKind;
  if (typeof c.cooldownOverrideMs === 'number' && Number.isFinite(c.cooldownOverrideMs) && c.cooldownOverrideMs > 0) {
    target.cooldownOverrideMs = c.cooldownOverrideMs;
  }
  if (c.quotaScope) target.quotaScope = c.quotaScope;
  if (c.quotaReason) target.quotaReason = c.quotaReason;
}

/**
 * Transform connect-framed Windsurf streaming responses into OpenAI-compatible SSE.
 */
export class WindsurfConnectSseTransform extends Transform {
  private buffer = Buffer.alloc(0);
  private seq = 0;
  private doneEmitted = false;
  private frameError: Error | null = null;
  private readonly createFrameError: WindsurfErrorFactory;

  constructor(createFrameError: WindsurfErrorFactory = defaultWindsurfConnectFrameError) {
    super();
    this.createFrameError = createFrameError;
  }

  override _transform(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    this.buffer = Buffer.concat([this.buffer, buf]);
    this.flushFrames();
    if (this.frameError) {
      callback(this.frameError);
      return;
    }
    callback();
  }

  override _flush(callback: (error?: Error | null) => void): void {
    this.flushFrames();
    if (this.frameError) {
      callback(this.frameError);
      return;
    }
    if (!this.doneEmitted) {
      this.doneEmitted = true;
      this.push('data: [DONE]\n\n');
    }
    callback();
  }

  private flushFrames(): void {
    while (!this.frameError && this.buffer.length >= 5) {
      const flags = this.buffer[0]!;
      const len = this.buffer.readUInt32BE(1);
      const total = 5 + len;
      if (this.buffer.length < total) break;

      const payloadBytes = this.buffer.subarray(5, total);
      this.buffer = this.buffer.subarray(total);

      const payloadText = payloadBytes.toString('utf8').trim();
      if (!payloadText) continue;

      const parsedPayload = parseWindsurfConnectFramePayloadText({
        payloadText,
        createFrameError: this.createFrameError,
      });
      if (!parsedPayload.ok) {
        this.frameError = parsedPayload.error;
        return;
      }
      const payload = parsedPayload.payload;

      const isTerminal = (flags & 0x02) !== 0;
      this.seq++;
      const chunkId = `chatcmpl-${randomUUID().slice(0, 8)}-${this.seq}`;

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

      const rawUsage = (payload.usage || payload.modelUsage || payload.model_usage) as Record<string, unknown> | null;
      const inputTokens = typeof rawUsage?.inputTokens === 'number' ? (rawUsage as Record<string, number>).inputTokens
        : typeof rawUsage?.input_tokens === 'number' ? Number((rawUsage as Record<string, number>).input_tokens) : 0;
      const outputTokens = typeof rawUsage?.outputTokens === 'number' ? (rawUsage as Record<string, number>).outputTokens
        : typeof rawUsage?.output_tokens === 'number' ? Number((rawUsage as Record<string, number>).output_tokens) : 0;
      const cachedTokens = typeof rawUsage?.cacheReadTokens === 'number' ? (rawUsage as Record<string, number>).cacheReadTokens
        : typeof rawUsage?.cache_read_tokens === 'number' ? Number((rawUsage as Record<string, number>).cache_read_tokens) : 0;

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

      const sseChunk = {
        id: chunkId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: typeof payload.model === 'string' ? payload.model : '',
        choices: [{ index: 0, delta, finish_reason: null }],
      };
      this.push(`data: ${JSON.stringify(sseChunk)}\n\n`);

      if (isTerminal && !this.doneEmitted) {
        this.doneEmitted = true;
        const normalizedUsage = normalizeWindsurfUsageRecord({
          inputTokens,
          outputTokens,
          cacheReadTokens: cachedTokens,
          cacheWriteTokens: 0,
        });
        if (normalizedUsage) {
          this.push(`data: ${JSON.stringify({
            id: chunkId,
            object: 'chat.completion.chunk',
            created: sseChunk.created,
            model: sseChunk.model,
            choices: [],
            usage: normalizedUsage,
          })}\n\n`);
        }
        this.push('data: [DONE]\n\n');
      }
    }
  }
}

export function decodeProtoVarintDetailed(bytes: Uint8Array, start: number): WindsurfProtoVarintDecodeResult {
  let result = 0;
  let shift = 0;
  for (let index = start; index < bytes.length; index += 1) {
    const byte = bytes[index]!;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { ok: true, value: result, consumed: index - start + 1 };
    }
    shift += 7;
    if (shift > 35) {
      return { ok: false, reason: 'malformed_proto_varint' };
    }
  }
  return { ok: false, reason: 'malformed_proto_varint' };
}

export function decodeProtoVarint(bytes: Uint8Array, start: number): { value: number; consumed: number } | null {
  const result = decodeProtoVarintDetailed(bytes, start);
  return result.ok ? { value: result.value, consumed: result.consumed } : null;
}

export function decodeProtoVarintResult(bytes: Uint8Array, start: number): WindsurfProtoVarintLegacyDecodeResult {
  const result = decodeProtoVarintDetailed(bytes, start);
  return result.ok
    ? { ok: true, value: result.value, consumed: result.consumed }
    : result;
}

export function parseProtoFieldsDetailed(bytes: Uint8Array): WindsurfProtoFieldParseResult {
  const fields: ProtoField[] = [];
  let index = 0;
  while (index < bytes.length) {
    const tag = decodeProtoVarintDetailed(bytes, index);
    if (!tag.ok) {
      return { ok: false, reason: tag.reason };
    }
    index += tag.consumed;
    const fieldNo = tag.value >> 3;
    const wireType = tag.value & 0x7;
    if (wireType === 0) {
      const parsed = decodeProtoVarintDetailed(bytes, index);
      if (!parsed.ok) {
        return { ok: false, reason: parsed.reason };
      }
      index += parsed.consumed;
      fields.push({ fieldNo, wireType, value: parsed.value });
      continue;
    }
    if (wireType === 2) {
      const len = decodeProtoVarintDetailed(bytes, index);
      if (!len.ok) {
        return { ok: false, reason: 'malformed_proto_field_length' };
      }
      index += len.consumed;
      const end = index + len.value;
      if (end > bytes.length) {
        return { ok: false, reason: 'malformed_proto_field_range' };
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
    return { ok: false, reason: 'unsupported_proto_wire_type' };
  }
  return { ok: true, fields };
}

export function parseProtoFields(bytes: Uint8Array): ProtoField[] {
  const result = parseProtoFieldsDetailed(bytes);
  return result.ok ? result.fields : [];
}

export function getProtoField(fields: ProtoField[], fieldNo: number, wireType?: number): ProtoField | null {
  for (const field of fields) {
    if (field.fieldNo === fieldNo && (wireType === undefined || field.wireType === wireType)) {
      return field;
    }
  }
  return null;
}

export function getAllProtoFields(fields: ProtoField[], fieldNo: number, wireType?: number): ProtoField[] {
  return fields.filter((field) => field.fieldNo === fieldNo && (wireType === undefined || field.wireType === wireType));
}

export function readProtoString(fields: ProtoField[], fieldNo: number): string {
  const field = getProtoField(fields, fieldNo, 2);
  return field && field.value instanceof Uint8Array ? Buffer.from(field.value).toString('utf8') : '';
}

export function readProtoNumber(fields: ProtoField[], fieldNo: number): number | undefined {
  const field = getProtoField(fields, fieldNo, 0);
  return field && typeof field.value === 'number' ? Number(field.value) : undefined;
}

export function parseWindsurfModelUsageStatsDetailed(bytes: Uint8Array): WindsurfUsageStatsParseResult {
  const parsed = parseProtoFieldsDetailed(bytes);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason };
  }
  if (!parsed.fields.length) {
    return { ok: false, reason: 'empty_proto_fields' };
  }
  return {
    ok: true,
    usage: {
      inputTokens: readProtoNumber(parsed.fields, 2),
      outputTokens: readProtoNumber(parsed.fields, 3),
      cacheWriteTokens: readProtoNumber(parsed.fields, 4),
      cacheReadTokens: readProtoNumber(parsed.fields, 5),
    },
  };
}

export function parseWindsurfModelUsageStats(bytes: Uint8Array): WindsurfUsageStatsLegacyParseResult {
  const result = parseWindsurfModelUsageStatsDetailed(bytes);
  return result.ok ? { ok: true as const, ...result.usage } : result;
}

export function parseStartCascadeResponseDetailed(bytes: Uint8Array): WindsurfStartCascadeResponseParseResult {
  const parsed = parseProtoFieldsDetailed(bytes);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason };
  }
  const cascadeId = readProtoString(parsed.fields, 1).trim();
  if (!cascadeId) {
    return { ok: false, reason: 'missing_cascade_id' };
  }
  return { ok: true, cascadeId };
}

export function parseStartCascadeResponse(bytes: Uint8Array): string {
  const result = parseStartCascadeResponseDetailed(bytes);
  return result.ok ? result.cascadeId : '';
}

export function parseTrajectoryStatusDetailed(bytes: Uint8Array): WindsurfTrajectoryStatusParseResult {
  const parsed = parseProtoFieldsDetailed(bytes);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason };
  }
  const status = readProtoNumber(parsed.fields, 2);
  if (typeof status !== 'number') {
    return { ok: false, reason: 'missing_status' };
  }
  return { ok: true, status };
}

export function parseTrajectoryStatus(bytes: Uint8Array): number {
  const result = parseTrajectoryStatusDetailed(bytes);
  return result.ok ? result.status : 0;
}

export function parseGeneratorMetadataDetailed(bytes: Uint8Array): WindsurfGeneratorMetadataParseResult {
  const parsedTop = parseProtoFieldsDetailed(bytes);
  if (!parsedTop.ok) {
    return { ok: false, reason: 'malformed_meta_entry' };
  }
  const fields = parsedTop.fields;
  const metaEntries = getAllProtoFields(fields, 1, 2);
  if (metaEntries.length === 0) {
    return { ok: false, reason: 'empty_meta_entries' };
  }
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let found = false;
  for (const entry of metaEntries) {
    const gmParsed = parseProtoFieldsDetailed(entry.value as Uint8Array);
    if (!gmParsed.ok) {
      return { ok: false, reason: 'malformed_meta_entry' };
    }
    const gm = gmParsed.fields;
    const chatModelField = getProtoField(gm, 1, 2);
    if (!chatModelField || !(chatModelField.value instanceof Uint8Array)) continue;
    const chatModelParsed = parseProtoFieldsDetailed(chatModelField.value);
    if (!chatModelParsed.ok) {
      return { ok: false, reason: 'malformed_meta_entry' };
    }
    const chatModelFields = chatModelParsed.fields;
    const usageField = getProtoField(chatModelFields, 4, 2);
    if (!usageField || !(usageField.value instanceof Uint8Array)) continue;
    const usage = parseWindsurfModelUsageStatsDetailed(usageField.value);
    if (!usage.ok) {
      return { ok: false, reason: 'malformed_usage_proto' };
    }
    inputTokens += typeof usage.usage.inputTokens === 'number' ? usage.usage.inputTokens : 0;
    outputTokens += typeof usage.usage.outputTokens === 'number' ? usage.usage.outputTokens : 0;
    cacheReadTokens += typeof usage.usage.cacheReadTokens === 'number' ? usage.usage.cacheReadTokens : 0;
    cacheWriteTokens += typeof usage.usage.cacheWriteTokens === 'number' ? usage.usage.cacheWriteTokens : 0;
    found = true;
  }
  if (!found) {
    return { ok: false, reason: 'missing_usage_entries' };
  }
  return {
    ok: true,
    usage: {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      entryCount: metaEntries.length,
    },
  };
}

export function parseGeneratorMetadata(bytes: Uint8Array): ({ inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; entryCount: number }) | null {
  const result = parseGeneratorMetadataDetailed(bytes);
  return result.ok ? result.usage : null;
}

export function parseGeneratorMetadataOrThrow(bytes: Uint8Array): { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; entryCount: number } {
  const result = parseGeneratorMetadataDetailed(bytes);
  if (result.ok) {
    return result.usage;
  }
  throw Object.assign(new Error(`[windsurf] generator metadata parse failed: ${result.reason}`), {
    code: 'WINDSURF_GENERATOR_METADATA_PARSE_FAILED',
    status: 502,
    retryable: true,
    parseReason: result.reason,
  });
}

export function parseGeneratorMetadataResult(bytes: Uint8Array): WindsurfGeneratorMetadataParseResult {
  return parseGeneratorMetadataDetailed(bytes);
}

type WindsurfCascadeToolStepKind =
  | 'view_file'
  | 'run_command'
  | 'find'
  | 'grep_search_v2'
  | 'list_directory'
  | 'write_to_file'
  | 'grep_search'
  | 'read_url_content'
  | 'search_web';

export function parseTrajectoryStepsDetailed(args: {
  bytes: Uint8Array;
  stableStringify: (value: unknown) => string;
}): WindsurfTrajectoryStepsParseResult {
  const parsedTop = parseProtoFieldsDetailed(args.bytes);
  if (!parsedTop.ok) {
    return { ok: false, reason: parsedTop.reason };
  }
  const fields = parsedTop.fields;
  const steps = getAllProtoFields(fields, 1, 2);
  const out: Array<Record<string, unknown>> = [];

  const parseChatToolCall = (buf: Uint8Array): { ok: true; toolCall: Record<string, unknown> } | { ok: false; reason: string } => {
    const callParsed = parseProtoFieldsDetailed(buf);
    if (!callParsed.ok) return { ok: false, reason: callParsed.reason };
    const callFields = callParsed.fields;
    return {
      ok: true,
      toolCall: {
        id: readProtoString(callFields, 1),
        name: readProtoString(callFields, 2),
        argumentsJson: readProtoString(callFields, 3),
      },
    };
  };

  const readErrorDetails = (buf: Uint8Array): { ok: true; text: string } | { ok: false; reason: string } => {
    const detailsParsed = parseProtoFieldsDetailed(buf);
    if (!detailsParsed.ok) return { ok: false, reason: detailsParsed.reason };
    const details = detailsParsed.fields;
    for (const fieldNo of [1, 2, 3]) {
      const field = getProtoField(details, fieldNo, 2);
      if (!field || !(field.value instanceof Uint8Array)) continue;
      const text = Buffer.from(field.value).toString('utf8').trim();
      if (text) return { ok: true, text: text.split('\n')[0]!.slice(0, 300) };
    }
    return { ok: true, text: '' };
  };

  for (const step of steps) {
    const stepParsed = parseProtoFieldsDetailed(step.value as Uint8Array);
    if (!stepParsed.ok) {
      return { ok: false, reason: 'malformed_step_envelope' };
    }
    const sf = stepParsed.fields;
    const type = readProtoNumber(sf, 1) ?? 0;
    const status = readProtoNumber(sf, 4) ?? 0;
    const plannerField = getProtoField(sf, 20, 2);
    const row: Record<string, unknown> = {
      type,
      status,
      text: '',
      thinking: '',
      errorText: '',
      toolCalls: [],
      usage: null,
    };

    const stepMetaField = getProtoField(sf, 5, 2);
    if (stepMetaField) {
      const metaParsed = parseProtoFieldsDetailed(stepMetaField.value as Uint8Array);
      if (!metaParsed.ok) {
        return { ok: false, reason: 'malformed_step_meta' };
      }
      const meta = metaParsed.fields;
      const usageField = getProtoField(meta, 9, 2);
      if (usageField) {
        const usage = parseWindsurfModelUsageStats(usageField.value as Uint8Array);
        if (!usage.ok) {
          return { ok: false, reason: 'malformed_usage_proto' };
        }
        row.usage = {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
        };
      }
    }

    const customField = getProtoField(sf, 45, 2);
    if (customField) {
      const customParsed = parseProtoFieldsDetailed(customField.value as Uint8Array);
      if (!customParsed.ok) {
        return { ok: false, reason: 'malformed_tool_call' };
      }
      const cf = customParsed.fields;
      (row.toolCalls as Array<Record<string, unknown>>).push({
        id: readProtoString(cf, 1),
        name: readProtoString(cf, 4) || readProtoString(cf, 1) || 'custom_tool',
        argumentsJson: readProtoString(cf, 2),
        result: readProtoString(cf, 3),
      });
    }

    const mcpField = getProtoField(sf, 47, 2);
    if (mcpField) {
      const mcpParsed = parseProtoFieldsDetailed(mcpField.value as Uint8Array);
      if (!mcpParsed.ok) {
        return { ok: false, reason: 'malformed_tool_call' };
      }
      const mf = mcpParsed.fields;
      const callField = getProtoField(mf, 2, 2);
      if (callField) {
        const toolCall = parseChatToolCall(callField.value as Uint8Array);
        if (!toolCall.ok) {
          return { ok: false, reason: 'malformed_tool_call' };
        }
        toolCall.toolCall.serverName = readProtoString(mf, 1);
        toolCall.toolCall.result = readProtoString(mf, 3);
        (row.toolCalls as Array<Record<string, unknown>>).push(toolCall.toolCall);
      }
    }

    const proposalField = getProtoField(sf, 49, 2);
    if (proposalField) {
      const proposalParsed = parseProtoFieldsDetailed(proposalField.value as Uint8Array);
      if (!proposalParsed.ok) {
        return { ok: false, reason: 'malformed_tool_call' };
      }
      const pf = proposalParsed.fields;
      const callField = getProtoField(pf, 1, 2);
      if (callField) {
        const toolCall = parseChatToolCall(callField.value as Uint8Array);
        if (!toolCall.ok) {
          return { ok: false, reason: 'malformed_tool_call' };
        }
        (row.toolCalls as Array<Record<string, unknown>>).push(toolCall.toolCall);
      }
    }

    const choiceField = getProtoField(sf, 50, 2);
    if (choiceField) {
      const choiceParsed = parseProtoFieldsDetailed(choiceField.value as Uint8Array);
      if (!choiceParsed.ok) {
        return { ok: false, reason: 'malformed_tool_call' };
      }
      const cf = choiceParsed.fields;
      const calls: Array<Record<string, unknown>> = [];
      for (const field of getAllProtoFields(cf, 1, 2)) {
        const toolCall = parseChatToolCall(field.value as Uint8Array);
        if (!toolCall.ok) {
          return { ok: false, reason: 'malformed_tool_call' };
        }
        calls.push(toolCall.toolCall);
      }
      if (calls.length > 0) {
        const chosenIndex = readProtoNumber(cf, 2) ?? 0;
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
      const nativeField = getProtoField(sf, fieldNo, 2);
      if (!nativeField) continue;
      const bodyParsed = parseProtoFieldsDetailed(nativeField.value as Uint8Array);
      if (!bodyParsed.ok) {
        return { ok: false, reason: 'malformed_native_step' };
      }
      const body = bodyParsed.fields;
      let argumentsJson = '';
      let result = '';
      try {
        if (kind === 'view_file') {
          argumentsJson = args.stableStringify({
            absolute_path_uri: readProtoString(body, 1),
            offset: readProtoNumber(body, 11) ?? 0,
            limit: readProtoNumber(body, 12) ?? 0,
            start_line: readProtoNumber(body, 2) ?? 0,
            end_line: readProtoNumber(body, 3) ?? 0,
          });
          result = readProtoString(body, 4);
        } else if (kind === 'run_command') {
          argumentsJson = args.stableStringify({
            command_line: readProtoString(body, 23) || readProtoString(body, 1),
            cwd: readProtoString(body, 2),
          });
          const combined = getProtoField(body, 21, 2);
          if (combined) {
            const combinedParsed = parseProtoFieldsDetailed(combined.value as Uint8Array);
            if (!combinedParsed.ok) {
              return { ok: false, reason: 'malformed_native_run_command_result' };
            }
            result = readProtoString(combinedParsed.fields, 1);
          }
          if (!result) {
            const stdout = readProtoString(body, 4);
            const stderr = readProtoString(body, 5);
            result = stdout + (stderr ? `\n[stderr]\n${stderr}` : '');
          }
        } else if (kind === 'grep_search_v2') {
          argumentsJson = args.stableStringify({
            pattern: readProtoString(body, 2),
            path: readProtoString(body, 3),
            glob: readProtoString(body, 4),
            output_mode: readProtoString(body, 5),
            head_limit: readProtoNumber(body, 12) ?? 0,
          });
          result = readProtoString(body, 15);
        } else if (kind === 'grep_search') {
          argumentsJson = args.stableStringify({
            query: readProtoString(body, 1),
            search_path_uri: readProtoString(body, 11),
          });
          result = readProtoString(body, 3);
        } else if (kind === 'find') {
          argumentsJson = args.stableStringify({
            pattern: readProtoString(body, 1),
            search_directory: readProtoString(body, 10),
          });
          result = readProtoString(body, 11);
        } else if (kind === 'list_directory') {
          argumentsJson = args.stableStringify({ directory_path_uri: readProtoString(body, 1) });
          result = getAllProtoFields(body, 2, 2)
            .map((field) => Buffer.from(field.value as Uint8Array).toString('utf8'))
            .join('\n');
        } else if (kind === 'write_to_file') {
          argumentsJson = args.stableStringify({
            target_file_uri: readProtoString(body, 1),
            code_content: getAllProtoFields(body, 2, 2).map((field) => Buffer.from(field.value as Uint8Array).toString('utf8')),
          });
        } else if (kind === 'search_web') {
          argumentsJson = args.stableStringify({ query: readProtoString(body, 1) });
          result = readProtoString(body, 5);
        } else if (kind === 'read_url_content') {
          argumentsJson = args.stableStringify({ url: readProtoString(body, 1) });
          result = readProtoString(body, 5);
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
      const plannerParsed = parseProtoFieldsDetailed(plannerField.value as Uint8Array);
      if (!plannerParsed.ok) {
        return { ok: false, reason: 'malformed_planner_step' };
      }
      const pf = plannerParsed.fields;
      const responseText = readProtoString(pf, 1);
      const modifiedText = readProtoString(pf, 8);
      row.text = modifiedText || responseText;
      row.responseText = responseText;
      row.modifiedText = modifiedText;
      row.thinking = readProtoString(pf, 3);
    }

    const errMsgField = getProtoField(sf, 24, 2);
    if (errMsgField) {
      const errParsed = parseProtoFieldsDetailed(errMsgField.value as Uint8Array);
      if (!errParsed.ok) {
        return { ok: false, reason: 'malformed_step_error_wrapper' };
      }
      const errInner = getProtoField(errParsed.fields, 3, 2);
      if (errInner) {
        const errorText = readErrorDetails(errInner.value as Uint8Array);
        if (!errorText.ok) {
          return { ok: false, reason: 'malformed_error_details' };
        }
        row.errorText = errorText.text;
      }
    }
    if (!row.errorText) {
      const errField = getProtoField(sf, 31, 2);
      if (errField) {
        const errorText = readErrorDetails(errField.value as Uint8Array);
        if (!errorText.ok) {
          return { ok: false, reason: 'malformed_error_details' };
        }
        row.errorText = errorText.text;
      }
    }

    out.push(row);
  }
  return { ok: true, steps: out };
}

export function parseTrajectorySteps(args: {
  bytes: Uint8Array;
  stableStringify: (value: unknown) => string;
}): Array<Record<string, unknown>> {
  const result = parseTrajectoryStepsDetailed(args);
  if (!result.ok) {
    throw new Error(`[windsurf] malformed trajectory steps proto: ${result.reason}`);
  }
  return result.steps;
}

export type WindsurfResponseMeta = {
  contentType?: string;
  contentEncoding?: string;
  prefixHex?: string;
  totalBytes?: number;
};

export function readWindsurfResponseMeta(response: unknown, body: Buffer): WindsurfResponseMeta {
  const headers = (response && typeof response === 'object' && 'headers' in (response as Record<string, unknown>))
    ? (response as { headers?: unknown }).headers
    : null;
  const getHeader = (name: string): string | undefined => {
    if (!headers) return undefined;
    const normalized = name.toLowerCase();
    const source = headers as { get?: (name: string) => string | null; [key: string]: unknown };
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

export function maybeDecodeHttpContentEncoding(args: {
  body: Buffer;
  encoding?: string;
  createError: (message: string, fields?: Record<string, unknown>) => Error;
}): Buffer {
  const normalized = typeof args.encoding === 'string' ? args.encoding.trim().toLowerCase() : '';
  if (!normalized || normalized === 'identity') return args.body;
  if (normalized.includes('gzip')) {
    try {
      return gunzipSync(args.body);
    } catch (error) {
      throw args.createError(`[windsurf] failed to gunzip upstream response body: ${error instanceof Error ? error.message : String(error)}`, {
        code: 'WINDSURF_RESPONSE_PARSE_FAILED',
        status: 502,
        retryable: false,
      });
    }
  }
  return args.body;
}

export function buildWindsurfConnectFrameErrorMessage(base: string, details: Record<string, unknown>): string {
  const compact = Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
  return compact ? `${base} (${compact})` : base;
}

export function classifyWindsurfUpstreamPayloadError(payloadError: Record<string, unknown>): Partial<WindsurfFailureClass> {
  const rawUpstreamCode = payloadError.code;
  const upstreamCode = typeof rawUpstreamCode === 'string'
    ? rawUpstreamCode.trim()
    : typeof rawUpstreamCode === 'number' && Number.isFinite(rawUpstreamCode)
      ? String(rawUpstreamCode)
      : undefined;
  const upstreamStatus = typeof rawUpstreamCode === 'number' && Number.isFinite(rawUpstreamCode) ? rawUpstreamCode : undefined;
  const errorCodeText = typeof payloadError.code === 'string' ? payloadError.code.trim().toLowerCase() : '';
  const errorMessage = String(payloadError.message || 'windsurf upstream error');
  const normalizedMessage = errorMessage.toLowerCase();
  const looksLikeInternalError = normalizedMessage.includes('an internal error occurred') || normalizedMessage.includes('internal error occurred');
  const looksLikePolicyBlocked = /cyber\s*verification|content[\s_-]+policy|policy[\s_-]+(?:violation|blocked|denied)|safety[\s_-]+(?:policy|blocked)|prompt[\s_-]+(?:rejected|blocked)\s+by[\s_-]+policy|usage[\s_-]+policy[\s_-]+violation/i.test(errorMessage);
  const looksLikeCascadeBusy = normalizedMessage.includes('cascade_run_status_running') || normalizedMessage.includes('executor is not idle');
  const looksLikeTransportTransient = normalizedMessage.includes('err_http2') || normalizedMessage.includes('pending stream has been canceled') || normalizedMessage.includes('stream cancel') || normalizedMessage.includes('stream closed') || normalizedMessage.includes('session closed') || normalizedMessage.includes('econnreset') || normalizedMessage.includes('econnrefused') || normalizedMessage.includes('connect');
  const isTrueRateLimit = errorCodeText === 'resource_exhausted' && !looksLikeInternalError;
  if (looksLikePolicyBlocked) return { code: 'WINDSURF_POLICY_BLOCKED', status: 451, retryable: false, upstreamCode, upstreamStatus };
  if (looksLikeCascadeBusy) return { code: 'WINDSURF_CASCADE_BUSY', status: 429, retryable: true, upstreamCode, upstreamStatus, rateLimitKind: 'short_lived' };
  if (looksLikeInternalError || looksLikeTransportTransient) return { code: 'WINDSURF_UPSTREAM_TRANSIENT', status: 502, retryable: true, upstreamCode, upstreamStatus };
  return {
    code: isTrueRateLimit ? 'WINDSURF_RATE_LIMITED' : 'WINDSURF_SERVICE_UNREACHABLE',
    status: isTrueRateLimit ? 429 : 503,
    retryable: isTrueRateLimit ? false : true,
    upstreamCode,
    upstreamStatus,
    rateLimitKind: isTrueRateLimit ? 'short_lived' : undefined,
    cooldownOverrideMs: undefined,
    quotaScope: isTrueRateLimit ? 'model' : undefined,
    quotaReason: isTrueRateLimit ? 'windsurf_model_rate_limited' : undefined,
  };
}

export function extractFunctionCallOutputRows(candidate: unknown): Array<Record<string, unknown>> {
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

export function buildCascadeCompletionFromOutput(args: WindsurfCascadeCompletionBuildArgs): Record<string, unknown> {
  const candidate = args.candidate;
  if (!candidate || typeof candidate !== 'object') throw new Error('[windsurf] empty cascade candidate payload');
  const parsed = args.parseAssistantTurn(candidate);
  const toolCalls = Array.isArray(parsed.tool_calls) ? parsed.tool_calls as unknown[] : [];
  const parsedContent = typeof parsed.content === 'string' ? parsed.content : '';
  const parsedReasoning = typeof parsed.reasoning_content === 'string' ? parsed.reasoning_content : '';
  if (toolCalls.length === 0 && !parsedContent.trim() && parsedReasoning.trim() && !/thinking/i.test(String(args.model || ''))) parsed.content = parsedReasoning;
  const usage = args.usage && typeof args.usage === 'object' ? args.usage : null;
  const normalizedUsage = normalizeWindsurfUsageRecordDetailed(usage);
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: args.model,
    choices: [{ index: 0, message: parsed, finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop' }],
    ...(toolCalls.length === 0 ? { tool_outputs: extractFunctionCallOutputRows(candidate) } : {}),
    ...(normalizedUsage.ok ? { usage: normalizedUsage.usage } : {}),
  };
}

export function normalizeWindsurfUsageRecordDetailed(
  usage: WindsurfCascadeCompletionUsage | null | undefined
): WindsurfUsageNormalizationResult {
  if (!usage || typeof usage !== 'object') {
    return { ok: false, reason: 'missing_usage_object' };
  }
  const inputTokens = typeof usage.inputTokens === 'number' ? usage.inputTokens : 0;
  const outputTokens = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0;
  const cacheReadTokens = typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0;
  const cacheWriteTokens = typeof usage.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : 0;
  const promptTokens = inputTokens + cacheReadTokens;
  const totalTokens = promptTokens + outputTokens + cacheWriteTokens;
  return {
    ok: true,
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: outputTokens,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
      prompt_tokens_details: { cached_tokens: cacheReadTokens },
      input_tokens_details: { cached_tokens: cacheReadTokens },
      cache_creation_input_tokens: cacheWriteTokens,
      cache_read_input_tokens: cacheReadTokens,
      cascade_breakdown: {
        fresh_input_tokens: inputTokens,
        cache_read_tokens: cacheReadTokens,
        cache_write_tokens: cacheWriteTokens,
        output_tokens: outputTokens,
      },
    },
  };
}

export function normalizeWindsurfUsageRecord(
  usage: WindsurfCascadeCompletionUsage | null | undefined
): WindsurfNormalizedUsageRecord | null {
  const result = normalizeWindsurfUsageRecordDetailed(usage);
  return result.ok ? result.usage : null;
}

export function classifyWindsurfCascadeError(error: unknown): Error {
  const source = error instanceof Error ? error : new Error(String(error));
  const structured = source as Error & Record<string, unknown>;
  const isAlreadyStructured = typeof structured.code === 'string' && typeof structured.status === 'number' && typeof structured.retryable === 'boolean';
  const normalizedSourceMessage = source.message.toLowerCase();
  const isStructuredWeeklyQuota = normalizedSourceMessage.includes('weekly usage quota has been exhausted') || normalizedSourceMessage.includes('weekly quota has been exhausted') || normalizedSourceMessage.includes('weekly usage quota exhausted');
  if (isAlreadyStructured && !isStructuredWeeklyQuota) return structured;
  if (isAlreadyStructured && isStructuredWeeklyQuota) {
    attachWindsurfErrorFields(structured, { code: 'WINDSURF_WEEKLY_QUOTA_EXHAUSTED', status: 429, retryable: false, rateLimitKind: 'daily_limit', cooldownOverrideMs: computeWindsurfQuotaCooldownUntilNextMidnightMs(), quotaScope: 'weekly', quotaReason: 'windsurf_weekly_exhausted' });
    return structured;
  }
  const classified = new Error(source.message) as Error & Record<string, unknown>;
  const sourceRecord = source as Error & { status?: unknown; response?: { status?: unknown; data?: unknown } };
  const responseData = sourceRecord.response?.data && typeof sourceRecord.response.data === 'object' ? sourceRecord.response.data as Record<string, unknown> : null;
  const nestedError = responseData?.error && typeof responseData.error === 'object' ? responseData.error as Record<string, unknown> : null;
  const upstreamStatus = typeof sourceRecord.status === 'number' ? sourceRecord.status : typeof sourceRecord.response?.status === 'number' ? sourceRecord.response.status : typeof nestedError?.code === 'number' ? nestedError.code : null;
  const statusText = typeof nestedError?.status === 'string' ? nestedError.status.toLowerCase() : '';
  const message = normalizedSourceMessage;
  const isWeeklyQuota = message.includes('weekly usage quota has been exhausted') || message.includes('weekly quota has been exhausted') || message.includes('weekly usage quota exhausted');
  const isPolicyBlocked = /cyber\s*verification|content[\s_-]+policy|policy[\s_-]+(?:violation|blocked|denied)|safety[\s_-]+(?:policy|blocked)|prompt[\s_-]+(?:rejected|blocked)\s+by[\s_-]+policy|usage[\s_-]+policy[\s_-]+violation/i.test(source.message);
  const isResourceExhausted = message.includes('resource_exhausted') || statusText === 'resource_exhausted' || message.includes('message limit') || message.includes('reached your message limit for this model');
  const isInternalTransient = message.includes('an internal error occurred') || message.includes('internal error occurred');
  const isAuth = upstreamStatus === 401 || statusText === 'unauthenticated' || message.includes('unauthenticated') || message.includes('invalid authentication credentials') || message.includes('permission_denied');
  const isServiceUnavailable = message.includes('econnrefused') || message.includes('connection refused') || message.includes('managed ls port') || message.includes('not ready') || message.includes('no free local ls port') || message.includes('runtime lsport missing');
  const isTransportTransient = message.includes('econnreset') || message.includes('err_http2') || message.includes('pending stream has been canceled') || message.includes('err_http2_stream_cancel') || message.includes('session closed') || message.includes('stream closed');
  const isParseFailure = message.includes('[windsurf] empty cascade candidate payload')
    || message.includes('[windsurf] empty assistant completion')
    || message.includes('[windsurf] empty cascade poll response')
    || message.includes('[windsurf] cascade poll response is not valid json object')
    || message.includes('[windsurf] empty cascade_id from start response')
    || message.includes('[windsurf] duplicate tool_result for completed tool call')
    || message.includes('[windsurf] orphan tool_result without matching assistant tool call')
    || message.includes('[windsurf] duplicate assistant tool call id in history')
    || message.includes('[windsurf] duplicate assistant tool call id in assistant candidate')
    || message.includes('[windsurf] assistant history mixed chat tool_calls with content tool call')
    || message.includes('[windsurf] assistant tool call missing call_id')
    || message.includes('[windsurf] assistant tool call missing name')
    || message.includes('[windsurf] rcc tool_result marker contract violated');
  attachWindsurfErrorFields(classified, {
    code: isWeeklyQuota ? 'WINDSURF_WEEKLY_QUOTA_EXHAUSTED' : isPolicyBlocked ? 'WINDSURF_POLICY_BLOCKED' : isInternalTransient || isTransportTransient ? 'WINDSURF_UPSTREAM_TRANSIENT' : isServiceUnavailable ? 'WINDSURF_SERVICE_UNREACHABLE' : isResourceExhausted ? 'WINDSURF_RATE_LIMITED' : isAuth ? 'WINDSURF_AUTH_FAILED' : isParseFailure ? 'WINDSURF_RESPONSE_PARSE_FAILED' : 'WINDSURF_SERVICE_UNREACHABLE',
    retryable: isWeeklyQuota || isResourceExhausted || isPolicyBlocked ? false : isAuth ? false : isParseFailure ? false : true,
    status: isWeeklyQuota || isResourceExhausted ? 429 : isPolicyBlocked ? 451 : isAuth ? 401 : isServiceUnavailable ? 503 : 502,
    rateLimitKind: isWeeklyQuota ? 'daily_limit' : isResourceExhausted ? 'short_lived' : undefined,
    cooldownOverrideMs: isWeeklyQuota ? computeWindsurfQuotaCooldownUntilNextMidnightMs() : undefined,
    quotaScope: isWeeklyQuota ? 'weekly' : isResourceExhausted ? 'model' : undefined,
    quotaReason: isWeeklyQuota ? 'windsurf_weekly_exhausted' : isResourceExhausted ? 'windsurf_model_rate_limited' : undefined,
  });
  if (classified !== structured) classified.cause = source;
  return classified;
}

export type WindsurfParsedChatMessageResponse = {
  candidate: Record<string, unknown>;
  usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } | null;
};

export function parseGetChatMessageResponse(args: {
  raw: string | Uint8Array;
  meta?: WindsurfResponseMeta;
  createError: (message: string, fields?: Record<string, unknown>) => Error;
  classifyPayloadError: (payload: Record<string, unknown>) => Record<string, unknown>;
  stableStringify: (value: unknown) => string;
  tryParseCompletionDeltaProto: (bytes: Uint8Array) => WindsurfCompletionDeltaProtoParseResult;
  buildConnectFrameErrorMessage: (base: string, details: Record<string, unknown>) => string;
}): WindsurfParsedChatMessageResponse {
  const { raw, meta } = args;
  const createError = args.createError;
  const classifyPayloadError = args.classifyPayloadError;

    const bytes = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : Buffer.from(raw);
    const maybeJsonText = bytes.toString('utf8').trim();
    if ((maybeJsonText.startsWith('{') || maybeJsonText.startsWith('[')) && maybeJsonText.length > 0) {
      try {
        const payload = JSON.parse(maybeJsonText);
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
          const record = payload as Record<string, unknown>;
          if (record.error && typeof record.error === 'object') {
            const payloadError = record.error as Record<string, unknown>;
            throw createError(String(payloadError.message || 'windsurf upstream error'), {
              ...classifyPayloadError(payloadError),
            });
          }
          if (typeof record.code === 'string' || typeof record.message === 'string') {
            throw createError(String(record.message || 'windsurf upstream error'), {
              ...classifyPayloadError(record),
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
              throw createError('[windsurf] empty cascade candidate payload', {
                code: 'WINDSURF_RESPONSE_PARSE_FAILED',
                status: 502,
                retryable: false,
              });
            }
            const first = completions[0] && typeof completions[0] === 'object'
              ? completions[0] as Record<string, unknown>
              : null;
            if (!first) {
              throw createError('[windsurf] empty cascade candidate payload', {
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
                        ? args.stableStringify(row.input)
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
              throw createError('[windsurf] empty cascade candidate payload', {
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
        throw createError(args.buildConnectFrameErrorMessage(
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
        const protoParsed = args.tryParseCompletionDeltaProto(payloadBytes);
        if (!protoParsed.ok) {
          throw createError(args.buildConnectFrameErrorMessage(
            '[windsurf] malformed GetChatMessage CompletionDelta proto payload',
            {
              ...meta,
              protoReason: protoParsed.reason,
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
        payload = protoParsed.payload;
      }
      const payloadError = payload.error && typeof payload.error === 'object'
        ? payload.error as Record<string, unknown>
        : null;
      if (payloadError) {
        throw createError(String(payloadError.message || 'windsurf upstream error'), {
          ...classifyPayloadError(payloadError),
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
      throw createError('[windsurf] empty cascade candidate payload', {
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
                ? args.stableStringify(row.input)
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
