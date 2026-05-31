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
  const record = asProviderResponseRecord(payload);
  if (!record) return false;
  return hasProviderSseMarkerSignal(record) && readProviderResponseSseText(record) === undefined;
}

function asProviderResponseRecord(payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  return payload as Record<string, unknown>;
}

function hasProviderSseMarkerSignal(record: Record<string, unknown>): boolean {
  const mode = typeof record.mode === 'string' ? record.mode.trim().toLowerCase() : '';
  if (mode === 'sse' || mode === 'sse_passthrough') {
    return true;
  }
  return record.clientStream === true && (record.__sse_responses === undefined && record.__sse_stream === undefined);
}

export async function materializeProviderResponseSsePayload(
  payload: unknown
): Promise<Record<string, unknown>> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  const nestedEnvelopeBody = readProviderResponseEnvelopeBody(payload);
  if (nestedEnvelopeBody) {
    return await materializeProviderResponseSsePayload(nestedEnvelopeBody);
  }
  const stream = extractProviderResponseSseStream(payload);
  if (stream) {
    const bodyText = await readProviderResponseSseStreamText(stream);
    if (!bodyText.trim()) {
      throw new Error('Provider SSE marker did not include materializable stream or bodyText');
    }
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

function readProviderResponseEnvelopeBody(payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, 'body')) {
    return undefined;
  }
  if (
    !Object.prototype.hasOwnProperty.call(record, 'status')
    && !Object.prototype.hasOwnProperty.call(record, 'headers')
    && !Object.prototype.hasOwnProperty.call(record, 'metadata')
  ) {
    return undefined;
  }
  const body = record.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return undefined;
  }
  return body as Record<string, unknown>;
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
