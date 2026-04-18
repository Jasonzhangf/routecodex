import type { JsonObject } from '../../../conversion/hub/types/json.js';
import type {
  NativeReqOutboundContextMergePlan,
  NativeReqOutboundContextSnapshotPatch,
  NativeReqOutboundStage3CompatOutput,
  NativeToolSessionCompatOutput,
  NativeToolSessionHistoryUpdateOutput
} from './native-hub-pipeline-req-outbound-semantics-types.js';

const NON_BLOCKING_PARSE_LOG_THROTTLE_MS = 60_000;
const nonBlockingParseLogState = new Map<string, number>();
const JSON_PARSE_FAILED = Symbol('native-hub-pipeline-req-outbound-semantics.parse-failed');

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error ?? 'unknown');
  }
}

function logNativeReqOutboundParserNonBlocking(stage: string, error: unknown): void {
  const now = Date.now();
  const last = nonBlockingParseLogState.get(stage) ?? 0;
  if (now - last < NON_BLOCKING_PARSE_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingParseLogState.set(stage, now);
  console.warn(
    `[native-hub-pipeline-req-outbound-semantics-parsers] ${stage} parse failed (non-blocking): ${formatUnknownError(error)}`
  );
}

function parseJson(stage: string, raw: string): unknown | typeof JSON_PARSE_FAILED {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    logNativeReqOutboundParserNonBlocking(stage, error);
    return JSON_PARSE_FAILED;
  }
}

function parseRecord(raw: string, stage = 'parseRecord'): Record<string, unknown> | null {
  const parsed = parseJson(stage, raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function parseNormalizedToolDefinitions(
  candidate: unknown
):
  | Array<{
      type: 'function';
      function: {
        name: string;
        description?: string;
        parameters: unknown;
        strict?: boolean;
      };
    }>
  | null {
  if (!Array.isArray(candidate)) {
    return null;
  }
  const tools: Array<{
    type: 'function';
    function: {
      name: string;
      description?: string;
      parameters: unknown;
      strict?: boolean;
    };
  }> = [];
  for (const entry of candidate) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const row = entry as Record<string, unknown>;
    if (row.type !== 'function') {
      continue;
    }
    const fn = row.function;
    if (!fn || typeof fn !== 'object' || Array.isArray(fn)) {
      continue;
    }
    const fnRow = fn as Record<string, unknown>;
    const name = typeof fnRow.name === 'string' && fnRow.name.trim() ? fnRow.name.trim() : '';
    if (!name) {
      continue;
    }
    const description = typeof fnRow.description === 'string' ? fnRow.description : undefined;
    const strict = typeof fnRow.strict === 'boolean' ? fnRow.strict : undefined;
    const parameters = fnRow.parameters ?? { type: 'object', properties: {} };
    tools.push({
      type: 'function',
      function: {
        name,
        ...(description ? { description } : {}),
        parameters,
        ...(strict !== undefined ? { strict } : {})
      }
    });
  }
  return tools;
}

function parseReqOutboundContextMergePlan(raw: string): NativeReqOutboundContextMergePlan | null {
  const row = parseRecord(raw, 'parseReqOutboundContextMergePlan');
  if (!row) {
    return null;
  }
  const out: NativeReqOutboundContextMergePlan = {};

  const mergedToolOutputs = row.mergedToolOutputs;
  if (mergedToolOutputs !== undefined) {
    if (!Array.isArray(mergedToolOutputs)) {
      return null;
    }
    const normalized: Array<{ tool_call_id: string; content: string; name?: string }> = [];
    for (const entry of mergedToolOutputs) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null;
      }
      const rowEntry = entry as Record<string, unknown>;
      const toolCallId =
        typeof rowEntry.tool_call_id === 'string'
          ? rowEntry.tool_call_id.trim()
          : typeof rowEntry.toolCallId === 'string'
            ? rowEntry.toolCallId.trim()
            : '';
      const content = typeof rowEntry.content === 'string' ? rowEntry.content : undefined;
      if (!toolCallId || content === undefined) {
        return null;
      }
      const name = typeof rowEntry.name === 'string' && rowEntry.name.trim() ? rowEntry.name.trim() : undefined;
      normalized.push({ tool_call_id: toolCallId, content, ...(name ? { name } : {}) });
    }
    out.mergedToolOutputs = normalized;
  }

  const normalizedTools = row.normalizedTools;
  if (normalizedTools !== undefined) {
    const parsedTools = parseNormalizedToolDefinitions(normalizedTools);
    if (parsedTools === null) {
      return null;
    }
    out.normalizedTools = parsedTools;
  }

  return out;
}

