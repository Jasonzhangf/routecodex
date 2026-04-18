const NON_BLOCKING_REQ_INBOUND_LOG_THROTTLE_MS = 60_000;
const nonBlockingReqInboundLogState = new Map<string, number>();
const JSON_PARSE_FAILED = Symbol('native-hub-pipeline-req-inbound-semantics-parsers.parse-failed');

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

function logNativeReqInboundNonBlocking(stage: string, error: unknown): void {
  const now = Date.now();
  const last = nonBlockingReqInboundLogState.get(stage) ?? 0;
  if (now - last < NON_BLOCKING_REQ_INBOUND_LOG_THROTTLE_MS) {
    return;
  }
  nonBlockingReqInboundLogState.set(stage, now);
  console.warn(
    `[native-hub-pipeline-req-inbound-semantics-parsers] ${stage} failed (non-blocking): ${formatUnknownError(error)}`
  );
}

function parseJson(stage: string, raw: string): unknown | typeof JSON_PARSE_FAILED {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    logNativeReqInboundNonBlocking(stage, error);
    return JSON_PARSE_FAILED;
  }
}

function parseOptionalString(raw: string): string | undefined | null {
  const parsed = parseJson('parseOptionalString', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  if (parsed === null) {
    return undefined;
  }
  if (typeof parsed !== 'string') {
    return null;
  }
  const normalized = parsed.trim();
  return normalized ? normalized : undefined;
}

function parseBoolean(raw: string): boolean | null {
  const parsed = parseJson('parseBoolean', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  return typeof parsed === 'boolean' ? parsed : null;
}

function parseUnknown(raw: string): unknown | null {
  const parsed = parseJson('parseUnknown', raw);
  return parsed === JSON_PARSE_FAILED ? null : parsed;
}

function parseRecord(raw: string): Record<string, unknown> | null {
  const parsed = parseJson('parseRecord', raw);
  if (parsed === JSON_PARSE_FAILED || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function parseArray(raw: string): unknown[] | null {
  const parsed = parseJson('parseArray', raw);
  if (parsed === JSON_PARSE_FAILED) {
    return null;
  }
  return Array.isArray(parsed) ? parsed : null;
}

function parseToolOutputSnapshotBuildResult(
  raw: string
): { snapshot: Record<string, unknown>; payload: Record<string, unknown> } | null {
  const parsed = parseRecord(raw);
  if (!parsed) {
    return null;
  }
  const snapshot = parsed.snapshot;
  const payload = parsed.payload;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  return {
    snapshot: snapshot as Record<string, unknown>,
    payload: payload as Record<string, unknown>
  };
}

export {
  parseOptionalString,
  parseBoolean,
  parseUnknown,
  parseRecord,
  parseArray,
  parseToolOutputSnapshotBuildResult
};
