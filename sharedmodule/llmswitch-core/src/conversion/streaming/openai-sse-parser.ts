import { Readable } from 'stream';

/**
 * Minimal OpenAI SSE parser. Reads a Readable emitting Server-Sent Events where
 * payloads are carried in `data: ...` lines. Aggregates lines between blank
 * separators and yields parsed JSON objects. The special token "[DONE]" is
 * surfaced via onDone.
 */
export class OpenAISSEParser {
  private readonly src: Readable;
  private readonly onChunk: (obj: any) => void;
  private readonly onDone: () => void;
  private buffer = '';
  private ended = false;

  constructor(src: Readable, onChunk: (obj: any) => void, onDone: () => void) {
    this.src = src;
    this.onChunk = onChunk;
    this.onDone = onDone;
  }

  public start(): void {
    this.src.setEncoding('utf-8');
    this.src.on('data', (chunk: string) => this.onData(chunk));
    this.src.on('end', () => this.finish());
    this.src.on('error', () => this.finish());
  }

  private onData(chunk: string): void {
    if (this.ended) return;
    this.buffer += chunk;
    let idx: number;
    // Process line by line to respect SSE framing
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      const trimmed = line.trimEnd();
      if (trimmed.length === 0) {
        // delimiter between events — ignore
        continue;
      }
      if (trimmed.startsWith('data:')) {
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') {
          this.finish();
          return;
        }
        try {
          const obj = JSON.parse(payload);
          this.onChunk(obj);
        } catch {
          // ignore non-JSON data lines
        }
      }
      // ignore other SSE lines (event:, id:, retry:, comments)
    }
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    try { this.onDone(); } catch { /* ignore */ }
  }
}

