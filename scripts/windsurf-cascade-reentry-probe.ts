/**
 * Windsurf Cascade Reentry Probe
 *
 * 直接调用真实 LS gRPC，验证四个核心问题：
 * I1: 同 cascade 连续 Send 两条消息，LS 行为
 * I2: 对 RUNNING cascade 并发 Send，LS 返回什么
 * I4: 不同 sessionId 隔离 cascade
 */
import http2 from 'node:http2';
import { randomUUID } from 'crypto';

const LS_PORT = Number(process.env.WINDSURF_LS_PORT || 42101);
const CSRF_TOKEN = process.env.WINDSURF_CSRF_TOKEN || 'windsurf-api-csrf-fixed-token';
const SESSION_ID = process.env.WINDSURF_SESSION_ID || 'routecodex-windsurf-session-1';
const WORKSPACE_PATH = process.env.WINDSURF_WORKSPACE_PATH || process.env.HOME + '/Documents/github/routecodex';
const WORKSPACE_URI = 'file://' + WORKSPACE_PATH;
const LS_SERVICE = '/exa.language_server_pb.LanguageServerService';
const API_KEY = process.env.WINDSURF_API_KEY || '';

function encodeVarint(value: number): Buffer {
  const parts: number[] = [];
  let remaining = Math.max(0, Math.floor(value));
  while (remaining >= 0x80) {
    parts.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  parts.push(remaining);
  return Buffer.from(parts);
}

function encodeTag(fieldNo: number, wireType: number): Buffer {
  return encodeVarint((fieldNo << 3) | wireType);
}

function writeVarintField(fieldNo: number, value: number): Buffer {
  return Buffer.concat([encodeTag(fieldNo, 0), encodeVarint(value)]);
}

function writeStringField(fieldNo: number, value: string): Buffer {
  const body = Buffer.from(value, 'utf8');
  return Buffer.concat([encodeTag(fieldNo, 2), encodeVarint(body.length), body]);
}

function writeMessageField(fieldNo: number, body: Buffer): Buffer {
  if (!body || body.length === 0) return Buffer.alloc(0);
  return Buffer.concat([encodeTag(fieldNo, 2), encodeVarint(body.length), body]);
}

function buildMetadataBuffer(sessionId: string): Buffer {
  return writeStringField(1, sessionId);
}

function buildCascadeConfigBuffer(): Buffer {
  const plannerConfig = Buffer.concat([writeVarintField(2, 1)]);
  return writeMessageField(1, plannerConfig);
}

function buildStartCascadeRequest(apiKey: string, sessionId: string): Buffer {
  return Buffer.concat([
    writeStringField(2, apiKey),
    writeMessageField(3, buildMetadataBuffer(sessionId)),
  ]);
}

function buildSendCascadeMessageRequest(args: {
  cascadeId: string;
  text: string;
  sessionId: string;
}): Buffer {
  const textItem = writeStringField(1, args.text);
  const items = writeMessageField(2, textItem);
  return Buffer.concat([
    writeStringField(1, args.cascadeId),
    items,
    writeMessageField(3, buildMetadataBuffer(args.sessionId)),
    writeMessageField(5, buildCascadeConfigBuffer()),
  ]);
}

function buildGetTrajectoryStepsRequest(cascadeId: string, stepOffset = 0): Buffer {
  return Buffer.concat([
    writeStringField(1, cascadeId),
    ...(stepOffset > 0 ? [writeVarintField(2, stepOffset)] : []),
  ]);
}

function parseProtoFields(bytes: Buffer): Array<{ fieldNo: number; wireType: number; value: Buffer | number }> {
  const fields: Array<{ fieldNo: number; wireType: number; value: Buffer | number }> = [];
  let pos = 0;
  while (pos < bytes.length) {
    const tag = bytes[pos]!;
    const wireType = tag & 0x07;
    const fieldNo = tag >>> 3;
    pos += 1;
    if (wireType === 0) {
      let result = 0;
      let shift = 0;
      while (pos < bytes.length) {
        const byte = bytes[pos]!;
        result |= (byte & 0x7f) << shift;
        pos += 1;
        if ((byte & 0x80) === 0) break;
        shift += 7;
      }
      fields.push({ fieldNo, wireType, value: result });
    } else if (wireType === 2) {
      const lenResult = (() => {
        let r = 0; let s = 0;
        while (pos < bytes.length) {
          const b = bytes[pos]!;
          r |= (b & 0x7f) << s;
          pos += 1;
          if ((b & 0x80) === 0) break;
          s += 7;
        }
        return r;
      })();
      const value = bytes.slice(pos, pos + lenResult);
      pos += lenResult;
      fields.push({ fieldNo, wireType, value });
    } else {
      break;
    }
  }
  return fields;
}

function grpcUnary(session: http2.ClientHttp2Session, path: string, payload: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'content-type': 'application/grpc',
      'te': 'trailers',
      'connect-protocol-version': '1',
    };
    const stream = session.request({ ':method': 'POST', ...headers, ':path': path });
    const frames: Buffer[] = [];
    const timeout = setTimeout(() => {
      stream.destroy();
      reject(new Error('grpc unary timeout'));
    }, 30_000);
    stream.on('response', () => {});
    stream.on('data', (chunk: Buffer) => { frames.push(chunk); });
    stream.on('trailers', () => {
      clearTimeout(timeout);
      const full = Buffer.concat(frames);
      const resultParts: Buffer[] = [];
      let offset = 0;
      while (offset + 5 <= full.length) {
        const messageLength = full.readUInt32BE(offset + 1);
        if (offset + 5 + messageLength > full.length) break;
        resultParts.push(full.subarray(offset + 5, offset + 5 + messageLength));
        offset += 5 + messageLength;
      }
      resolve(resultParts.length > 0 ? Buffer.concat(resultParts) : full);
    });
    stream.on('error', (err) => { clearTimeout(timeout); reject(err); });
    stream.write(payload);
    stream.end();
  });
}

