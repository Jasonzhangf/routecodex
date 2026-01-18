#!/usr/bin/env node
/**
 * Antigravity upstream smoke test (direct provider call).
 *
 * Purpose:
 * - Hit Antigravity (Cloud Code Assist) upstream using Gemini CLI HTTP provider.
 * - Validate request shaping is accepted (especially "no body.request.request.*").
 *
 * Usage:
 *   node scripts/antigravity-smoke.mjs
 *
 * Required:
 *   - A valid Antigravity OAuth token file (JSON), e.g.
 *     ~/.routecodex/auth/antigravity-oauth-1-<alias>.json
 *   - Export env:
 *       ANTIGRAVITY_TOKEN_FILE=/absolute/path/to/token.json
 *
 * Optional:
 *   ANTIGRAVITY_BASEURL=https://daily-cloudcode-pa.sandbox.googleapis.com
 *   ANTIGRAVITY_MODEL=gemini-3-pro-high
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GeminiCLIHttpProvider } from '../dist/providers/core/runtime/gemini-cli-http-provider.js';
import { GeminiSseToJsonConverter } from '../sharedmodule/llmswitch-core/dist/sse/sse-to-json/index.js';

function resolveTokenFile() {
  const raw =
    (process.env.ANTIGRAVITY_TOKEN_FILE && process.env.ANTIGRAVITY_TOKEN_FILE.trim()) ||
    (process.env.ROUTECODEX_ANTIGRAVITY_TOKEN_FILE && process.env.ROUTECODEX_ANTIGRAVITY_TOKEN_FILE.trim()) ||
    (process.env.RCC_ANTIGRAVITY_TOKEN_FILE && process.env.RCC_ANTIGRAVITY_TOKEN_FILE.trim()) ||
    '';
  if (raw) {
    const expanded = raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw;
    return path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
  }
  const authDir = path.join(os.homedir(), '.routecodex', 'auth');
  const defaultPath = path.join(authDir, 'antigravity-oauth.json');
  if (fs.existsSync(defaultPath)) {
    return defaultPath;
  }
  try {
    const candidates = fs
      .readdirSync(authDir)
      .filter((name) => name.startsWith('antigravity-oauth-') && name.endsWith('.json'))
      .map((name) => path.join(authDir, name));
    if (!candidates.length) {
      return defaultPath;
    }
    candidates.sort((a, b) => {
      try {
        return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
      } catch {
        return 0;
      }
    });
    return candidates[0];
  } catch {
    return defaultPath;
  }
}

function extractTextFromGeminiResponse(payload) {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  const primary = candidates[0] && typeof candidates[0] === 'object' ? candidates[0] : null;
  const parts = primary?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p) => (p && typeof p === 'object' && typeof p.text === 'string' ? p.text : ''))
    .filter((s) => s.trim().length > 0)
    .join('')
    .trim();
}

async function decodeGeminiSse(stream, requestId) {
  const converter = new GeminiSseToJsonConverter();
  return await converter.convertSseToJson(stream, { requestId });
}

async function main() {
  const tokenFile = resolveTokenFile();
  if (!fs.existsSync(tokenFile)) {
    console.error(`[antigravity-smoke] Missing token file: ${tokenFile}`);
    console.error('[antigravity-smoke] Create one via: `node scripts/auth-antigravity-token.mjs`');
    process.exit(2);
  }

  const baseUrl =
    (process.env.ANTIGRAVITY_BASEURL && process.env.ANTIGRAVITY_BASEURL.trim()) ||
    'https://daily-cloudcode-pa.sandbox.googleapis.com';
  const model =
    (process.env.ANTIGRAVITY_MODEL && process.env.ANTIGRAVITY_MODEL.trim()) || 'gemini-3-pro-high';

  const config = {
    id: 'antigravity-smoke',
    config: {
      // IMPORTANT: Antigravity uses Gemini CLI protocol (Cloud Code Assist v1internal).
      providerType: 'gemini',
      providerId: 'antigravity',
      baseUrl,
      auth: {
        type: 'antigravity-oauth',
        apiKey: '',
        tokenFile
      },
      overrides: { maxRetries: 0 }
    }
  };

  const dependencies = {
    logger: { logModule: () => {}, logProviderRequest: () => {} },
    errorHandlingCenter: { handleError: async () => {} }
  };

  const provider = new GeminiCLIHttpProvider(config, dependencies);
  await provider.initialize();

  const buildPayload = ({ nestedRequest }) => {
    const core = {
      model,
      contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: pong' }] }],
      // Antigravity agent runtime may spend a portion of maxOutputTokens on internal thoughts.
      // Use a sufficiently high value so we can reliably observe a visible text response.
      generationConfig: { maxOutputTokens: 256 }
    };
    if (nestedRequest) {
      // This intentionally mimics an illegal intermediate shape that used to produce
      // `body.request.request.*` after protocol-client wrapping. Provider preprocess
      // must flatten it before sending upstream.
      return { model, request: { contents: core.contents, generationConfig: core.generationConfig } };
    }
    return core;
  };

  for (const variant of [
    { name: 'top_level_contents', nestedRequest: false },
    { name: 'nested_request_container', nestedRequest: true }
  ]) {
    const maxAttempts = 3;
    let lastDecoded = null;
    let okText = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const requestId = `antigravity-smoke-${variant.name}-a${attempt}-${Date.now()}`;
      const request = { data: buildPayload(variant) };
      const res = await provider.sendRequest(request);
      const stream = res?.__sse_responses || res?.data?.__sse_responses;
      if (!stream) {
        console.error(`[antigravity-smoke] Missing SSE stream for ${variant.name} (attempt ${attempt}/${maxAttempts})`);
        console.error(JSON.stringify(res?.data ?? res).slice(0, 800));
        process.exit(3);
      }
      const decoded = await decodeGeminiSse(stream, requestId);
      lastDecoded = decoded;
      const text = extractTextFromGeminiResponse(decoded);
      if (text && text.toLowerCase().includes('pong')) {
        okText = text;
        break;
      }
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (!okText) {
      console.error(`[antigravity-smoke] Unexpected response for ${variant.name}`);
      console.error(JSON.stringify(lastDecoded).slice(0, 1200));
      process.exit(4);
    }
    console.log(`[antigravity-smoke] OK ${variant.name}: ${JSON.stringify(okText).slice(0, 120)}`);
  }

  console.log('[antigravity-smoke] done');
}

main().catch((err) => {
  console.error('[antigravity-smoke] Error:', err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
