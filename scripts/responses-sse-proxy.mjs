#!/usr/bin/env node
// Standalone SSE passthrough proxy for /v1/responses.
// Captures inbound/outbound SSE streams and forwards them to the configured provider.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';

const DEFAULT_PORT = Number(process.env.RCC_RESP_PROXY_PORT || 9550);
const DEFAULT_HOST = process.env.RCC_RESP_PROXY_HOST || '127.0.0.1';
const providerId = process.env.RCC_RESP_PROV || getArg('--provider') || 'fai';
const port = Number(getArg('--port') || DEFAULT_PORT);
const host = getArg('--host') || DEFAULT_HOST;

const PROVIDER_ROOT = path.join(os.homedir(), '.routecodex', 'provider');
const CAPTURE_ROOT = path.join(os.homedir(), '.routecodex', 'codex-samples', 'openai-responses', 'sse-proxy');

function getArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  return null;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function loadProviderConfig(id) {
  const baseDir = path.join(PROVIDER_ROOT, id);
  const candidates = ['config.v1.json', 'config.json'];
  for (const file of candidates) {
    const candidatePath = path.join(baseDir, file);
    if (fs.existsSync(candidatePath)) {
      const doc = JSON.parse(fs.readFileSync(candidatePath, 'utf-8'));
      const providers = doc?.virtualrouter?.providers || {};
      if (providers[id]) {
        return providers[id];
      }
    }
  }
  throw new Error(`Unable to find provider entry for ${id}`);
}

function normalizeBaseUrl(entry) {
  const base = entry?.baseURL || entry?.baseUrl || '';
  if (!base) throw new Error('Provider baseURL missing');
  return String(base).replace(/\/$/, '');
}

function buildHeaders(entry) {
  const headers = {
    'OpenAI-Beta': 'responses-2024-12-17',
    'Accept': 'text/event-stream',
    'Content-Type': 'text/event-stream'
  };
  const auth = entry?.auth;
  if (auth?.type === 'apikey' && auth.apiKey) {
    headers['Authorization'] = `Bearer ${auth.apiKey}`;
  }
  return headers;
}

async function main() {
  ensureDir(CAPTURE_ROOT);
  const providerEntry = loadProviderConfig(providerId);
  const baseUrl = normalizeBaseUrl(providerEntry);
  const endpoint = '/responses';
  const headers = buildHeaders(providerEntry);
  const httpClientPath = pathToFileURL(path.join(process.cwd(), 'dist/modules/pipeline/modules/provider/v2/utils/http-client.js')).href;
  const { HttpClient } = await import(httpClientPath);
  const client = new HttpClient({ baseUrl, timeout: 300000 });

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || !(req.url || '').startsWith('/v1/responses')) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }

    const requestId = `capture_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const captureDir = path.join(CAPTURE_ROOT, requestId);
    ensureDir(captureDir);
    const meta = {
      requestId,
      time: new Date().toISOString(),
      clientHeaders: req.headers,
      upstream: `${baseUrl}${endpoint}`
    };
    fs.writeFileSync(path.join(captureDir, 'meta.json'), JSON.stringify(meta, null, 2));

    const upstreamStream = new PassThrough();
    const reqLog = fs.createWriteStream(path.join(captureDir, 'request.sse.log'));
    req.on('data', (chunk) => {
      upstreamStream.write(chunk);
      reqLog.write(chunk);
    });
    req.on('end', () => {
      upstreamStream.end();
      reqLog.end();
    });
    req.on('error', (error) => {
      upstreamStream.destroy(error);
      reqLog.end();
    });

    try {
      const upstream = await client.postStreamRaw(endpoint, upstreamStream, headers);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      const respLog = fs.createWriteStream(path.join(captureDir, 'response.sse.log'));
      upstream.on('data', (chunk) => {
        respLog.write(chunk);
        res.write(chunk);
      });
      upstream.on('end', () => {
        respLog.end();
        res.end();
        console.log(`[responses-sse-proxy] completed ${requestId}`);
      });
      upstream.on('error', (error) => {
        respLog.end();
        if (!res.writableEnded) {
          res.write(`event: error\ndata: ${JSON.stringify({ message: error.message })}\n\n`);
          res.end();
        }
      });
      req.on('close', () => {
        upstream.destroy();
      });
    } catch (error) {
      if (!res.headersSent) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
      }
      res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
    }
  });

  server.listen(port, host, () => {
    console.log(`[responses-sse-proxy] listening on http://${host}:${port}/v1/responses`);
    console.log(`[responses-sse-proxy] forwarding to ${baseUrl}${endpoint}`);
    console.log(`[responses-sse-proxy] captures stored under ${CAPTURE_ROOT}`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('[responses-sse-proxy] failed:', error);
  process.exit(1);
});
