#!/usr/bin/env node

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

const PORT = Number(process.env.RCC_AUDIT_PORT || 5520);
const HOST = process.env.RCC_AUDIT_HOST || '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}/v1/responses`;
const LOG_PATH = process.env.RCC_AUDIT_LOG_PATH || path.join(os.homedir(), '.rcc', 'logs', `server-${PORT}.log`);
const SAMPLE_ROOT = process.env.RCC_AUDIT_SAMPLE_ROOT || path.join(os.homedir(), '.rcc', 'codex-samples', 'openai-responses');
const MAX_ROUND_ATTEMPTS = Number(process.env.RCC_AUDIT_MAX_ROUND_ATTEMPTS || 4);
const RETRY_DELAY_MS = Number(process.env.RCC_AUDIT_RETRY_DELAY_MS || 1500);
const ROUND3_CAPTURE_DELAY_MS = Number(process.env.RCC_AUDIT_ROUND3_CAPTURE_DELAY_MS || 2500);
const ROUND3_ABORT_MS = Number(process.env.RCC_AUDIT_ROUND3_ABORT_MS || 15000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractInputText(input) {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return '';
  return input
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return '';
      const content = Array.isArray(entry.content) ? entry.content : [];
      return content
        .map((part) => (part && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''))
        .join('');
    })
    .filter(Boolean)
    .join('\n');
}

function parseSseFrames(raw) {
  const frames = [];
  let event = 'message';
  let data = '';
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      data += (data ? '\n' : '') + line.slice(5).trim();
      continue;
    }
    if (!line.trim()) {
      frames.push({ event, data });
      event = 'message';
      data = '';
    }
  }
  if (data) frames.push({ event, data });
  return frames;
}

async function readLogFrom(offset) {
  const file = await fs.readFile(LOG_PATH, 'utf8');
  return { nextOffset: file.length, chunk: file.slice(offset) };
}

function parseProviderIds(logChunk) {
  const ids = [];
  const re = /\[provider\.traffic\.acquire\]\[(openai-responses-windsurf[^\]]+)\]/g;
  for (const match of logChunk.matchAll(re)) ids.push(match[1]);
  return [...new Set(ids)];
}

function parseCacheMetrics(logChunk) {
  const metrics = [];
  const re = /req=([^\s]+).*?finish_reason=([^\n]+)\n(?:.*\n)?\s*.*cache\.read=([0-9,]+)\s+cache\.hit=([0-9.]+)%\s+cache\.write=([0-9,]+)/g;
  for (const match of logChunk.matchAll(re)) {
    metrics.push({
      requestId: match[1],
      finishReason: match[2].trim(),
      cacheRead: Number(String(match[3]).replaceAll(',', '')),
      cacheHitPercent: Number(match[4]),
      cacheWrite: Number(String(match[5]).replaceAll(',', '')),
    });
  }
  return metrics;
}

