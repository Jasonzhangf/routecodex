import type { IncomingMessage } from 'http';
import { Readable } from 'node:stream';
import { attachRawPayload } from '../../utils/log-helpers.js';

export interface ParsedSseJsonRequest {
  rawText: string;
  events: ParsedSseEvent[];
  firstPayload?: Record<string, unknown>;
  lastPayload?: Record<string, unknown>;
}

interface ParsedSseEvent {
  event?: string;
  id?: string;
  data: string;
}

function parseSseEvents(raw: string): ParsedSseEvent[] {
  const events: ParsedSseEvent[] = [];
  const lines = raw.split(/\r?\n/);
  let current: ParsedSseEvent | null = null;

  const pushCurrent = () => {
    if (!current) {
      return;
    }
    events.push({
      event: current.event,
      id: current.id,
      data: current.data
    });
    current = null;
  };

  for (const line of lines) {
    if (!line) {
      pushCurrent();
      continue;
    }
    if (!current) {
      current = { data: '' };
    }
    if (line.startsWith('data:')) {
      const value = line.slice(5).replace(/^\s?/, '');
      current.data = current.data ? `${current.data}\n${value}` : value;
    } else if (line.startsWith('event:')) {
      current.event = line.slice(6).trim();
    } else if (line.startsWith('id:')) {
      current.id = line.slice(3).trim();
    }
  }
  pushCurrent();
  return events;
}

function collectRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      if (typeof chunk === 'string') {
        chunks.push(Buffer.from(chunk, 'utf8'));
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => reject(error));
  });
}

export async function parseSseJsonRequest(req: IncomingMessage): Promise<ParsedSseJsonRequest> {
  const rawText = await collectRawBody(req);
  if (!rawText.trim()) {
    const error = new Error('SSE request body is empty');
    attachRawPayload(error, rawText);
    throw error;
  }
  const events = parseSseEvents(rawText);
  if (!events.length) {
    const error = new Error('SSE request body is malformed');
    attachRawPayload(error, rawText);
    throw error;
  }

  let firstPayload: Record<string, unknown> | undefined;
  let lastPayload: Record<string, unknown> | undefined;
  for (const event of events) {
    const data = event.data?.trim();
    if (!data) continue;
    try {
      const payload = JSON.parse(data);
      if (payload && typeof payload === 'object') {
        if (!firstPayload) {
          firstPayload = payload as Record<string, unknown>;
        }
        lastPayload = payload as Record<string, unknown>;
      }
    } catch (error) {
      if (error instanceof Error) {
        attachRawPayload(error, data ?? rawText);
      }
      continue;
    }
  }
  return { rawText, events, firstPayload, lastPayload };
}

export function createReadableFromSse(rawText: string): Readable {
  return Readable.from(rawText, { encoding: 'utf8' });
}
