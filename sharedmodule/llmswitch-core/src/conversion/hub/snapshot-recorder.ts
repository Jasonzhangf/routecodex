import type { StageRecorder } from './format-adapters/index.js';
import type { AdapterContext } from './types/chat-envelope.js';
import { createSnapshotWriter, type SnapshotWriter } from '../snapshot-utils.js';
import { normalizeSnapshotStagePayloadWithNative } from '../../router/virtual-router/engine-selection/native-snapshot-hooks.js';

const SNAPSHOT_STRING_PREVIEW_CHARS = 240;
const SNAPSHOT_ARRAY_PREVIEW_ITEMS = 2;
const FORMAT_PARSE_STAGE_NAMES = new Set([
  'req_inbound_stage1_format_parse',
  'chat_process.req.stage1.format_parse'
]);
const TOOL_GOVERNANCE_STAGE_NAMES = new Set([
  'req_process_stage1_tool_governance',
  'chat_process.req.stage4.tool_governance'
]);

export interface SnapshotStageRecorderOptions {
  context: AdapterContext;
  endpoint: string;
}

function clipSnapshotString(value: string): string {
  const text = String(value ?? '');
  return text.length > SNAPSHOT_STRING_PREVIEW_CHARS
    ? `${text.slice(0, SNAPSHOT_STRING_PREVIEW_CHARS)}…`
    : text;
}

function summarizeScalar(value: unknown): unknown {
  if (typeof value === 'string') {
    return clipSnapshotString(value);
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  return undefined;
}

function summarizeValuePreview(value: unknown, depth = 0): unknown {
  const scalar = summarizeScalar(value);
  if (scalar !== undefined || value === null) {
    return scalar;
  }
  if (Array.isArray(value)) {
    if (depth >= 2) {
      return { type: 'array', count: value.length };
    }
    const first = value.slice(0, SNAPSHOT_ARRAY_PREVIEW_ITEMS).map((entry) => summarizeValuePreview(entry, depth + 1));
    const last = value.slice(-SNAPSHOT_ARRAY_PREVIEW_ITEMS).map((entry) => summarizeValuePreview(entry, depth + 1));
    return {
      type: 'array',
      count: value.length,
      first,
      last
    };
  }
  if (!value || typeof value !== 'object') {
    return String(value);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const preferredKeys = ['role', 'type', 'name', 'id', 'call_id', 'content', 'text', 'input', 'output', 'status'];
  const preview: Record<string, unknown> = {};
  for (const key of preferredKeys) {
    if (key in record) {
      preview[key] = summarizeValuePreview(record[key], depth + 1);
    }
  }
  if (!Object.keys(preview).length) {
    for (const key of keys.slice(0, 6)) {
      preview[key] = summarizeValuePreview(record[key], depth + 1);
    }
  }
  return {
    type: 'object',
    keys,
    preview
  };
}

function summarizeCollection(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return summarizeValuePreview(value);
  }
  return {
    count: value.length,
    preview: summarizeValuePreview(value)
  };
}

function summarizeTools(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return summarizeValuePreview(value);
  }
  return {
    count: value.length,
    names: value
      .map((tool) => {
        if (!tool || typeof tool !== 'object') {
          return null;
        }
        const node = tool as Record<string, unknown>;
        if (typeof node.name === 'string' && node.name.trim()) {
          return node.name.trim();
        }
        const fn = node.function;
        if (fn && typeof fn === 'object' && typeof (fn as Record<string, unknown>).name === 'string') {
          return String((fn as Record<string, unknown>).name).trim();
        }
        return typeof node.type === 'string' ? node.type : null;
      })
      .filter((name): name is string => Boolean(name))
      .slice(0, 32)
  };
}

function summarizeMetadata(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return summarizeValuePreview(value);
  }
  const metadata = value as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const key of [
    'requestId',
    'clientRequestId',
    'providerProtocol',
    'endpoint',
    'entryEndpoint',
    'originalEndpoint',
    'processMode',
    'sessionId',
    'conversationId',
    'workdir',
    'cwd',
    'processedAt',
    'stage',
    'stream'
  ]) {
    if (key in metadata) {
      summary[key] = summarizeValuePreview(metadata[key]);
    }
  }
  if ('clientHeaders' in metadata) {
    const headers = metadata.clientHeaders;
    if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
      summary.clientHeaders = { keys: Object.keys(headers as Record<string, unknown>).sort() };
    } else {
      summary.clientHeaders = summarizeValuePreview(headers);
    }
  }
  if ('capturedContext' in metadata) {
    summary.capturedContext = summarizeValuePreview(metadata.capturedContext);
  }
  if ('__rt' in metadata) {
    summary.__rt = summarizeValuePreview(metadata.__rt);
  }
  if ('__raw_request_body' in metadata) {
    const raw = metadata.__raw_request_body;
    summary.__raw_request_body = {
      omitted: true,
      preview: summarizeValuePreview(raw, 1)
    };
  }
  return summary;
}