function parseReqOutboundContextSnapshotPatch(raw: string): NativeReqOutboundContextSnapshotPatch | null {
  const row = parseRecord(raw, 'parseReqOutboundContextSnapshotPatch');
  if (!row) {
    return null;
  }
  const out: NativeReqOutboundContextSnapshotPatch = {};

  const toolOutputs = row.toolOutputs;
  if (toolOutputs !== undefined) {
    if (!Array.isArray(toolOutputs)) {
      return null;
    }
    const normalized: Array<{ tool_call_id: string; content: string; name?: string }> = [];
    for (const entry of toolOutputs) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null;
      }
      const rowEntry = entry as Record<string, unknown>;
      const toolCallId =
        typeof rowEntry.tool_call_id === 'string'
          ? rowEntry.tool_call_id.trim()
          : typeof rowEntry.toolCallId === 'string'
            ? rowEntry.toolCallId.trim()
            : '';
      const content = typeof rowEntry.content === 'string' ? rowEntry.content : undefined;
      if (!toolCallId || content === undefined) {
        return null;
      }
      const name = typeof rowEntry.name === 'string' && rowEntry.name.trim() ? rowEntry.name.trim() : undefined;
      normalized.push({ tool_call_id: toolCallId, content, ...(name ? { name } : {}) });
    }
    out.toolOutputs = normalized;
  }

  const toolsRaw = row.tools;
  if (toolsRaw !== undefined) {
    const parsedTools = parseNormalizedToolDefinitions(toolsRaw);
    if (parsedTools === null) {
      return null;
    }
    out.tools = parsedTools;
  }

  return out;
}

function parseReqOutboundCompatOutput(raw: string): NativeReqOutboundStage3CompatOutput | null {
  const row = parseRecord(raw, 'parseReqOutboundCompatOutput');
  if (!row) {
    return null;
  }
  const payloadRaw = row.payload;
  if (!payloadRaw || typeof payloadRaw !== 'object' || Array.isArray(payloadRaw)) {
    return null;
  }
  const payload = payloadRaw as JsonObject;
  const appliedProfileRaw = row.appliedProfile;
  const appliedProfile = typeof appliedProfileRaw === 'string' && appliedProfileRaw.trim()
    ? appliedProfileRaw.trim()
    : undefined;
  const nativeAppliedRaw = row.nativeApplied;
  if (typeof nativeAppliedRaw !== 'boolean') {
    return null;
  }
  const nativeApplied = nativeAppliedRaw;
  const rateLimitDetectedRaw = row.rateLimitDetected;
  const rateLimitDetected =
    typeof rateLimitDetectedRaw === 'boolean' ? rateLimitDetectedRaw : undefined;
  return {
    payload,
    ...(appliedProfile ? { appliedProfile } : {}),
    nativeApplied,
    ...(rateLimitDetected !== undefined ? { rateLimitDetected } : {})
  };
}

function parseToolSessionCompatOutput(raw: string): NativeToolSessionCompatOutput | null {
  const row = parseRecord(raw, 'parseToolSessionCompatOutput');
  if (!row) {
    return null;
  }
  const messagesRaw = row.messages;
  if (!Array.isArray(messagesRaw)) {
    return null;
  }
  const out: NativeToolSessionCompatOutput = {
    messages: messagesRaw
  };
  if (Object.prototype.hasOwnProperty.call(row, 'toolOutputs')) {
    if (row.toolOutputs == null) {
      out.toolOutputs = undefined;
    } else if (Array.isArray(row.toolOutputs)) {
      out.toolOutputs = row.toolOutputs;
    } else {
      return null;
    }
  }
  return out;
}

function parseToolSessionHistoryUpdateOutput(raw: string): NativeToolSessionHistoryUpdateOutput | null {
  const row = parseRecord(raw, 'parseToolSessionHistoryUpdateOutput');
  if (!row) {
    return null;
  }
  const recordsCount = typeof row.recordsCount === 'number' && Number.isFinite(row.recordsCount)
    ? row.recordsCount
    : null;
  if (recordsCount === null) {
    return null;
  }
  const output: NativeToolSessionHistoryUpdateOutput = { recordsCount };
  if (row.history !== undefined) {
    if (!row.history || typeof row.history !== 'object' || Array.isArray(row.history)) {
      return null;
    }
    output.history = row.history as NativeToolSessionHistoryUpdateOutput['history'];
  }
  return output;
}

function parseJsonObject(raw: string): JsonObject | null {
  const parsed = parseJson('parseJsonObject', raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as JsonObject;
}

function parseReqOutboundFormatBuildOutput(raw: string): JsonObject | null {
  const row = parseRecord(raw, 'parseReqOutboundFormatBuildOutput');
  if (!row) {
    return null;
  }
  const payload = row.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  return payload as JsonObject;
}

function parseBoolean(raw: string): boolean | null {
  const parsed = parseJson('parseBoolean', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  return typeof parsed === 'boolean' ? parsed : null;
}

export {
  parseRecord,
  parseReqOutboundContextMergePlan,
  parseReqOutboundFormatBuildOutput,
  parseReqOutboundContextSnapshotPatch,
  parseReqOutboundCompatOutput,
  parseToolSessionCompatOutput,
  parseToolSessionHistoryUpdateOutput,
  parseJsonObject,
  parseBoolean
};
