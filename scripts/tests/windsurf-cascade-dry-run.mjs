#!/usr/bin/env node
/**
 * Windsurf Cascade dry-run — tests StartCascade with full user-status pre-init.
 * Uses dist/compiled bridge modules + inline proto helpers.
 */
import { randomUUID } from 'node:crypto';
import { grpcFrame, grpcUnary, LS_SERVICE } from 'file:///Users/fanzhang/Documents/github/routecodex/dist/providers/core/runtime/grpc/grpc-client.js';
import { buildStartCascadeRequest, buildSendCascadeMessageRequest, buildGetTrajectoryStepsRequest, parseStartCascadeResponse, parseTrajectorySteps } from 'file:///Users/fanzhang/Documents/github/routecodex/dist/providers/core/runtime/grpc/windsurf-grpc-bridge.js';

const PORT = Number(process.env.LS_PORT || 49485);
const CSRF = process.env.LS_CSRF || 'ce845714-6ac1-45b4-b684-fcddb6c099ce';
const API_KEY = process.env.WS_API_KEY || 'bZbMfJl1olXJ';

async function unary(name, payload) {
  return await grpcUnary(PORT, CSRF, `${LS_SERVICE}/${name}`, grpcFrame(payload), 15000);
}

// Inline proto helpers (same as WindsurfAPI src/windsurf.js)
const { writeMessageField, writeVarintField, writeStringField } = await import('../../dist/providers/core/runtime/grpc/proto.js');

function buildMetadata(sid) {
  return Buffer.concat([
    writeStringField(1,'windsurf'), writeStringField(2,'2.0.67'), writeStringField(3,API_KEY),
    writeStringField(4,'en'), writeStringField(5,'macos'), writeStringField(7,'2.0.67'),
    writeStringField(8,'arm64'), writeVarintField(9,123), writeStringField(10,sid), writeStringField(12,'windsurf'),
  ]);
}

// Parse fields (minimal inline version)
function parseFields(buf) {
  const res = [], off = { v: 0 };
  while (off.v < buf.length) {
    const tag = buf[off.v++];
    const fno = tag >> 3, wt = tag & 7;
    if (wt === 0) {
      let v = 0, sh = 0;
      while (off.v < buf.length && (buf[off.v] & 0x80)) { v |= (buf[off.v] & 0x7f) << sh; sh += 7; off.v++; }
      v |= (buf[off.v] & 0x7f) << sh; off.v++;
      res.push([fno, wt, v]);
    } else if (wt === 2) {
      let len = 0, sh = 0;
      while (off.v < buf.length && (buf[off.v] & 0x80)) { len |= (buf[off.v] & 0x7f) << sh; sh += 7; off.v++; }
      len |= (buf[off.v] & 0x7f) << sh; off.v++;
      res.push([fno, wt, buf.subarray(off.v, off.v + len)]); off.v += len;
    } else break;
  }
  return res;
}
function getField(fields, fn, wt) {
  for (const [f, w, v] of fields) if (f === fn && w === wt) return v; return null;
}

// buildGetUserStatusRequest: metadata in field 1
function buildGetUserStatusRequest() {
  return writeMessageField(1, buildMetadata(''));
}

// extractUserStatusBytes: field 1 from response
function extractUserStatusBytes(resp) {
  const fields = parseFields(resp);
  return getField(fields, 1, 2);
}

// buildUpdatePanelStateWithUserStatusRequest: field 1=metadata, field 2=userStatusBytes
function buildUpdatePanelStateWithUserStatusRequest(sid, userStatusBytes) {
  const parts = [writeMessageField(1, buildMetadata(sid))];
  if (userStatusBytes && userStatusBytes.length) parts.push(writeMessageField(2, userStatusBytes));
  return Buffer.concat(parts);
}

async function main() {
  const sessionId = randomUUID();
  console.log(`[cascade-dry-run] PORT=${PORT} API_KEY=${API_KEY.slice(0,8)}...`);

  // Pre-init (from WindsurfAPI cascadeChat)
  const meta = buildMetadata(sessionId);
  console.log('=== Pre-init ===');
  for (const [name, req] of [
    ['InitializeCascadePanelState', Buffer.concat([writeMessageField(1, meta), writeVarintField(3,1)])],
    ['AddTrackedWorkspace', writeStringField(1, `/tmp/ws-${sessionId}`)],
    ['UpdateWorkspaceTrust', Buffer.concat([writeMessageField(1, meta), writeVarintField(2,1)])],
    ['Heartbeat', writeMessageField(1, meta)],
  ]) {
    await unary(name, req);
    console.log(`  [${name}] OK`);
  }

  // NEW: GetUserStatus → extract userStatusBytes
  console.log('=== User Status ===');
  const userStatusResp = await unary('GetUserStatus', buildGetUserStatusRequest());
  const userStatusBytes = extractUserStatusBytes(userStatusResp);
  console.log(`  [GetUserStatus] OK userStatusBytes=${userStatusBytes ? userStatusBytes.length : 'null'}`);

  // NEW: UpdatePanelStateWithUserStatus
  const panelReq = buildUpdatePanelStateWithUserStatusRequest(sessionId, userStatusBytes);
  await unary('UpdatePanelStateWithUserStatus', panelReq);
  console.log(`  [UpdatePanelStateWithUserStatus] OK`);

  console.log('');
  console.log('=== Cascade ===');
  const startProto = buildStartCascadeRequest(API_KEY, sessionId);
  const startResp = await unary('StartCascade', startProto);
  const fields = parseFields(startResp.subarray(5));
  const cidField = fields.find(f=>f[0]===1&&f[1]===2);
  const rawHex = cidField ? cidField[2].hex() : 'NOT_FOUND';
  console.log(`  [StartCascade raw] hex=${rawHex}`);
  const cascadeId = parseStartCascadeResponse(startResp);
  console.log(`  [StartCascade] cascade_id=${cascadeId ? cascadeId.slice(0,36) : 'EMPTY'}`);

  if (!cascadeId) { console.log('  FAIL: empty cascade_id'); return; }

  const text = 'Reply with exactly one word.';
  const sendProto = buildSendCascadeMessageRequest(API_KEY, cascadeId, text, 0, 'claude-sonnet-4-6', sessionId);
  await unary('SendUserCascadeMessage', sendProto);
  console.log('  [SendUserCascadeMessage] OK');

  let offset = 0, found = false;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    const pollProto = buildGetTrajectoryStepsRequest(cascadeId, offset);
    const resp = await unary('GetCascadeTrajectorySteps', pollProto);
    const steps = parseTrajectorySteps(resp);
    if (!steps.length) continue;
    for (const step of steps) {
      if (step.type === 15 && step.text) {
        console.log(`  [Step ${offset}] PLANNER_RESPONSE: ${JSON.stringify(step.text.slice(0,80))}`);
        found = true; offset++;
        if (step.status === 3) { console.log('  DONE'); break; }
      }
    }
  }
  if (!found) console.log('  WARNING: no PLANNER_RESPONSE after 30s');
  console.log('[done]');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
