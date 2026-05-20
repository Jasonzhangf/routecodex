#!/usr/bin/env node
/**
 * Windsurf gRPC dry-run — uses dist compiled modules.
 * Pre-init RPCs + RawGetChatMessage stream.
 */
import { randomUUID } from 'node:crypto';
import { writeVarintField, writeStringField, writeMessageField } from '../../dist/providers/core/runtime/grpc/proto.js';
import { grpcFrame, grpcUnary, grpcStream, LS_SERVICE } from '../../dist/providers/core/runtime/grpc/grpc-client.js';
import { buildRawGetChatMessageRequest, parseRawResponse } from '../../dist/providers/core/runtime/grpc/windsurf-grpc-bridge.js';

const PORT = Number(process.env.LS_PORT || 49485);
const CSRF = process.env.LS_CSRF || 'ce845714-6ac1-45b4-b684-fcddb6c099ce';
const API_KEY = process.env.WS_API_KEY || 'bZbMfJl1olXJ';

const boolField = (f, v) => v ? writeVarintField(f, 1) : Buffer.alloc(0);

function buildMetadata(sessionId) {
  return Buffer.concat([
    writeStringField(1, 'windsurf'), writeStringField(2, '2.0.67'), writeStringField(3, API_KEY),
    writeStringField(4, 'en'), writeStringField(5, 'macos'), writeStringField(7, '2.0.67'),
    writeStringField(8, 'arm64'), writeVarintField(9, 123), writeStringField(10, sessionId), writeStringField(12, 'windsurf'),
  ]);
}

async function unary(name, payload) {
  try {
    const raw = await grpcUnary(PORT, CSRF, `${LS_SERVICE}/${name}`, grpcFrame(payload), 8000);
    return { ok: true, bodyLen: raw.length };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

async function main() {
  const sessionId = randomUUID();
  const metadata = buildMetadata(sessionId);
  const workspace = `/tmp/ws-${sessionId.slice(0, 8)}`;

  console.log(`[windsurf-dry-run] PORT=${PORT} CSRF=${CSRF.slice(0, 8)}... API_KEY=${API_KEY.slice(0, 8)}...`);
  console.log('');

  for (const [name, req] of [
    ['InitializeCascadePanelState', Buffer.concat([writeMessageField(1, metadata), boolField(3, true)])],
    ['AddTrackedWorkspace', writeStringField(1, workspace)],
    ['UpdateWorkspaceTrust', Buffer.concat([writeMessageField(1, metadata), boolField(2, true)])],
    ['Heartbeat', writeMessageField(1, metadata)],
  ]) {
    const r = await unary(name, req);
    if (r.ok) console.log(`[${name}] OK bodyLen=${r.bodyLen}`);
    else console.log(`[${name}] FAIL: ${r.err}`);
  }

  console.log('');
  // RawGetChatMessage — modelEnum=226 = claude-3.7-sonnet, modelUid="claude-sonnet-4.6"
  const reqProto = buildRawGetChatMessageRequest({
    apiKey: API_KEY,
    messages: [{ role: 'user', content: 'Reply with exactly one word.' }],
    modelEnum: 226,
    modelName: 'claude-3.7-sonnet',
    sessionId,
  });

  let frames = 0, text = '', hasText = false;
  const done = new Promise((resolve, reject) => {
    grpcStream(PORT, CSRF, `${LS_SERVICE}/RawGetChatMessage`, grpcFrame(reqProto), {
      onData: (buf) => {
        frames++;
        const parsed = parseRawResponse(buf);
        if (parsed.text) {
          hasText = true;
          text += parsed.text;
          console.log(`  frame[${frames}]: ${JSON.stringify(parsed.text.slice(0, 80))}`);
        }
      },
      onEnd: () => resolve({ frames, hasText, text }),
      onError: (e) => reject(e),
    });
  });

  try {
    const r = await done;
    console.log(`  totalFrames=${r.frames} hasText=${r.hasText}`);
    if (r.hasText) console.log(`  finalText=${JSON.stringify(r.text.slice(0, 200))}`);
    else console.log('  WARNING: no text frames');
  } catch (e) {
    console.log(`  FAIL: ${e.message}`);
  }
  console.log('[done]');
}

main().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
