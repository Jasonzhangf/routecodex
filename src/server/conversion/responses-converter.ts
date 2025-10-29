import type { Request } from 'express';

/**
 * Minimal Responses converter helpers used by ResponsesHandler.
 * We keep logic intentionally small to avoid over-validation.
 */
export class ResponsesConverter {
  /**
   * Infer streaming flag only when not explicitly provided.
   * - If Accept header contains text/event-stream → true
   * - Else undefined (do not override existing values)
   */
  static inferStreamingFlag(body: unknown, req: Request): boolean | undefined {
    try {
      const hasStream = (body as any)?.stream;
      if (typeof hasStream === 'boolean') return hasStream;
    } catch { /* ignore */ }
    try {
      const accept = String(req.headers['accept'] || '').toLowerCase();
      if (accept.includes('text/event-stream')) return true;
    } catch { /* ignore */ }
    return undefined;
  }
}

