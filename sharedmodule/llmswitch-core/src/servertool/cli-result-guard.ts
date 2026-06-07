import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import { validateClientExecCommandResultWithNative } from '../router/virtual-router/engine-selection/native-servertool-core-semantics.js';

const ROUTECODEX_STOP_MESSAGE_AUTO_CLI = 'routecodex servertool run stop_message_auto';
const MAX_SCAN_DEPTH = 10;
const MAX_SCAN_NODES = 2000;

export function hasStopMessageAutoCliResultInRequest(args: {
  adapterContext: AdapterContext;
  runtimeMetadata?: JsonObject;
}): boolean {
  const roots = collectScanRoots(args.adapterContext, args.runtimeMetadata);
  let seen = 0;
  for (const root of roots) {
    if (scanValue(root, 0, () => {
      seen += 1;
      return seen <= MAX_SCAN_NODES;
    })) {
      return true;
    }
  }
  return false;
}

function collectScanRoots(adapterContext: AdapterContext, runtimeMetadata?: JsonObject): unknown[] {
  const adapter = asRecord(adapterContext);
  const runtime = asRecord(runtimeMetadata);
  const responsesContext = asRecord(adapter?.responsesRequestContext) ?? asRecord(runtime?.responsesRequestContext);
  return [
    adapter?.__raw_request_body,
    adapter?.capturedChatRequest,
    responsesContext?.payload,
    responsesContext?.context,
    runtime?.capturedChatRequest
  ].filter((value) => value !== undefined);
}

function scanValue(value: unknown, depth: number, allowNode: () => boolean): boolean {
  if (depth > MAX_SCAN_DEPTH || !allowNode()) {
    return false;
  }
  if (isStopMessageAutoCliResultObject(value)) {
    return true;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (scanValue(item, depth + 1, allowNode)) {
        return true;
      }
    }
    return false;
  }
  const record = asRecord(value);
  if (!record) {
    return false;
  }
  for (const item of Object.values(record)) {
    if (scanValue(item, depth + 1, allowNode)) {
      return true;
    }
  }
  return false;
}

function isStopMessageAutoCliResultObject(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) {
    return false;
  }
  if (!isToolResultLike(record)) {
    return false;
  }
  if (textContainsStopMessageAutoCliResult(readResultText(record))) {
    return true;
  }
  return false;
}

function isToolResultLike(record: Record<string, unknown>): boolean {
  const type = typeof record.type === 'string' ? record.type.trim().toLowerCase() : '';
  const role = typeof record.role === 'string' ? record.role.trim().toLowerCase() : '';
  return (
    type === 'function_call_output' ||
    type === 'tool_result' ||
    type === 'tool_message' ||
    role === 'tool' ||
    Object.prototype.hasOwnProperty.call(record, 'call_id') ||
    Object.prototype.hasOwnProperty.call(record, 'tool_call_id')
  );
}

function readResultText(record: Record<string, unknown>): string {
  const fields = [record.output, record.content, record.text, record.arguments];
  const parts: string[] = [];
  for (const field of fields) {
    collectText(field, parts);
  }
  if (typeof record.tool === 'string' || typeof record.kind === 'string') {
    parts.push(JSON.stringify({ tool: record.tool, kind: record.kind }));
  }
  return parts.join('\n');
}

function collectText(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectText(item, out);
    }
    return;
  }
  const record = asRecord(value);
  if (!record) {
    return;
  }
  collectText(record.text, out);
  collectText(record.output_text, out);
  collectText(record.content, out);
}

function textContainsStopMessageAutoCliResult(text: string): boolean {
  if (!text.trim()) {
    return false;
  }
  if (text.includes(ROUTECODEX_STOP_MESSAGE_AUTO_CLI)) {
    return true;
  }
  const parsed = parseJsonObjectFromText(text);
  if (!parsed) {
    return false;
  }
  return isNativeClientExecCliResult(parsed);
}

function parseJsonObjectFromText(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Continue scanning other exact substrings; no semantic fallback.
    }
  }
  return null;
}

function isNativeClientExecCliResult(value: Record<string, unknown>): boolean {
  try {
    validateClientExecCommandResultWithNative(JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
