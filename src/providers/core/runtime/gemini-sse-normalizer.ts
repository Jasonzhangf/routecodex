import { Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

export class GeminiSseNormalizer extends Transform {
  private decoder: StringDecoder;
  private buffer = '';
  private lastDonePayload: Record<string, unknown> | null = null;
  private eventCounter = 0;
  private chunkCounter = 0;
  private processedEventCounter = 0;
  private capturedEvents: any[] = [];

  constructor(_options?: { sessionId?: string; aliasKey?: string; enableAntigravitySignatureCache?: boolean }) {
    super();
    this.decoder = new StringDecoder('utf8');
  }

  override _transform(chunk: unknown, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.chunkCounter++;
    if (chunk) {
      let text = '';
      if (Buffer.isBuffer(chunk)) {
        text = this.decoder.write(chunk);
      } else {
        text = this.decoder.write(Buffer.from(String(chunk), 'utf8'));
      }
      this.buffer += text.replace(/\r/g, '');
      this.processBuffered();
    }
    callback();
  }

  override _flush(callback: TransformCallback): void {
    const remaining = this.decoder.end();
    if (remaining) {
      this.buffer += remaining.replace(/\r/g, '');
    }
    this.processBuffered(true);
    if (this.lastDonePayload) {
      this.pushEvent('gemini.done', this.lastDonePayload);
      this.lastDonePayload = null;
    }
    callback();
  }

  private processBuffered(flush = false): void {
    while (true) {
      const separatorIndex = this.buffer.indexOf('\n\n');
      if (separatorIndex === -1) {
        break;
      }
      const rawEvent = this.buffer.slice(0, separatorIndex);
      this.buffer = this.buffer.slice(separatorIndex + 2);
      this.processEvent(rawEvent);
    }
    if (flush && this.buffer.trim().length) {
      this.processEvent(this.buffer);
      this.buffer = '';
    }
  }

  private processEvent(rawEvent: string): void {
    this.processedEventCounter++;
    const trimmed = rawEvent.trim();
    if (!trimmed.length) {
      return;
    }
    const dataLines = trimmed
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());
    if (!dataLines.length) {
      return;
    }
    const payloadText = dataLines.join('\n').trim();
    if (!payloadText || payloadText === '[DONE]') {
      return;
    }
    try {
      const parsed = JSON.parse(payloadText) as { response?: Record<string, unknown> };
      this.capturedEvents.push(parsed);
      const response = parsed?.response;
      if (!response || typeof response !== 'object') {
        return;
      }
      this.emitCandidateParts(response as Record<string, unknown>);
    } catch {
      // ignore parse errors
    }
  }

  private emitCandidateParts(response: Record<string, unknown>): void {
    const candidatesRaw = (response as { candidates?: unknown }).candidates;
    const candidates = Array.isArray(candidatesRaw) ? (candidatesRaw as Record<string, unknown>[]) : [];

    candidates.forEach((candidate, index) => {
      const content =
        candidate && typeof candidate.content === 'object' && candidate.content !== null
          ? (candidate.content as Record<string, unknown>)
          : undefined;
      const role = typeof content?.role === 'string' ? (content.role as string) : 'model';
      const partsRaw = content?.parts;
      const parts = Array.isArray(partsRaw) ? (partsRaw as Record<string, unknown>[]) : [];

      for (const part of parts) {
        if (!part || typeof part !== 'object') {
          continue;
        }
        this.pushEvent('gemini.data', {
          candidateIndex: index,
          role,
          part
        });
      }
    });

    this.lastDonePayload = {
      candidates: candidates.map((candidate, index) => ({
        index,
        finishReason:
          candidate && typeof candidate === 'object'
            ? ((candidate as Record<string, unknown>).finishReason as unknown)
            : undefined,
        safetyRatings:
          candidate && typeof candidate === 'object'
            ? ((candidate as Record<string, unknown>).safetyRatings as unknown)
            : undefined
      })),
      usageMetadata: (response as { usageMetadata?: unknown }).usageMetadata,
      promptFeedback: (response as { promptFeedback?: unknown }).promptFeedback,
      modelVersion: (response as { modelVersion?: unknown }).modelVersion
    };
  }

  private pushEvent(eventName: string, payload: Record<string, unknown>): void {
    this.eventCounter++;
    try {
      const data = JSON.stringify(payload);
      this.push(`event: ${eventName}\ndata: ${data}\n\n`);
    } catch {
      // ignore serialization errors
    }
  }
}
