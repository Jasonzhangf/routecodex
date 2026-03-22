import type { JsonObject } from '../../../conversion/hub/types/json.js';
import type {
  NativeReqOutboundContextMergePlan,
  NativeReqOutboundContextSnapshotPatch,
  NativeReqOutboundStage3CompatOutput,
  NativeToolSessionCompatOutput,
  NativeToolSessionHistoryUpdateOutput
} from './native-hub-pipeline-req-outbound-semantics-types.js';

function parseRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
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
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
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
  } catch {
    return null;
  }
}

function parseReqOutboundContextSnapshotPatch(raw: string): NativeReqOutboundContextSnapshotPatch | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
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
  } catch {
    return null;
  }
}

function parseReqOutboundCompatOutput(raw: string): NativeReqOutboundStage3CompatOutput | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
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
  } catch {
    return null;
  }
}

function parseToolSessionCompatOutput(raw: string): NativeToolSessionCompatOutput | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
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
  } catch {
    return null;
  }
}

function parseToolSessionHistoryUpdateOutput(raw: string): NativeToolSessionHistoryUpdateOutput | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
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
  } catch {
    return null;
  }
}

function parseJsonObject(raw: string): JsonObject | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as JsonObject;
  } catch {
    return null;
  }
}

function parseReqOutboundFormatBuildOutput(raw: string): JsonObject | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    const payload = row.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null;
    }
    return payload as JsonObject;
  } catch {
    return null;
  }
}

function parseBoolean(raw: string): boolean | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'boolean' ? parsed : null;
  } catch {
    return null;
  }
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
