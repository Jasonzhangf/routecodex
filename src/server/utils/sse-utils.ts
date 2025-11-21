import type { Request, Response } from 'express';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { PassThrough, Readable } from 'node:stream';

export type SSELogger = { write: (line: string) => Promise<void> };

export function wantsSSE(req: Request, payload: any): boolean {
  try {
    const accept = String(req.headers['accept'] || '').toLowerCase();
    if (accept.includes('text/event-stream')) return true;
  } catch { /* ignore */ }
  try { return payload?.stream === true; } catch { return false; }
}

export function setSSEHeaders(res: Response): void {
  try {
    if (res.headersSent) return;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    (res as any).flushHeaders?.();
  } catch { /* ignore */ }
}

export function createSSELogger(requestId: string, entryEndpoint: string): SSELogger {
  try {
    const dir = path.join(os.homedir(), '.routecodex', 'logs', 'sse');
    const file = path.join(dir, `${requestId}_server.sse.log`);
    const ensure = async () => { try { await fsp.mkdir(dir, { recursive: true }); } catch { /* ignore */ } };
    return {
      async write(s: string) {
        try { await ensure(); await fsp.appendFile(file, `[${new Date().toISOString()}] ${s}`, 'utf-8'); } catch { /* ignore */ }
      }
    };
  } catch {
    return { async write(_s: string) { /* noop */ } } as SSELogger;
  }
}

export function startPreHeartbeat(res: Response, sseLogger: SSELogger): () => void {
  setSSEHeaders(res);
  const iv = Math.max(1000, Number(process.env.ROUTECODEX_STREAM_HEARTBEAT_MS || process.env.RCC_STREAM_HEARTBEAT_MS || 15000));
  const writeBeat = () => { try { const s = `: pre-heartbeat ${Date.now()}\n\n`; res.write(s); sseLogger.write(s).catch(()=>{}); } catch { /* ignore */ } };
  writeBeat();
  const timer = setInterval(writeBeat, iv);
  return () => { try { clearInterval(timer); } catch { /* ignore */ } };
}

export async function pipeUpstreamSSE(res: Response, upstream: Readable, sseLogger: SSELogger): Promise<void> {
  setSSEHeaders(res);
  try {
    const tee = new PassThrough();
    upstream.pipe(tee);
    tee.on('data', (chunk: Buffer) => { try { sseLogger.write(chunk.toString()).catch(()=>{}); } catch { /* ignore */ } });
    tee.pipe(res);
  } catch {
    upstream.pipe(res);
  }
}

export function sendChatSSEError(res: Response, status: number, error: unknown, sseLogger: SSELogger): void {
  try { if (!res.headersSent) { try { res.status(status); } catch {} setSSEHeaders(res); } } catch { /* ignore */ }
  try {
    const line = `data: ${JSON.stringify({ error: { message: String((error as any)?.message || 'Upstream error'), code: String((error as any)?.code || 'UPSTREAM_ERROR'), http_status: status } })}\n\n`;
    res.write(line); sseLogger.write(line).catch(()=>{});
    const done = 'data: [DONE]\n\n'; res.write(done); sseLogger.write(done).catch(()=>{});
  } catch { /* ignore */ }
  try { res.end(); } catch { /* ignore */ }
}

