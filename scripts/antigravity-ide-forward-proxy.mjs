#!/usr/bin/env node
/**
 * Antigravity IDE forward proxy (best-effort recorder).
 *
 * - Supports HTTP proxy requests (absolute-form) and CONNECT tunneling.
 * - Logs what it can see (CONNECT targets, HTTP method/url/status).
 * - Does NOT MITM TLS; HTTPS payloads remain encrypted unless the client uses a MITM-capable proxy.
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = String(argv[i] ?? '');
    if (!raw.startsWith('--')) {
      continue;
    }
    const eq = raw.indexOf('=');
    if (eq > 0) {
      const k = raw.slice(2, eq);
      const v = raw.slice(eq + 1);
      out[k] = v;
      continue;
    }
    const k = raw.slice(2);
    const next = argv[i + 1];
    if (next && !String(next).startsWith('--')) {
      out[k] = String(next);
      i += 1;
      continue;
    }
    out[k] = true;
  }
  return out;
}

function toInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function createJsonlLogger(options) {
  const logFile = typeof options.logFile === 'string' && options.logFile.trim() ? options.logFile.trim() : null;
  const stream = logFile ? fs.createWriteStream(logFile, { flags: 'a' }) : null;

  function write(entry) {
    const line = `${JSON.stringify(entry)}\n`;
    if (stream) {
      stream.write(line);
      return;
    }
    process.stdout.write(line);
  }

  function close() {
    try {
      stream?.end();
    } catch {
      // ignore
    }
  }

  return { write, close, logFile };
}

function redactHeaders(headers) {
  const out = {};
  const redacted = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-goog-api-key']);
  for (const [k, v] of Object.entries(headers ?? {})) {
    const key = String(k).toLowerCase();
    if (redacted.has(key)) {
      out[k] = '<redacted>';
      continue;
    }
    out[k] = v;
  }
  return out;
}

function stripHopByHopHeaders(headers) {
  const out = { ...(headers ?? {}) };
  const hopByHop = [
    'connection',
    'proxy-connection',
    'keep-alive',
    'transfer-encoding',
    'te',
    'trailer',
    'upgrade',
    'proxy-authorization'
  ];
  for (const h of hopByHop) {
    for (const key of Object.keys(out)) {
      if (String(key).toLowerCase() === h) {
        delete out[key];
      }
    }
  }
  return out;
}

function safeUrlForLog(url) {
  const raw = typeof url === 'string' ? url : '';
  // Keep as-is: do not attempt to parse/normalize (some clients send non-standard forms).
  return raw.length > 4096 ? `${raw.slice(0, 4096)}…` : raw;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const host = String(args.host || '127.0.0.1');
  const port = toInt(args.port || 8080, 8080);
  const logFile = typeof args['log-file'] === 'string' ? args['log-file'] : null;
  const recordBody = String(args['record-body'] || '').trim() === '1' || args['record-body'] === true;
  const maxBodyBytes = toInt(args['max-body-bytes'] || 4096, 4096);

  const logger = createJsonlLogger({ logFile });

  const server = http.createServer((req, res) => {
    const id = randomUUID();
    const startedAt = Date.now();
    const method = String(req.method || 'GET');
    const rawUrl = String(req.url || '');

    let parsed;
    try {
      // Proxy requests use absolute-form (RFC 9110). Fallback to host header for origin-form.
      parsed = rawUrl.startsWith('http://') || rawUrl.startsWith('https://')
        ? new URL(rawUrl)
        : null;
    } catch {
      parsed = null;
    }

    const targetProtocol = parsed?.protocol || 'http:';
    const targetHost = parsed?.hostname || String(req.headers.host || '');
    const targetPort =
      parsed?.port
        ? Number(parsed.port)
        : targetProtocol === 'https:'
          ? 443
          : 80;
    const targetPath = parsed ? `${parsed.pathname || '/'}${parsed.search || ''}` : rawUrl || '/';

    const requestHeaders = stripHopByHopHeaders(req.headers);
    if (targetHost) {
      requestHeaders.host = targetHost;
    }

    let reqBodyBufs = [];
    let reqBodyBytes = 0;

    const client = targetProtocol === 'https:' ? https : http;
    const upstreamReq = client.request(
      {
        protocol: targetProtocol,
        hostname: targetHost,
        port: targetPort,
        method,
        path: targetPath,
        headers: requestHeaders
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        let resBytes = 0;
        upstreamRes.on('data', (chunk) => {
          resBytes += chunk?.length || 0;
        });
        upstreamRes.on('end', () => {
          const durationMs = Date.now() - startedAt;
          let requestBodyText = null;
          if (recordBody && reqBodyBufs.length) {
            try {
              requestBodyText = Buffer.concat(reqBodyBufs).toString('utf8');
            } catch {
              requestBodyText = null;
            }
          }
          logger.write({
            ts: nowIso(),
            kind: 'http',
            id,
            method,
            url: safeUrlForLog(rawUrl),
            target: {
              protocol: targetProtocol,
              host: targetHost,
              port: targetPort,
              path: targetPath
            },
            request: {
              headers: redactHeaders(req.headers),
              ...(recordBody ? { body: requestBodyText } : {})
            },
            response: {
              statusCode: upstreamRes.statusCode || null,
              bytes: resBytes
            },
            durationMs
          });
        });
        upstreamRes.pipe(res);
      }
    );

    upstreamReq.on('error', (err) => {
      const durationMs = Date.now() - startedAt;
      logger.write({
        ts: nowIso(),
        kind: 'http',
        id,
        method,
        url: safeUrlForLog(rawUrl),
        target: { protocol: targetProtocol, host: targetHost, port: targetPort, path: targetPath },
        error: { name: err?.name || 'Error', message: err?.message || String(err) },
        durationMs
      });
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      }
      res.end('Bad Gateway');
    });

    req.on('data', (chunk) => {
      if (!recordBody) {
        return;
      }
      if (!chunk) {
        return;
      }
      const nextBytes = reqBodyBytes + (chunk.length || 0);
      if (nextBytes > maxBodyBytes) {
        const remaining = Math.max(0, maxBodyBytes - reqBodyBytes);
        if (remaining > 0) {
          reqBodyBufs.push(chunk.subarray(0, remaining));
          reqBodyBytes += remaining;
        }
        return;
      }
      reqBodyBufs.push(chunk);
      reqBodyBytes = nextBytes;
    });

    req.pipe(upstreamReq);
  });

  server.on('connect', (req, clientSocket, head) => {
    const id = randomUUID();
    const startedAt = Date.now();
    const rawUrl = String(req.url || '');
    const [host, portRaw] = rawUrl.split(':');
    const targetHost = String(host || '').trim();
    const targetPort = toInt(portRaw || 443, 443);

    logger.write({
      ts: nowIso(),
      kind: 'connect_start',
      id,
      target: { host: targetHost, port: targetPort },
      request: { url: safeUrlForLog(rawUrl), headers: redactHeaders(req.headers) }
    });

    const upstreamSocket = net.connect(targetPort, targetHost, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) {
        upstreamSocket.write(head);
      }
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);
    });

    let c2u = 0;
    let u2c = 0;
    clientSocket.on('data', (chunk) => {
      c2u += chunk?.length || 0;
    });
    upstreamSocket.on('data', (chunk) => {
      u2c += chunk?.length || 0;
    });

    let finished = false;
    const finish = (extra) => {
      if (finished) {
        return;
      }
      finished = true;
      const durationMs = Date.now() - startedAt;
      logger.write({
        ts: nowIso(),
        kind: 'connect_end',
        id,
        target: { host: targetHost, port: targetPort },
        request: { url: safeUrlForLog(rawUrl), headers: redactHeaders(req.headers) },
        tunnel: { bytesClientToUpstream: c2u, bytesUpstreamToClient: u2c },
        durationMs,
        ...(extra ? { extra } : {})
      });
    };

    upstreamSocket.on('error', (err) => {
      try {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      } catch {
        // ignore
      }
      finish({ error: { name: err?.name || 'Error', message: err?.message || String(err) } });
      try { clientSocket.destroy(); } catch { /* ignore */ }
    });

    clientSocket.on('error', (err) => {
      finish({ clientError: { name: err?.name || 'Error', message: err?.message || String(err) } });
      try { upstreamSocket.destroy(); } catch { /* ignore */ }
    });

    clientSocket.on('close', () => finish({ closedBy: 'client' }));
    upstreamSocket.on('close', () => finish({ closedBy: 'upstream' }));
  });

  server.on('clientError', (err, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } catch {
      // ignore
    }
    logger.write({ ts: nowIso(), kind: 'client_error', error: { name: err?.name || 'Error', message: err?.message || String(err) } });
  });

  const shutdown = () => {
    try { logger.close(); } catch { /* ignore */ }
    try { server.close(); } catch { /* ignore */ }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  server.listen(port, host, () => {
    const addr = server.address();
    const bind = typeof addr === 'object' && addr ? `${addr.address}:${addr.port}` : `${host}:${port}`;
    logger.write({
      ts: nowIso(),
      kind: 'startup',
      bind,
      logFile: logger.logFile,
      recordBody,
      maxBodyBytes,
      note: 'Forward proxy started. HTTPS payloads are encrypted unless using a MITM proxy.'
    });
  });
}

main().catch((err) => {
  process.stderr.write(`proxy failed: ${err?.message || String(err)}\n`);
  process.exit(1);
});
