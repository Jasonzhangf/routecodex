#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { coerceStandardizedRequestFromPayloadWithNative } from '../../sharedmodule/llmswitch-core/dist/router/virtual-router/engine-selection/native-hub-pipeline-orchestration-semantics-builders.js';

function findLatestOrphanCallId(logPath) {
  const text = fs.readFileSync(logPath, 'utf8');
  const lines = text.split(/\r?\n/).reverse();
  for (const line of lines) {
    if (!line.includes('orphan_tool_result')) continue;
    const m = line.match(/call_[A-Za-z0-9]{6,}/);
    if (m) return m[0];
  }
  return null;
}

function findSampleByCallId(baseDir, callId) {
  const dirs = fs.readdirSync(baseDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const d of dirs) {
    const p = path.join(baseDir, d.name, 'provider-request.json');
    if (!fs.existsSync(p)) continue;
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw.includes(callId)) continue;
    const wrapped = JSON.parse(raw);
    const payload = wrapped?.body && typeof wrapped.body === 'object' ? wrapped.body : wrapped;
    if (!payload || typeof payload !== 'object') continue;
    if (!Array.isArray(payload.messages) && !Array.isArray(payload.input)) continue;
    if (!String(payload.model || '').trim()) continue;
    return { path: p, payload };
  }
  return null;
}

function main() {
  const logPath = process.argv[2] || path.join(os.homedir(), '.rcc/logs/server-5520.log');
  const samplesBase = process.argv[3] || path.join(os.homedir(), '.rcc/codex-samples/openai-responses/mini27.key1.MiniMax-M2.7');

  if (!fs.existsSync(logPath)) throw new Error(`log missing: ${logPath}`);
  if (!fs.existsSync(samplesBase)) throw new Error(`samples dir missing: ${samplesBase}`);

  const callId = findLatestOrphanCallId(logPath);
  if (!callId) throw new Error('cannot find orphan call_id in log');

  const sample = findSampleByCallId(samplesBase, callId);
  if (!sample) throw new Error(`cannot find sample containing call_id=${callId}`);

  const out = coerceStandardizedRequestFromPayloadWithNative({
    payload: sample.payload,
    normalized: {
      id: 'replay-orphan-followup-sample',
      entryEndpoint: '/v1/responses',
      stream: false,
      processMode: 'chat',
      routeHint: 'coding'
    }
  });

  const err = out?.error;
  if (!err || !String(err?.message || '').includes('orphan_tool_result')) {
    console.log(JSON.stringify({
      result: 'unexpected',
      callId,
      samplePath: sample.path,
      hasError: Boolean(err),
      errorMessage: err?.message || null,
      outputKeys: out && typeof out === 'object' ? Object.keys(out) : null
    }, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify({
    result: 'reproduced',
    callId,
    samplePath: sample.path,
    errorMessage: err.message
  }, null, 2));
}

main();