export function synthesizeChatSSE(res: Response, chatJson: any, sseLogger: SSELogger): void {
  setSSEHeaders(res);
  const now = Math.floor(Date.now() / 1000);
  const model = (chatJson && typeof chatJson === 'object' && (chatJson as any).model) ? String((chatJson as any).model) : 'unknown';
  const cid = (chatJson && typeof chatJson === 'object' && (chatJson as any).id) ? String((chatJson as any).id) : `chatcmpl_${Date.now()}`;
  const content = (() => {
    try {
      const choices = Array.isArray((chatJson as any)?.choices) ? (chatJson as any).choices : [];
      const primary = choices[0] && typeof choices[0] === 'object' ? choices[0] : {};
      const msg = (primary as any).message || {};
      const c = (msg as any).content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) return c.map((x: any) => (typeof x === 'string' ? x : (typeof x?.text === 'string' ? x.text : ''))).join('');
      if (typeof c?.text === 'string') return String(c.text);
    } catch { /* ignore */ }
    return '';
  })();

  const writeData = (obj: any) => { const line = `data: ${JSON.stringify(obj)}\n\n`; res.write(line); sseLogger.write(line).catch(()=>{}); };
  // 首帧
  writeData({ id: cid, object: 'chat.completion.chunk', created: now, model, choices: [ { index: 0, delta: { role: 'assistant' }, finish_reason: null } ] });
  // 内容分片
  if (content && content.length) {
    const chunkSize = Math.max(16, Math.min(2048, Number(process.env.ROUTECODEX_SYNTHETIC_CHUNK || 512)));
    for (let i = 0; i < content.length; i += chunkSize) {
      const delta = content.slice(i, i + chunkSize);
      writeData({ id: cid, object: 'chat.completion.chunk', created: now, model, choices: [ { index: 0, delta: { content: delta }, finish_reason: null } ] });
    }
  }
  // 结束帧
  writeData({ id: cid, object: 'chat.completion.chunk', created: now, model, choices: [ { index: 0, delta: {}, finish_reason: 'stop' } ] });
  const done = 'data: [DONE]\n\n'; res.write(done); sseLogger.write(done).catch(()=>{});
}

export function sendResponsesSSEError(res: Response, status: number, error: unknown, sseLogger: SSELogger): void {
  try { if (!res.headersSent) { try { res.status(status); } catch {} setSSEHeaders(res); } } catch { /* ignore */ }
  try {
    const s1 = `event: response.error\n`;
    const s2 = `data: ${JSON.stringify({ type:'response.error', error: { message: String((error as any)?.message || 'Upstream error'), code: String((error as any)?.code || 'UPSTREAM_ERROR'), type: 'upstream_error', http_status: status } })}\n\n`;
    res.write(s1); res.write(s2); sseLogger.write(s1).catch(()=>{}); sseLogger.write(s2).catch(()=>{});
    const done = 'data: [DONE]\n\n'; res.write(done); sseLogger.write(done).catch(()=>{});
  } catch { /* ignore */ }
  try { res.end(); } catch { /* ignore */ }
}

export function synthesizeResponsesSSE(res: Response, responsesJson: any, sseLogger: SSELogger): void {
  setSSEHeaders(res);
  const nowSec = Math.floor(Date.now() / 1000);
  const id = (responsesJson && typeof responsesJson === 'object' && (responsesJson as any).id) ? String((responsesJson as any).id) : `resp_${Date.now()}`;
  const model = (responsesJson && typeof responsesJson === 'object' && (responsesJson as any).model) ? String((responsesJson as any).model) : 'unknown';
  const writeEvt = (name: string, obj: any) => { const s1 = `event: ${name}\n`; const s2 = `data: ${JSON.stringify(obj)}\n\n`; res.write(s1); res.write(s2); sseLogger.write(s1).catch(()=>{}); sseLogger.write(s2).catch(()=>{}); };
  // created
  writeEvt('response.created', { type: 'response.created', response: { id, object: 'response', created_at: nowSec, model } });
  // output: 初始块
  writeEvt('response.output_text.delta', { type: 'response.output_text.delta', delta: '' });
  // done with deltas
  try {
    const text = (responsesJson && typeof responsesJson === 'object' && typeof (responsesJson as any).output_text === 'string') ? String((responsesJson as any).output_text) : '';
    if (text && text.length) {
      const chunkSize = Math.max(16, Math.min(2048, Number(process.env.ROUTECODEX_SYNTHETIC_CHUNK || 512)));
      for (let i = 0; i < text.length; i += chunkSize) {
        const delta = text.slice(i, i + chunkSize);
        writeEvt('response.output_text.delta', { type: 'response.output_text.delta', delta });
      }
      writeEvt('response.output_text.done', { type: 'response.output_text.done' });
    }
  } catch { /* ignore */ }
  const usage = (responsesJson && typeof responsesJson === 'object' && (responsesJson as any).usage) ? (responsesJson as any).usage : undefined;
  writeEvt('response.completed', { type: 'response.completed', response: { id, object: 'response', created_at: nowSec, model, status: 'completed' }, usage });
  const done = 'data: [DONE]\n\n'; res.write(done); sseLogger.write(done).catch(()=>{});
}

