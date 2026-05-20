#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { grpcFrame, grpcUnary, LS_SERVICE } from '../../dist/providers/core/runtime/grpc/grpc-client.js';
import { buildRawGetChatMessageRequest, parseRawResponse } from '../../dist/providers/core/runtime/grpc/windsurf-grpc-bridge.js';
const PORT = 49485;
const CSRF = 'ce845714-6ac1-45b4-b684-fcddb6c099ce';
const API_KEY = 'bZbMfJl1olXJ';
async function unary(method, payload) {
  return await grpcUnary(PORT, CSRF, `${LS_SERVICE}/${method}`, grpcFrame(payload), 15000);
}
async function main() {
  const sessionId = randomUUID();
  // Pre-init
  const meta = Buffer.from([8,1,16,1,26,3,119,115]); // minimal metadata
  for (const [name, req] of [
    ['InitializeCascadePanelState', null],
    ['Heartbeat', null],
  ]) { await unary(name, req); }
  // Test different model enums
  for (const [model, enumVal] of [
    ['claude-3.5-sonnet', 166],
    ['claude-3.7-sonnet', 226],
    ['claude-4-opus', 290],
  ]) {
    const req = buildRawGetChatMessageRequest({
      apiKey: API_KEY,
      messages: [{role:'user',content:'Reply OK'}],
      modelEnum: enumVal,
      modelName: model,
      sessionId,
    });
    let frames=0, hasText=false;
    await new Promise((res) => {
      const { grpcStream } = require('../../dist/providers/core/runtime/grpc/grpc-client.js');
      grpcStream(PORT, CSRF, `${LS_SERVICE}/RawGetChatMessage`, grpcFrame(req), {
        onData: (buf) => { frames++; const p=parseRawResponse(buf); if(p.text) hasText=true; },
        onEnd: () => res(null),
        onError: () => res(null),
      });
    });
    console.log(`[${model} enum=${enumVal}] frames=${frames} hasText=${hasText}`);
  }
}
main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
