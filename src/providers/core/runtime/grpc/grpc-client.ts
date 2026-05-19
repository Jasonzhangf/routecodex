/**
 * HTTP/2 gRPC client — zero-dependency.
 * Ported from WindsurfAPI/src/grpc.js (Apache-2.0).
 */

import * as http2 from 'http2';
import { randomUUID } from 'crypto';

export const LS_SERVICE = '/exa.language_server_pb.LanguageServerService';

export function grpcFrame(payload: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([0]),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from([0, 0, 0, 0]),
    payload,
  ]);
}

export function stripGrpcFrame(buf: Buffer): Buffer {
  return buf.subarray(5);
}

export function extractGrpcFrames(buf: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 5 > buf.length) break;
    const compressed = buf[offset];
    const msgLen = buf.readUInt32BE(offset + 1);
    offset += 5;
    if (compressed !== 0 || offset + msgLen > buf.length) break;
    frames.push(buf.subarray(offset, offset + msgLen));
    offset += msgLen;
  }
  return frames;
}

export interface GrpcStreamCallbacks {
  onData?: (payload: Buffer) => void;
  onEnd?: () => void;
  onError?: (err: Error) => void;
}

const _sessions = new Map<string, http2.ClientHttp2Session>();

function getSession(port: number): http2.ClientHttp2Session {
  const key = 'localhost:' + String(port);
  let session = _sessions.get(key);
  if (!session || session.destroyed) {
    session = http2.connect('http://localhost:' + String(port));
    session.on('error', () => { _sessions.delete(key); });
    _sessions.set(key, session);
  }
  return session;
}

export function closeSessionForPort(port: number): void {
  const key = 'localhost:' + String(port);
  const session = _sessions.get(key);
  if (session) { session.close(); _sessions.delete(key); }
}

export async function grpcUnary(
  port: number,
  csrfToken: string,
  path: string,
  body: Buffer,
  timeout = 30000,
): Promise<Buffer> {
  const client = getSession(port);
  return new Promise((resolve, reject) => {
    const req = client.request({
      [http2.constants.HTTP2_HEADER_METHOD]: http2.constants.HTTP2_METHOD_POST,
      [http2.constants.HTTP2_HEADER_PATH]: path,
      [http2.constants.HTTP2_HEADER_CONTENT_TYPE]: 'application/grpc',
      [http2.constants.HTTP2_HEADER_USER_AGENT]: 'grpc-node/1.108.2',
      'x-csrf-token': csrfToken,
    });
    const timer = setTimeout(() => { req.close(http2.constants.NGHTTP2_CANCEL); reject(new Error('gRPC unary timeout')); }, timeout);
    let full = Buffer.alloc(0);
    let trailers: Record<string, string> = {};
    req.on('data', (chunk: Buffer) => { full = Buffer.concat([full, chunk]); });
    req.on('trailers', (t: Record<string, string>) => { trailers = t; });
    req.on('end', () => {
      clearTimeout(timer);
      let grpcStatus = '0', grpcMessage = '';
      try {
        grpcStatus = String(trailers['grpc-status'] ?? '0');
        grpcMessage = String(trailers['grpc-message'] ?? '');
      } catch {}
      if (grpcStatus !== '0') {
        const msg = grpcMessage ? decodeURIComponent(grpcMessage) : 'gRPC status ' + grpcStatus;
        reject(new Error(msg));
        return;
      }
      const frames = extractGrpcFrames(full);
      resolve(frames.length > 0 ? Buffer.concat(frames) : stripGrpcFrame(full));
    });
    req.on('error', (err: Error) => { clearTimeout(timer); reject(err); });
    req.write(body);
    req.end();
  });
}

export function grpcStream(
  port: number,
  csrfToken: string,
  path: string,
  body: Buffer,
  opts: GrpcStreamCallbacks = {},
): void {
  const client = getSession(port);
  let pendingBuf = Buffer.alloc(0);
  let done = false;

  const cleanup = () => { if (!done) { done = true; } };

  const timer = opts.onError
    ? setTimeout(() => { cleanup(); opts.onError?.(new Error('gRPC stream timeout')); }, 60000)
    : null;

  const req = client.request({
    [http2.constants.HTTP2_HEADER_METHOD]: http2.constants.HTTP2_METHOD_POST,
    [http2.constants.HTTP2_HEADER_PATH]: path,
    [http2.constants.HTTP2_HEADER_CONTENT_TYPE]: 'application/grpc',
    [http2.constants.HTTP2_HEADER_USER_AGENT]: 'grpc-node/1.108.2',
    'x-csrf-token': csrfToken,
    'grpc-accept-encoding': 'identity,gzip,deflate',
  });

  const flushPending = () => {
    while (pendingBuf.length >= 5) {
      const msgLen = pendingBuf.readUInt32BE(1);
      if (pendingBuf.length < 5 + msgLen) break;
      const payload = pendingBuf.subarray(5, 5 + msgLen);
      pendingBuf = pendingBuf.subarray(5 + msgLen);
      try { opts.onData?.(payload); } catch {}
    }
  };

  req.on('data', (chunk: Buffer) => {
    if (done) return;
    pendingBuf = Buffer.concat([pendingBuf, chunk]);
    flushPending();
    if (pendingBuf.length > 100 * 1024 * 1024) { cleanup(); opts.onError?.(new Error('gRPC frame too large (>100MB)')); }
  });

  let trailers: Record<string, string> = {};
  req.on('trailers', (t: Record<string, string>) => { trailers = t; });

  req.on('end', () => {
    if (timer) clearTimeout(timer);
    if (pendingBuf.length > 0) flushPending();
    let grpcStatus = '0', grpcMessage = '';
    try {
      grpcStatus = String(trailers['grpc-status'] ?? '0');
      grpcMessage = String(trailers['grpc-message'] ?? '');
    } catch {}
    cleanup();
    if (grpcStatus !== '0') {
      const msg = grpcMessage ? decodeURIComponent(grpcMessage) : 'gRPC status ' + grpcStatus;
      opts.onError?.(new Error(msg));
    } else {
      opts.onEnd?.();
    }
  });

  req.on('error', (err: Error) => {
    if (timer) clearTimeout(timer);
    cleanup();
    opts.onError?.(err);
  });

  req.write(body);
  req.end();
}
