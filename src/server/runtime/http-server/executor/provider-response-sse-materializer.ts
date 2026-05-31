import { Readable } from 'node:stream';

export function readProviderResponseSseText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const bodyText = record.bodyText;
  if (typeof bodyText === 'string' && bodyText.trim()) {
    return bodyText;
  }
  const raw = record.raw;
  if (typeof raw === 'string' && raw.trim()) {
    return raw;
  }
  const data = record.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const nested = data as Record<string, unknown>;
    const nestedBodyText = nested.bodyText;
    if (typeof nestedBodyText === 'string' && nestedBodyText.trim()) {
      return nestedBodyText;
    }
    const nestedRaw = nested.raw;
    if (typeof nestedRaw === 'string' && nestedRaw.trim()) {
      return nestedRaw;
    }
  }
  return undefined;
}

export function isProviderResponseSseMarker(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }
  const record = payload as Record<string, unknown>;
  const mode = typeof record.mode === 'string' ? record.mode.trim().toLowerCase() : '';
  return mode === 'sse' && readProviderResponseSseText(record) === undefined;
}

export async function materializeProviderResponseSsePayload(
  payload: unknown
): Promise<Record<string, unknown>> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  const stream = extractProviderResponseSseStream(payload);
  if (stream) {
    const bodyText = await readProviderResponseSseStreamText(stream);
    return { ...(payload as Record<string, unknown>), mode: 'sse', bodyText };
  }
  const bodyText = readProviderResponseSseText(payload);
  if (typeof bodyText === 'string') {
    return { ...(payload as Record<string, unknown>), mode: 'sse', bodyText };
  }
  if (!isProviderResponseSseMarker(payload)) {
    return payload as Record<string, unknown>;
  }
  throw new Error('Provider SSE marker did not include materializable stream or bodyText');
}

function extractProviderResponseSseStream(payload: unknown): Readable | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const direct = record.__sse_responses ?? record.__sse_stream;
  if (direct && typeof (direct as { pipe?: unknown }).pipe === 'function') {
    return direct as Readable;
  }
  const data = record.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const nested = data as Record<string, unknown>;
    const nestedStream = nested.__sse_responses ?? nested.__sse_stream;
    if (nestedStream && typeof (nestedStream as { pipe?: unknown }).pipe === 'function') {
      return nestedStream as Readable;
    }
  }
  return undefined;
}

async function readProviderResponseSseStreamText(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string | Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