function summarizeSemantics(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return summarizeValuePreview(value);
  }
  const semantics = value as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  if ('tools' in semantics) {
    const tools = semantics.tools;
    const toolsRecord =
      tools && typeof tools === 'object' && !Array.isArray(tools) ? (tools as Record<string, unknown>) : null;
    summary.tools = toolsRecord
      ? {
          keys: Object.keys(toolsRecord).sort(),
          toolNameAliasMap: summarizeValuePreview(toolsRecord.toolNameAliasMap, 1),
          clientToolsRaw: summarizeTools(toolsRecord.clientToolsRaw)
        }
      : summarizeValuePreview(tools);
  }
  const responses = semantics.responses;
  const responsesRecord =
    responses && typeof responses === 'object' && !Array.isArray(responses)
      ? (responses as Record<string, unknown>)
      : null;
  if (responsesRecord) {
    const context = responsesRecord.context;
    const contextRecord =
      context && typeof context === 'object' && !Array.isArray(context)
        ? (context as Record<string, unknown>)
        : null;
    summary.responses = contextRecord
      ? {
          context: {
            requestId: summarizeValuePreview(contextRecord.requestId),
            isChatPayload: summarizeValuePreview(contextRecord.isChatPayload),
            isResponsesPayload: summarizeValuePreview(contextRecord.isResponsesPayload),
            systemInstruction: summarizeValuePreview(contextRecord.systemInstruction),
            parameters: summarizeValuePreview(contextRecord.parameters, 1),
            input: summarizeCollection(contextRecord.input),
            __captured_tool_results: summarizeCollection(contextRecord.__captured_tool_results),
            toolsRaw: summarizeTools(contextRecord.toolsRaw),
            toolsNormalized: summarizeTools(contextRecord.toolsNormalized)
          }
        }
      : summarizeValuePreview(responsesRecord);
  }
  return summary;
}

function buildFormatParseSnapshotSummary(payload: Record<string, unknown>): Record<string, unknown> {
  const envelope =
    payload.payload && typeof payload.payload === 'object' && !Array.isArray(payload.payload)
      ? (payload.payload as Record<string, unknown>)
      : null;
  return {
    __snapshot_summary: true,
    stage: 'format_parse',
    format: summarizeValuePreview(payload.format),
    metadata: summarizeValuePreview(payload.metadata, 1),
    payload: envelope
      ? {
          model: summarizeValuePreview(envelope.model),
          include: summarizeValuePreview(envelope.include, 1),
          stream: summarizeValuePreview(envelope.stream),
          tool_choice: summarizeValuePreview(envelope.tool_choice),
          max_output_tokens: summarizeValuePreview(envelope.max_output_tokens),
          max_tokens: summarizeValuePreview(envelope.max_tokens),
          input: summarizeCollection(envelope.input),
          messages: summarizeCollection(envelope.messages),
          tools: summarizeTools(envelope.tools)
        }
      : summarizeValuePreview(payload.payload, 1)
  };
}

function buildToolGovernanceSnapshotSummary(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    __snapshot_summary: true,
    stage: 'tool_governance',
    model: summarizeValuePreview(payload.model),
    stream: summarizeValuePreview(payload.stream),
    tool_choice: summarizeValuePreview(payload.tool_choice),
    parameters: summarizeValuePreview(payload.parameters, 1),
    processed: summarizeValuePreview(payload.processed, 1),
    processingMetadata: summarizeValuePreview(payload.processingMetadata, 1),
    messages: summarizeCollection(payload.messages),
    tools: summarizeTools(payload.tools),
    metadata: summarizeMetadata(payload.metadata),
    semantics: summarizeSemantics(payload.semantics)
  };
}

export function trimSnapshotHotpathPayloadForNative(stage: string, payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }
  const record = payload as Record<string, unknown>;
  if (FORMAT_PARSE_STAGE_NAMES.has(stage)) {
    return buildFormatParseSnapshotSummary(record);
  }
  if (TOOL_GOVERNANCE_STAGE_NAMES.has(stage)) {
    return buildToolGovernanceSnapshotSummary(record);
  }
  return payload;
}

export class SnapshotStageRecorder implements StageRecorder {
  private readonly writer?: SnapshotWriter;

  constructor(private readonly options: SnapshotStageRecorderOptions) {
    const contextAny = options.context as unknown as Record<string, unknown>;
    this.writer = createSnapshotWriter({
      requestId: options.context.requestId,
      endpoint: options.endpoint,
      providerKey: typeof options.context.providerId === 'string' ? options.context.providerId : undefined,
      groupRequestId:
        typeof contextAny.clientRequestId === 'string'
          ? (contextAny.clientRequestId as string)
          : typeof contextAny.groupRequestId === 'string'
            ? (contextAny.groupRequestId as string)
            : undefined
    });
  }

  record(stage: string, payload: object): void {
    if (!this.writer) {
      return;
    }
    const trimmed = trimSnapshotHotpathPayloadForNative(stage, payload as unknown);
    const normalized = normalizeSnapshotStagePayloadWithNative(stage, trimmed);
    if (!normalized) {
      return;
    }
    try {
      this.writer(stage, normalized as object);
    } catch {
      // ignore snapshot write errors
    }
  }
}

export function createSnapshotRecorder(context: AdapterContext, endpoint: string): StageRecorder {
  return new SnapshotStageRecorder({ context, endpoint });
}
