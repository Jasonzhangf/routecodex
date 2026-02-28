function readDetailField(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const row = value as Record<string, unknown>;
  const candidate = row[key];
  if (candidate === undefined || candidate === null) {
    return null;
  }
  const text = String(candidate).trim();
  return text ? `${key}=${text}` : null;
}

function collectCauseDetails(cause: unknown): string[] {
  if (!cause || typeof cause !== 'object') {
    return [];
  }

  const details: string[] = [];
  const fields = ['code', 'errno', 'syscall', 'hostname', 'address', 'port'];
  for (const field of fields) {
    const item = readDetailField(cause, field);
    if (item) {
      details.push(item);
    }
  }

  const message = readDetailField(cause, 'message');
  if (message && !details.some((item) => item.endsWith(message.replace(/^message=/, '')))) {
    details.push(message);
  }

  return details;
}

export function formatOAuthErrorMessage(error: unknown): string {
  const fallback = String(error ?? 'unknown error');
  if (!(error instanceof Error)) {
    return fallback;
  }

  const base = error.message || error.name || fallback;
  const cause = (error as Error & { cause?: unknown }).cause;
  const details = collectCauseDetails(cause);
  if (!details.length) {
    return base;
  }
  return `${base} [${details.join(' ')}]`;
}