async function findSampleDir(requestId) {
  const { stdout } = await execFile('bash', [
    '-lc',
    `find ${JSON.stringify(SAMPLE_ROOT)} -type d -name ${JSON.stringify(requestId)} | tail -n 1`,
  ]);
  return stdout.trim();
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function loadLatestProviderRequest(sampleDir) {
  if (!sampleDir) return null;
  const entries = await fs.readdir(sampleDir);
  const requestFiles = entries
    .filter((name) => /^provider-request(?:_\d+)?\.json$/.test(name))
    .sort((a, b) => {
      const ai = Number((a.match(/_(\d+)\.json$/) || [])[1] || 0);
      const bi = Number((b.match(/_(\d+)\.json$/) || [])[1] || 0);
      return ai - bi;
    });
  const latest = requestFiles[requestFiles.length - 1];
  if (!latest) return null;
  return await readJsonIfExists(path.join(sampleDir, latest));
}

async function collectRoundSnapshot(roundName, logOffset) {
  await sleep(350);
  const { nextOffset, chunk } = await readLogFrom(logOffset);
  const providerIds = parseProviderIds(chunk);
  const providerRequestId = providerIds[providerIds.length - 1] || '';
  const sampleDir = providerRequestId ? await findSampleDir(providerRequestId) : '';
  const providerRequest = sampleDir ? await loadLatestProviderRequest(sampleDir) : null;
  const cacheMetrics = parseCacheMetrics(chunk).filter((entry) => entry.requestId.includes(providerRequestId));
  return {
    roundName,
    nextLogOffset: nextOffset,
    logChunk: chunk,
    providerRequestId,
    sampleDir,
    providerRequest,
    cacheMetrics,
  };
}

async function postSse(body) {
  return await postSseWithRetry(body, 'unnamed-round');
}

function parseErrorFramePayload(text) {
  const frames = parseSseFrames(text);
  for (const frame of frames) {
    if (!frame.data || frame.data === '[DONE]') continue;
    try {
      return JSON.parse(frame.data);
    } catch {
      continue;
    }
  }
  return null;
}

function isRetriableAuditError(status, errorText, payload) {
  const code = String(payload?.error?.code || payload?.code || '').trim();
  const message = String(payload?.error?.message || payload?.message || errorText || '').trim();
  if (status !== 502 && status !== 504) return false;
  if (code === 'WINDSURF_FETCH_TIMEOUT' || code === 'WINDSURF_UPSTREAM_TRANSIENT') return true;
  if (code === 'WINDSURF_RESPONSE_PARSE_FAILED' && message.includes('empty assistant completion')) return true;
  return false;
}

async function postSseOnce(body) {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text().catch(() => '');
  if (!response.ok || !response.body) {
    const payload = parseErrorFramePayload(text);
    const error = new Error(`HTTP ${response.status}: ${text}`);
    error.status = response.status;
    error.errorText = text;
    error.errorPayload = payload;
    throw error;
  }
  const frames = parseSseFrames(text);
  const parsed = [];
  for (const frame of frames) {
    if (!frame.data || frame.data === '[DONE]') continue;
    try {
      parsed.push({ event: frame.event, data: JSON.parse(frame.data) });
    } catch {
      parsed.push({ event: frame.event, data: frame.data });
    }
  }
  return { raw: text, events: parsed };
}

async function postSseWithRetry(body, roundLabel) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ROUND_ATTEMPTS; attempt += 1) {
    try {
      const result = await postSseOnce(body);
      return { ...result, attemptCount: attempt };
    } catch (error) {
      const status = Number(error?.status || 0);
      const errorText = String(error?.errorText || error?.message || '');
      const payload = error?.errorPayload || null;
      lastError = error;
      if (!isRetriableAuditError(status, errorText, payload) || attempt >= MAX_ROUND_ATTEMPTS) {
        const retrySuffix = attempt > 1 ? ` after ${attempt} attempts` : '';
        throw new Error(`[${roundLabel}] failed${retrySuffix}: ${error instanceof Error ? error.message : String(error)}`);
      }
      console.error(`[windsurf-5520-context-audit] retry ${roundLabel} attempt ${attempt}/${MAX_ROUND_ATTEMPTS} status=${status} code=${String(payload?.error?.code || '')}`);
      await sleep(RETRY_DELAY_MS);
    }
  }
  throw lastError || new Error(`[${roundLabel}] failed with unknown error`);
}

