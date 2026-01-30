#!/usr/bin/env node
import express from 'express';
import cors from 'cors';
const fetch = globalThis.fetch;
import { randomUUID } from 'crypto';

const PORT = Number(process.env.COMPARE_PORT || process.argv[2]) || 5555;
const TARGET_BASE = process.env.CRS_BASE_URL?.trim() || 'https://capi.quan2go.com/openai';
const API_KEY = process.env.CRS_API_KEY?.trim();
const CODEx_UA = process.env.CODEX_UA?.trim() || 'codex_cli_rs/0.79.0 (Mac OS 15.7.3; arm64) iTerm.app/3.6.5';
const OPENAI_BETA = process.env.OPENAI_BETA_VERSION?.trim() || 'responses-2024-12-17';

if (!API_KEY) {
  console.error('[compare-server] Missing CRS_API_KEY environment variable.');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' }));

function buildCommonHeaders() {
  return {
    'Content-Type': 'application/json',
    'OpenAI-Beta': OPENAI_BETA,
    Authorization: `Bearer ${API_KEY}`,
    Accept: 'text/event-stream'
  };
}

function buildConversationId(req) {
  return (
    req.headers['conversation_id'] ||
    req.headers['Conversation-Id'] ||
    req.headers['session_id'] ||
    randomUUID()
  );
}

function buildRequestHeaders(mode, req) {
  const base = buildCommonHeaders();
  if (mode === 'chat') {
    return {
      ...base,
      'User-Agent': CODEx_UA,
      originator: 'codex_cli_rs',
      conversation_id: buildConversationId(req),
      session_id: buildConversationId(req)
    };
  }
  const inboundUa = req.headers['user-agent'];
  return {
    ...base,
    'User-Agent': inboundUa || 'curl/8.5.0'
  };
}

async function forward(mode, body, req) {
  const targetUrl = `${TARGET_BASE.replace(/\/$/, '')}/responses`;
  const headers = buildRequestHeaders(mode, req);
  const startedAt = Date.now();
  const response = await fetch(targetUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  const rawText = await response.text();
  const durationMs = Date.now() - startedAt;
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    parsed = rawText;
  }
  return {
    mode,
    ok: response.ok,
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    durationMs,
    body: parsed,
    targetUrl
  };
}

function handler(mode) {
  return async (req, res) => {
    try {
      const result = await forward(mode, req.body, req);
      res.status(result.status).json(result);
    } catch (error) {
      res.status(500).json({
        mode,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };
}

app.post('/passthrough/v1/responses', handler('passthrough'));
app.post('/chat/v1/responses', handler('chat'));
app.post('/compare/v1/responses', async (req, res) => {
  try {
    const [passthrough, chat] = await Promise.all([
      forward('passthrough', req.body, req),
      forward('chat', req.body, req)
    ]);
    res.json({ passthrough, chat });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.listen(PORT, () => {
  console.log('[compare-server] listening on http://127.0.0.1:' + PORT);
  console.log('[compare-server] targets PASSTHROUGH vs CHAT at', `${TARGET_BASE}/responses`);
});
