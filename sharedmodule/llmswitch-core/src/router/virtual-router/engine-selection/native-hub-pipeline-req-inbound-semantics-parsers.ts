function parseOptionalString(raw: string): string | undefined | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null) {
      return undefined;
    }
    if (typeof parsed !== 'string') {
      return null;
    }
    const normalized = parsed.trim();
    return normalized ? normalized : undefined;
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

function parseUnknown(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

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

function parseArray(raw: string): unknown[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
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
