import type { ServerResponse } from 'node:http';
import type { Readable } from 'node:stream';

type AnyObj = Record<string, unknown>;

function isReadable(v: unknown): v is Readable {
  return !!v && typeof (v as any).pipe === 'function';
}

function setSSEHeadersRaw(res: ServerResponse) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
}

/**
 * Pipe an SSE Readable to Node http.ServerResponse
 */
export function sendNodeSSE(res: ServerResponse, stream: Readable) {
  setSSEHeadersRaw(res);
  // Write initial comment to establish stream in some proxies
  try { res.write(': ok\n\n'); } catch { /* ignore */ }
  stream.on('data', (chunk) => {
    res.write(typeof chunk === 'string' ? chunk : chunk.toString());
  });
  stream.on('end', () => {
    try { res.write(':\n\n'); } catch { /* ignore */ }
    res.end();
  });
  stream.on('error', (err) => {
    try {
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify({ message: String(err?.message || 'sse_error') })}\n\n`);
    } catch { /* ignore */ }
    res.end();
  });
}

/**
 * Express response variant (duck-typed): res.set, res.write, res.end
 */
export function sendExpressSSE(res: AnyObj, stream: Readable) {
  if (typeof res.set === 'function') {
    res.set('Content-Type', 'text/event-stream; charset=utf-8');
    res.set('Cache-Control', 'no-cache, no-transform');
    res.set('Connection', 'keep-alive');
  } else if (typeof (res as any).setHeader === 'function') {
    setSSEHeadersRaw(res as unknown as ServerResponse);
  }
  try { (res as any).write(': ok\n\n'); } catch { /* ignore */ }
  stream.on('data', (chunk) => (res as any).write(typeof chunk === 'string' ? chunk : chunk.toString()));
  stream.on('end', () => (res as any).end());
  stream.on('error', (err) => {
    try {
      (res as any).write(`event: error\n`);
      (res as any).write(`data: ${JSON.stringify({ message: String(err?.message || 'sse_error') })}\n\n`);
    } catch { /* ignore */ }
    (res as any).end();
  });
}

/**
 * Fastify reply variant: reply.raw is ServerResponse
 */
export function sendFastifySSE(reply: AnyObj, stream: Readable) {
  const raw: ServerResponse | undefined = (reply && (reply as any).raw) as any;
  if (raw) return sendNodeSSE(raw, stream);
  // fallback to express-like
  return sendExpressSSE(reply, stream);
}

/**
 * If the given payload contains __sse_responses or sseStream, stream it via the provided response object.
 * Otherwise, send JSON.
 * - Supported responders: Node ServerResponse, Express res, Fastify reply
 */
export function sendSSEOrJSON(resOrReply: AnyObj, payload: AnyObj) {
  const stream = (payload as any).__sse_responses || (payload as any).sseStream;
  if (isReadable(stream)) {
    // detect responder flavor
    if (typeof (resOrReply as any).raw !== 'undefined') return sendFastifySSE(resOrReply, stream);
    if (typeof (resOrReply as any).setHeader === 'function') return sendNodeSSE(resOrReply as unknown as ServerResponse, stream);
    return sendExpressSSE(resOrReply, stream);
  }
  // Fallback JSON
  const jsonTxt = JSON.stringify(payload);
  if (typeof (resOrReply as any).json === 'function') return (resOrReply as any).json(payload);
  if (typeof (resOrReply as any).send === 'function') return (resOrReply as any).send(jsonTxt);
  if (typeof (resOrReply as any).end === 'function') {
    try { (resOrReply as any).setHeader?.('Content-Type', 'application/json; charset=utf-8'); } catch { /* ignore */ }
    return (resOrReply as any).end(jsonTxt);
  }
}