async function postSseSampleOnly(body, roundLabel, logOffset) {
  const controller = new AbortController();
  const fetchPromise = fetch(BASE_URL, {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  }).then(async (response) => {
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const payload = parseErrorFramePayload(text);
      const error = new Error(`HTTP ${response.status}: ${text}`);
      error.status = response.status;
      error.errorText = text;
      error.errorPayload = payload;
      throw error;
    }
    const reader = response.body?.getReader?.();
    if (!reader) return;
    try {
      await reader.read();
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  });

  let timeoutId = null;
  try {
    timeoutId = setTimeout(() => controller.abort(), ROUND3_ABORT_MS);
    await sleep(ROUND3_CAPTURE_DELAY_MS);
    const snapshot = await collectRoundSnapshot(roundLabel, logOffset);
    if (!snapshot.providerRequestId || !snapshot.providerRequest) {
      throw new Error(`[${roundLabel}] sample-only capture missing provider request snapshot`);
    }
    controller.abort();
    await fetchPromise.catch((error) => {
      if (error?.name !== 'AbortError') throw error;
    });
    return { snapshot, sampleOnly: true, abortedByClient: true };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function summarizeEvents(events) {
  const counts = {};
  for (const event of events) counts[event.event] = (counts[event.event] || 0) + 1;
  return counts;
}

function extractResponseId(events) {
  for (const item of events) {
    if (item.event === 'response.created' && item.data?.response?.id) return String(item.data.response.id);
    if (item.data?.response?.id) return String(item.data.response.id);
  }
  return '';
}

function extractRequiredToolCalls(events) {
  for (const item of events) {
    const calls = item?.data?.required_action?.submit_tool_outputs?.tool_calls;
    if (Array.isArray(calls) && calls.length > 0) return calls;
    const nestedCalls = item?.data?.response?.required_action?.submit_tool_outputs?.tool_calls;
    if (Array.isArray(nestedCalls) && nestedCalls.length > 0) return nestedCalls;
  }
  return [];
}

function toolCallName(call) {
  return String(call?.name || call?.function?.name || '');
}

function isNativeShellLikeTool(call) {
  const name = toolCallName(call);
  return name === 'shell_command' || name === 'run_command' || name === 'exec_command';
}

function isApplyPatchTool(call) {
  return toolCallName(call) === 'apply_patch';
}

function extractUsage(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const usage = events[i]?.data?.response?.usage || events[i]?.data?.usage;
    if (usage && typeof usage === 'object') return usage;
  }
  return null;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function findLatestHumanSegment(text) {
  const idx = text.lastIndexOf('<human>');
  return idx >= 0 ? text.slice(idx) : text;
}

function auditPromptText(roundLabel, promptText) {
  const latestHuman = findLatestHumanSegment(promptText);
  return {
    roundLabel,
    latestHumanPreview: latestHuman.slice(0, 800),
    hasRccGuidance: promptText.includes('Text tool calling format (STRICT)'),
    hasRccToolCallsFence: promptText.includes('<|RCC|tool_calls>'),
    hasRccToolResultFence: promptText.includes('<|RCC|tool_result'),
    latestHumanHasGuidanceHeader: latestHuman.includes('Text tool calling format (STRICT)'),
  };
}

function extractProviderPrompt(providerRequest) {
  if (!providerRequest || typeof providerRequest !== 'object') return '';
  if (typeof providerRequest.text === 'string') return providerRequest.text;
  if (typeof providerRequest?.data?.text === 'string') return providerRequest.data.text;
  if (typeof providerRequest?.body?.text === 'string') return providerRequest.body.text;
  return '';
}

function extractPromptDiagnostics(providerRequest) {
  if (!providerRequest || typeof providerRequest !== 'object') return null;
  return providerRequest.promptDiagnostics || providerRequest?.data?.promptDiagnostics || providerRequest?.body?.promptDiagnostics || null;
}

async function runAudit() {
  const health = await fetch(`http://${HOST}:${PORT}/health`);
  assert(health.ok, `health check failed: ${health.status}`);

  let logOffset = (await fs.readFile(LOG_PATH, 'utf8')).length;

  const initialBody = {
    model: 'gpt-5.3-codex',
    stream: true,
    input: [{
      role: 'user',
      content: [{
        type: 'input_text',
        text: 'First call the run_command tool with command_line exactly "pwd" and cwd exactly "/Users/fanzhang/Documents/github/routecodex". After that tool result arrives, immediately call apply_patch to create tmp/windsurf_context_audit_probe.txt with exactly one line: mixed-rcc. After both tool results arrive, answer in one short sentence that mentions both outputs.',
      }],
    }],
    tools: [
      {
        type: 'function',
        name: 'run_command',
        description: 'Run one shell command',
        parameters: {
          type: 'object',
          properties: {
            command_line: { type: 'string' },
            cwd: { type: 'string' },
          },
          required: ['command_line', 'cwd'],
          additionalProperties: false,
        },
      },
      {
        type: 'function',
        name: 'apply_patch',
        description: 'Apply a strict line-edit patch to a workspace-relative file path',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string' },
            patch: { type: 'string' },
          },
          required: ['filePath', 'patch'],
          additionalProperties: false,
        },
      },
    ],
  };

  const round1 = await postSseWithRetry(initialBody, 'round1_initial');
  const responseId1 = extractResponseId(round1.events);
  const toolCalls1 = extractRequiredToolCalls(round1.events);
  assert(responseId1, 'round1 missing response id');
  assert(toolCalls1.length > 0, 'round1 missing required tool calls');
  const snap1 = await collectRoundSnapshot('round1', logOffset);
  logOffset = snap1.nextLogOffset;

  const shellCall = toolCalls1.find((call) => isNativeShellLikeTool(call));
  assert(shellCall, `round1 did not request native shell-like tool; got ${JSON.stringify(toolCalls1)}`);

  const round2 = await postSseWithRetry({
    model: 'gpt-5.3-codex',
    stream: true,
    previous_response_id: responseId1,
    input: [{
      type: 'function_call_output',
      call_id: String(shellCall.id || shellCall.call_id || ''),
      output: '/Users/fanzhang/Documents/github/routecodex\n',
    }],
    tools: initialBody.tools,
  }, 'round2_native_result_followup');
  const responseId2 = extractResponseId(round2.events);
  const toolCalls2 = extractRequiredToolCalls(round2.events);
  assert(responseId2, 'round2 missing response id');
  assert(toolCalls2.length > 0, 'round2 missing required tool calls');
  const snap2 = await collectRoundSnapshot('round2', logOffset);
  logOffset = snap2.nextLogOffset;

  const applyPatchCall = toolCalls2.find((call) => isApplyPatchTool(call));
  assert(applyPatchCall, `round2 did not request apply_patch; got ${JSON.stringify(toolCalls2)}`);

  const round3Capture = await postSseSampleOnly({
    model: 'gpt-5.3-codex',
    stream: true,
    previous_response_id: responseId2,
    input: [{
      type: 'function_call_output',
      call_id: String(applyPatchCall.id || applyPatchCall.call_id || ''),
      output: 'patch applied: tmp/windsurf_context_audit_probe.txt => mixed-rcc',
    }],
    tools: initialBody.tools,
  }, 'round3_rcc_result_followup', logOffset);
  const snap3 = round3Capture.snapshot;

  const prompt1 = extractProviderPrompt(snap1.providerRequest);
  const prompt2 = extractProviderPrompt(snap2.providerRequest);
  const prompt3 = extractProviderPrompt(snap3.providerRequest);

  assert(prompt1.includes('Text tool calling format (STRICT)'), 'round1 prompt missing RCC guidance prefix');
  assert(!findLatestHumanSegment(prompt1).includes('Text tool calling format (STRICT)'), 'round1 guidance leaked into latest human history');
  assert(prompt2.includes('/Users/fanzhang/Documents/github/routecodex'), 'round2 prompt missing native tool result path');
  assert(prompt2.includes('Available remaining text tool names: apply_patch'), 'round2 prompt missing pending RCC reminder');
  assert(prompt2.includes('<|RCC|invoke name="apply_patch">'), 'round2 prompt missing RCC apply_patch call fence');
  assert(!prompt2.includes('<|RCC|tool_result id="native:'), 'round2 wrongly serialized native result as RCC tool_result');
  assert(prompt3.includes('<|RCC|tool_result id="'), 'round3 prompt missing RCC tool_result fence');
  assert(prompt3.includes('name="apply_patch"'), 'round3 prompt missing apply_patch tool_result name');
  assert(prompt3.includes('windsurf_context_audit_probe.txt'), 'round3 prompt missing apply_patch tool result path');
  assert(prompt3.includes('mixed-rcc'), 'round3 prompt missing RCC tool result output');
  assert(!prompt3.includes('<|RCC|tool_result id="native:'), 'round3 wrongly serialized native result as RCC tool_result');
  assert(prompt3.includes('/Users/fanzhang/Documents/github/routecodex'), 'round3 prompt lost native history path');

  const report = {
    port: PORT,
    baseUrl: BASE_URL,
    requests: [
      {
        round: 'round1_initial',
        responseId: responseId1,
        inputText: extractInputText(initialBody.input),
        attemptCount: round1.attemptCount,
        requestedTools: toolCalls1.map((call) => ({
          id: call.id || call.call_id,
          name: call.name || call.function?.name,
          arguments: call.arguments || call.function?.arguments,
        })),
        sseEventCounts: summarizeEvents(round1.events),
        usage: extractUsage(round1.events),
        providerRequestId: snap1.providerRequestId,
        sampleDir: snap1.sampleDir,
        promptDiagnostics: extractPromptDiagnostics(snap1.providerRequest),
        additionalStepsCount: snap1.providerRequest?.additionalStepsCount ?? snap1.providerRequest?.data?.additionalStepsCount ?? null,
        promptAudit: auditPromptText('round1_initial', prompt1),
        cacheMetrics: snap1.cacheMetrics,
      },
      {
        round: 'round2_native_result_followup',
        responseId: responseId2,
        previousResponseId: responseId1,
        attemptCount: round2.attemptCount,
        submittedToolOutput: {
          call_id: String(shellCall.id || shellCall.call_id || ''),
          output: '/Users/fanzhang/Documents/github/routecodex\\n',
        },
        requestedTools: toolCalls2.map((call) => ({
          id: call.id || call.call_id,
          name: call.name || call.function?.name,
          arguments: call.arguments || call.function?.arguments,
        })),
        sseEventCounts: summarizeEvents(round2.events),
        usage: extractUsage(round2.events),
        providerRequestId: snap2.providerRequestId,
        sampleDir: snap2.sampleDir,
        promptDiagnostics: extractPromptDiagnostics(snap2.providerRequest),
        additionalStepsCount: snap2.providerRequest?.additionalStepsCount ?? snap2.providerRequest?.data?.additionalStepsCount ?? null,
        promptAudit: auditPromptText('round2_native_result_followup', prompt2),
        cacheMetrics: snap2.cacheMetrics,
      },
      {
        round: 'round3_rcc_result_followup',
        responseId: '',
        previousResponseId: responseId2,
        attemptCount: 1,
        sampleOnly: true,
        abortedByClient: true,
        submittedToolOutput: {
          call_id: String(applyPatchCall.id || applyPatchCall.call_id || ''),
          output: 'patch applied: tmp/windsurf_context_audit_probe.txt => mixed-rcc',
        },
        sseEventCounts: { client_capture: 'sample_only' },
        usage: null,
        providerRequestId: snap3.providerRequestId,
        sampleDir: snap3.sampleDir,
        promptDiagnostics: extractPromptDiagnostics(snap3.providerRequest),
        additionalStepsCount: snap3.providerRequest?.additionalStepsCount ?? snap3.providerRequest?.data?.additionalStepsCount ?? null,
        promptAudit: auditPromptText('round3_rcc_result_followup', prompt3),
        finalOutputPreview: '',
        cacheMetrics: snap3.cacheMetrics,
      },
    ],
    assertions: {
      round1_nativeToolRequested: true,
      round2_rccToolRequestedAfterNativeResult: true,
      round2_nativeHistoryPreservedWithoutRccToolResultPollution: true,
      round3_rccToolResultInjectedWithFence: true,
      previousResponseIdContinuationObserved: true,
    },
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

runAudit().catch((error) => {
  console.error('[windsurf-5520-context-audit] failed:', error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