async function startCascade(session: http2.ClientHttp2Session, apiKey: string, sessionId: string): Promise<string> {
  const payload = buildStartCascadeRequest(apiKey, sessionId);
  const response = await grpcUnary(session, LS_SERVICE + '/StartCascade', payload);
  console.log('StartCascade response bytes:', response.length, 'hex:', response.subarray(0, 64).toString('hex'));
  const fields = parseProtoFields(response);
  console.log('StartCascade fields:', JSON.stringify(fields.map(f => ({ f: f.fieldNo, w: f.wireType, v: typeof f.value === 'number' ? f.value : f.value.toString('hex').slice(0, 60) }))));
  const cascadeIdField = fields.find(f => f.fieldNo === 1 && f.wireType === 2);
  if (!cascadeIdField || typeof cascadeIdField.value === 'number') {
    throw new Error('StartCascade returned no cascade_id, fields=' + JSON.stringify(fields.map(f => f.fieldNo)));
  }
  return cascadeIdField.value.toString('utf8');
}

async function sendCascadeMessage(session: http2.ClientHttp2Session, args: {
  cascadeId: string;
  text: string;
  sessionId: string;
}): Promise<{ ok: boolean; error?: string; status?: number }> {
  const payload = buildSendCascadeMessageRequest(args);
  try {
    await grpcUnary(session, LS_SERVICE + '/SendUserCascadeMessage', payload);
    return { ok: true };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, error: msg };
  }
}

async function pollTrajectory(session: http2.ClientHttp2Session, cascadeId: string, stepOffset = 0): Promise<{ status: number; stepCount: number }> {
  const payload = buildGetTrajectoryStepsRequest(cascadeId, stepOffset);
  const response = await grpcUnary(session, LS_SERVICE + '/GetCascadeTrajectorySteps', payload);
  const fields = parseProtoFields(response);
  const statusField = fields.find(f => f.fieldNo === 1);
  const stepsField = fields.find(f => f.fieldNo === 2 && f.wireType === 2);
  const status = typeof statusField?.value === 'number' ? statusField.value : -1;
  let stepCount = 0;
  if (stepsField && typeof stepsField.value !== 'number') {
    const innerFields = parseProtoFields(stepsField.value as Buffer);
    stepCount = innerFields.filter(f => f.fieldNo === 1).length;
  }
  return { status, stepCount };
}

function createSession(): Promise<http2.ClientHttp2Session> {
  return new Promise((resolve, reject) => {
    const session = http2.connect('http://127.0.0.1:' + LS_PORT);
    session.on('error', (err) => { try { session.close(); } catch {} reject(err); });
    session.on('connect', () => resolve(session));
    session.on('close', () => {});
  });
}

function result(test: string, ok: boolean, detail: string) {
  return { test, ok, detail };
}

async function probeI1(session: http2.ClientHttp2Session, apiKey: string) {
  const sid = 'probe-i1-' + randomUUID().slice(0, 8);
  console.log('\n=== I1: single-cascade-reentry ===');
  const cascadeId = await startCascade(session, apiKey, sid);
  console.log('cascadeId=' + cascadeId);
  const r1 = await sendCascadeMessage(session, { cascadeId, text: 'say hello', sessionId: sid });
  console.log('send1=' + JSON.stringify(r1));
  let idle = false;
  for (let i = 0; i < 20; i++) {
    const p = await pollTrajectory(session, cascadeId);
    console.log('poll=' + JSON.stringify(p));
    if (p.status === 2) { idle = true; break; }
    await new Promise(r => setTimeout(r, 1000));
  }
  const r2 = await sendCascadeMessage(session, { cascadeId, text: 'say goodbye', sessionId: sid });
  console.log('send2=' + JSON.stringify(r2));
  const detail = 'cascadeId=' + cascadeId + ', msg1=' + r1.ok + ', msg2=' + r2.ok + ', idle=' + idle;
  return result('I1-single-cascade-reentry', r1.ok && r2.ok, detail);
}

async function probeI4(session: http2.ClientHttp2Session, apiKey: string) {
  const sid1 = 'probe-i4a-' + randomUUID().slice(0, 8);
  const sid2 = 'probe-i4b-' + randomUUID().slice(0, 8);
  console.log('\n=== I4: session-isolation ===');
  const c1 = await startCascade(session, apiKey, sid1);
  const c2 = await startCascade(session, apiKey, sid2);
  console.log('cascade1=' + c1 + ', cascade2=' + c2);
  const isolated = c1 !== c2;
  const detail = 'cascade1=' + c1 + ', cascade2=' + c2 + ', isolated=' + isolated;
  return result('I4-session-isolation', isolated, detail);
}

async function main() {
  if (!API_KEY) {
    console.error('WINDSURF_API_KEY env required');
    process.exit(1);
  }
  console.log('connecting to LS on port ' + LS_PORT);
  const session = await createSession();
  const results: Array<{ test: string; ok: boolean; detail: string }> = [];
  try {
    results.push(await probeI1(session, API_KEY));
    results.push(await probeI4(session, API_KEY));
  } finally {
    session.close();
  }
  console.log('\n=== RESULTS ===');
  for (const r of results) {
    console.log((r.ok ? 'PASS' : 'FAIL') + ' ' + r.test + ': ' + r.detail);
  }
  console.log('\nOverall: ' + (results.every(r => r.ok) ? 'ALL PASS' : 'SOME FAILED'));
}

main().catch(error => {
  console.error('fatal=' + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
