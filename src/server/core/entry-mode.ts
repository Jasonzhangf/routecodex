import type { Request } from 'express';

export function resolveOutputMode(req: Request, payload: any): 'sse' | 'json' {
  try {
    const q = (req.query || {}) as Record<string, any>;
    const accept = String(req.headers['accept'] || '').toLowerCase();
    if (accept.includes('text/event-stream')) return 'sse';
    const wants = (payload && typeof payload === 'object' && payload.stream === true) || String(q.stream) === 'true';
    return wants ? 'sse' : 'json';
  } catch {
    return 'json';
  }
}

