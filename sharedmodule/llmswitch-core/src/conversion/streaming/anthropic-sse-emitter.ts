import type { Response } from 'express';

/**
 * Minimal Anthropic SSE emitter. Writes events either with explicit `event:`
 * header or as plain `data:` only. Default is explicit event headers for
 * better client compatibility.
 */
export class AnthropicSSEEmitter {
  private readonly res: Response;
  private readonly useEventHeaders: boolean;

  constructor(res: Response, opts?: { eventHeaders?: boolean }) {
    this.res = res;
    this.useEventHeaders = opts?.eventHeaders !== false; // default true
  }

  writeEvent(event: string, data: Record<string, unknown>): void {
    const json = JSON.stringify(data);
    if (this.useEventHeaders) {
      this.res.write(`event: ${event}\n`);
      this.res.write(`data: ${json}\n\n`);
    } else {
      // data-only fallback
      this.res.write(`data: ${json}\n\n`);
    }
  }

  end(): void {
    // Anthropic streams conclude with message_stop event
    if (this.useEventHeaders) {
      this.res.write(`event: message_stop\n`);
      this.res.write(`data: {"type":"message_stop"}\n\n`);
    } else {
      this.res.write(`data: {"type":"message_stop"}\n\n`);
    }
    this.res.end();
  }
}
