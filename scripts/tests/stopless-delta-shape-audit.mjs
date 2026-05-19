#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function asArray(v) { return Array.isArray(v) ? v : []; }

function extractCallIdsFromInput(input) {
  const ids = new Set();
  for (const item of asArray(input)) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'function_call' && typeof item.call_id === 'string' && item.call_id.trim()) {
      ids.add(item.call_id.trim());
    }
    if (item.type === 'message' || item.role) {
      const content = asArray(item.content);
      for (const part of content) {
        if (part && typeof part === 'object' && part.type === 'function_call' && typeof part.call_id === 'string' && part.call_id.trim()) {
          ids.add(part.call_id.trim());
        }
      }
    }
  }
  return ids;
}

function extractToolResultCallIdsFromInput(input) {
  const ids = [];
  for (const item of asArray(input)) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'function_call_output' && typeof item.call_id === 'string' && item.call_id.trim()) {
      ids.push(item.call_id.trim());
    }
    const content = asArray(item.content);
    for (const part of content) {
      if (part && typeof part === 'object' && part.type === 'function_call_output' && typeof part.call_id === 'string' && part.call_id.trim()) {
        ids.push(part.call_id.trim());
      }
    }
  }
  return ids;
}

function classifyDelta(input) {
  const toolResultIds = extractToolResultCallIdsFromInput(input);
  const hasToolResult = toolResultIds.length > 0;
  let hasFunctionCall = false;
  let hasText = false;
  for (const item of asArray(input)) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'function_call') hasFunctionCall = true;
    const content = asArray(item.content);
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'function_call') hasFunctionCall = true;
      if (part.type === 'input_text' && typeof part.text === 'string' && part.text.trim()) hasText = true;
    }
    if (typeof item.content === 'string' && item.content.trim()) hasText = true;
  }
  if (hasToolResult) return 'tool_result';
  if (hasFunctionCall) return 'tool_call';
  if (hasText) return 'text';
  return 'unknown';
}

function normalizeMessagesToInput(messages) {
  const out = [];
  for (const m of asArray(messages)) {
    if (!m || typeof m !== 'object') continue;
    const role = typeof m.role === 'string' ? m.role : 'user';
    if (role === 'tool') {
      const callId = typeof m.tool_call_id === 'string' ? m.tool_call_id : undefined;
      if (callId) {
        out.push({ type: 'function_call_output', call_id: callId, output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '') });
      }
      continue;
    }
    if (Array.isArray(m.content)) {
      out.push({ role, content: m.content });
    } else {
      out.push({ role, content: [{ type: 'input_text', text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '') }] });
    }
  }
  return out;
}

function auditCase(name, payload, clientBaselineInput = []) {
  const hasInput = Array.isArray(payload?.input);
  const hasMessages = Array.isArray(payload?.messages);
  const input = hasInput ? payload.input : (hasMessages ? normalizeMessagesToInput(payload.messages) : []);
  const deltaType = classifyDelta(input);
  const baselineCallIds = extractCallIdsFromInput(clientBaselineInput);
  const localCallIds = extractCallIdsFromInput(input);
  const visibleCallIds = new Set([...baselineCallIds, ...localCallIds]);
  const toolResultIds = extractToolResultCallIdsFromInput(input);
  const orphan = toolResultIds.filter((id) => !visibleCallIds.has(id));

  return {
    name,
    hasInput,
    hasMessages,
    deltaType,
    toolResultCount: toolResultIds.length,
    visibleCallIdCount: visibleCallIds.size,
    orphanToolResultCount: orphan.length,
    orphanToolResultIds: orphan.slice(0, 10)
  };
}

function main() {
  const samples = [];

  // client-like responses text sample
  const clientText = readJson('tests/fixtures/unified-hub/responses.clean.json');
  samples.push(auditCase('client_text_baseline', clientText, clientText.input || []));

  // simulated followup message-only payload (what we saw before)
  const followupMsgOnly = {
    model: 'gpt-5.3-codex',
    messages: [
      { role: 'assistant', content: 'I will call tool' },
      { role: 'tool', tool_call_id: 'call_abc', content: '{"ok":true}' },
      { role: 'user', content: '继续执行' }
    ]
  };
  samples.push(auditCase('followup_messages_only_mixed', followupMsgOnly, [{ type: 'function_call', call_id: 'call_abc', name: 'x', arguments: '{}' }]));

  // tool_call delta case (client-like)
  const toolCallPayload = {
    input: [
      {
        type: 'function_call',
        call_id: 'call_tool_1',
        name: 'search_web',
        arguments: '{"q":"routecodex"}'
      },
      {
        role: 'assistant',
        content: [{ type: 'output_text', text: '我先调用工具。' }]
      }
    ]
  };
  samples.push(auditCase('tool_call_delta_case', toolCallPayload, []));

  // orphan tool_result case
  const orphanPayload = {
    input: [
      { type: 'function_call_output', call_id: 'call_missing', output: '{"x":1}' },
      { role: 'user', content: [{ type: 'input_text', text: '继续执行' }] }
    ]
  };
  samples.push(auditCase('orphan_tool_result_case', orphanPayload, []));

  // fixture-based matrix
  const fixtureSamples = loadFixtureSamples();
  samples.push(...fixtureSamples);

  // log-based shape sample (real followup traces)
  const logSamples = loadFollowupShapeSamplesFromLog();
  samples.push(...logSamples);

  const failed = samples.filter((s) => s.orphanToolResultCount > 0);
  const deltaTypes = new Set(samples.map((s) => s.deltaType));
  const hasAllCoreDeltaTypes =
    deltaTypes.has('text') && deltaTypes.has('tool_call') && deltaTypes.has('tool_result');

  const shapeViolations = samples.filter(
    (s) => s.name.startsWith('log_followup:') && s.hasMessages === true && s.hasInput === false
  );

  console.log('[stopless-delta-audit] samples=');
  for (const s of samples) console.log(JSON.stringify(s));
  console.log(
    JSON.stringify({
      summary: {
        total: samples.length,
        deltaTypeCoverage: Array.from(deltaTypes).sort(),
        orphanFailures: failed.length,
        logShapeViolations: shapeViolations.length
      }
    })
  );

  if (!hasAllCoreDeltaTypes) {
    console.error(
      `[stopless-delta-audit] FAIL matrix coverage incomplete: need text/tool_call/tool_result, got=${Array.from(deltaTypes).join(',')}`
    );
    process.exit(1);
  }

  if (shapeViolations.length > 0) {
    console.error(
      `[stopless-delta-audit] FAIL found ${shapeViolations.length} responses followup message-only shape violations in real logs`
    );
    process.exit(1);
  }

  if (failed.length > 0) {
    console.error(`[stopless-delta-audit] FAIL orphan_tool_result detected in ${failed.length} sample(s)`);
    process.exit(1);
  }
  console.log('[stopless-delta-audit] OK no orphan_tool_result detected');
}

function loadFixtureSamples() {
  const out = [];
  const base = path.resolve('tests/fixtures/conversion-matrix');
  if (!fs.existsSync(base)) return out;
  const dirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const d of dirs) {
    const dir = path.join(base, d.name);
    const providerReq = path.join(dir, 'provider-request.json');
    if (!fs.existsSync(providerReq)) continue;
    try {
      const payload = readJson(providerReq);
      const baseline = Array.isArray(payload?.input) ? payload.input : [];
      out.push(auditCase(`fixture:${d.name}`, payload, baseline));
    } catch {
      // keep audit script resilient
    }
  }
  return out;
}

function loadFollowupShapeSamplesFromLog() {
  const out = [];
  const p = process.env.RCC_LOG_PATH || path.join(os.homedir(), '.rcc', 'logs', 'server-5520.log');
  if (!fs.existsSync(p)) return out;
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line.includes('[hub.run.input]')) continue;
    const idx = line.indexOf('{');
    if (idx < 0) continue;
    try {
      const row = JSON.parse(line.slice(idx));
      const requestId = String(row.requestId || '');
      const isFollowup = row.serverToolFollowup === true || requestId.includes(':stop_followup');
      if (!isFollowup) continue;
      if (!String(row.entryEndpoint || '').includes('/v1/responses')) continue;
      out.push({
        name: `log_followup:${requestId}`,
        hasInput: row.bodyHasInput === true,
        hasMessages: row.bodyHasMessages === true,
        deltaType: 'unknown',
        toolResultCount: 0,
        visibleCallIdCount: 0,
        orphanToolResultCount: 0,
        orphanToolResultIds: []
      });
    } catch {
      // ignore parse errors
    }
  }
  return out;
}

main();
