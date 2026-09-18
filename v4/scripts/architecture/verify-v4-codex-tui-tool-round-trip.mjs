#!/usr/bin/env node
// Real Codex TUI tool round-trip regression through the managed rccv4 listener.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const expectedEndpoint = 'http://127.0.0.1:10000';
const expectedRuntimeId = 'rccv4';
const runNonce = `${Date.now()}-${process.pid}`;
const sessionName = `rccv4-tool-round-trip-${runNonce}`;
const marker = `v4-tool-ok-${runNonce}`;
const prompt = `Use exec_command to run exactly: printf ${marker}. Then reply with exactly ${marker}.`;
const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
const sessionsRoot = path.join(codexHome, 'sessions');
const requestRecordsPath = path.join(os.homedir(), '.rcc/logs/server-v4-10000.request-records.jsonl');
const timeoutMs = Number(process.env.RCCV4_CODEX_TOOL_ROUND_TRIP_TIMEOUT_MS ?? 180000);
const pollMs = 1000;
const expectedCwd = process.cwd();
const contractOnly = process.argv.includes('--contract-self-test')
  || process.env.RCCV4_CODEX_TOOL_ROUND_TRIP_MODE === 'contract'
  || process.env.RCCV4_REAL_RUNTIME_ADMISSION_MODE === 'contract';

function run(program, args, options = {}) {
  const result = spawnSync(program, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 15000,
    env: process.env,
  });
  if (result.error) throw result.error;
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findRollout(startedAtMs) {
  if (!fs.existsSync(sessionsRoot)) return null;
  const candidates = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(file);
      } else if (
        entry.name.startsWith('rollout-')
        && entry.name.endsWith('.jsonl')
      ) {
        const stat = fs.statSync(file);
        if (stat.mtimeMs >= startedAtMs) candidates.push({ file, mtimeMs: stat.mtimeMs });
      }
    }
  };
  visit(sessionsRoot);
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const candidate of candidates) {
    const handle = fs.openSync(candidate.file, 'r');
    let firstLine;
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      const count = fs.readSync(handle, buffer, 0, buffer.length, 0);
      firstLine = buffer.subarray(0, count).toString('utf8').split('\n', 1)[0];
    } finally {
      fs.closeSync(handle);
    }
    let record;
    try {
      record = JSON.parse(firstLine);
    } catch {
      continue;
    }
    const payload = record?.payload;
    if (
      record?.type === 'session_meta'
      && payload?.originator === 'codex-tui'
      && payload?.model_provider === 'long'
      && payload?.cwd === expectedCwd
    ) {
      const records = readRolloutRecords(candidate.file, true);
      const correlated = records.some((entry) => {
        const item = entry?.payload;
        return entry?.type === 'response_item'
          && item?.type === 'message'
          && item?.role === 'user'
          && Array.isArray(item?.content)
          && item.content.some((part) => part?.type === 'input_text' && part?.text === prompt);
      });
      if (correlated) return { file: candidate.file, mtimeMs: candidate.mtimeMs };
    }
  }
  return null;
}

function readRolloutRecords(file, allowIncompleteTail = false) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  if (allowIncompleteTail && !text.endsWith('\n')) lines.pop();
  const records = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new Error(`rollout contains invalid JSONL: ${file}`);
    }
  }
  return records;
}

function readJsonLines(file, allowIncompleteTail = false) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  if (allowIncompleteTail && !text.endsWith('\n')) lines.pop();
  const records = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new Error(`request record contains invalid JSONL: ${file}`);
    }
  }
  return records;
}

function hasListenerReceipt(records, startedAtMs) {
  return records.some((record) => {
    const row = record?.row;
    const meta = row?.meta;
    return row?.event_type === 'request.completed'
      && row?.result === 'success'
      && row?.scope?.port === 10000
      && meta?.endpoint === '/v1/responses'
      && meta?.provider_status === 200
      && Number.isInteger(row?.started_epoch_ms)
      && row.started_epoch_ms >= startedAtMs;
  });
}

function validateLongProfile() {
  const profilePath = path.join(codexHome, 'long.config.toml');
  if (!fs.existsSync(profilePath)) {
    throw new Error(`long profile config is missing: ${profilePath}`);
  }
  const source = fs.readFileSync(profilePath, 'utf8');
  if (!/^\s*model_provider\s*=\s*"long"\s*$/m.test(source)) {
    throw new Error('long profile must select model_provider = "long"');
  }
  const configPath = path.join(codexHome, 'config.toml');
  const config = fs.readFileSync(configPath, 'utf8');
  if (!/^\s*base_url\s*=\s*"http:\/\/127\.0\.0\.1:10000\/v1"\s*$/m.test(config)) {
    throw new Error('long provider must target http://127.0.0.1:10000/v1');
  }
}

async function validateManagedListener() {
  const response = await fetch(`${expectedEndpoint}/health`);
  if (!response.ok) {
    throw new Error(`rccv4 health failed: ${response.status}`);
  }
  const health = await response.json();
  if (health?.id !== expectedRuntimeId
      || typeof health?.version !== 'string'
      || typeof health?.manifest_digest !== 'string') {
    throw new Error(`unexpected rccv4 health identity: ${JSON.stringify(health)}`);
  }
  return health;
}

function hasRoundTripEvidence(records) {
  const promptRecord = records.find((record) => {
    const payload = record?.payload;
    return record?.type === 'response_item'
      && payload?.type === 'message'
      && payload?.role === 'user'
      && Array.isArray(payload?.content)
      && payload.content.some((part) => part?.type === 'input_text' && part?.text === prompt);
  });
  const toolCall = records.find((record) => {
    const payload = record?.payload;
    return record?.type === 'response_item'
      && payload?.type === 'function_call'
      && payload?.name === 'exec_command'
      && typeof payload?.arguments === 'string'
      && payload.arguments.includes(`printf ${marker}`);
  });
  const toolOutput = toolCall
    ? records.find((record) => {
      const payload = record?.payload;
      return record?.type === 'response_item'
        && payload?.type === 'function_call_output'
        && payload?.call_id === toolCall.payload.call_id
        && typeof payload?.output === 'string'
        && payload.output.includes(marker);
    })
    : null;
  const finalAnswer = records.some((record) => {
    const payload = record?.payload;
    return record?.type === 'response_item'
      && payload?.type === 'message'
      && payload?.role === 'assistant'
      && Array.isArray(payload?.content)
      && payload.content.some((part) => part?.type === 'output_text' && part?.text === marker);
  });
  const taskCompleted = records.some((record) => {
    const payload = record?.payload;
    return record?.type === 'event_msg'
      && payload?.type === 'task_complete'
      && payload?.last_agent_message === marker;
  });
  return Boolean(promptRecord && toolCall && toolOutput && finalAnswer && taskCompleted);
}

if (contractOnly) {
  const records = [
    {
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] },
    },
    {
      type: 'response_item',
      payload: { type: 'function_call', name: 'exec_command', call_id: 'call-1', arguments: `{\"cmd\":\"printf ${marker}\"}` },
    },
    {
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call-1', output: marker },
    },
    {
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: marker }] },
    },
    {
      type: 'event_msg',
      payload: { type: 'task_complete', last_agent_message: marker },
    },
  ];
  const negativeCases = [
    ['missing prompt correlation', records.filter((_, index) => index !== 0)],
    ['wrong prompt correlation', records.map((record, index) => (
      index === 0 ? { ...record, payload: { ...record.payload, content: [{ type: 'input_text', text: 'other prompt' }] } } : record
    ))],
    ['call/output mismatch', records.map((record, index) => (
      index === 2 ? { ...record, payload: { ...record.payload, call_id: 'other-call' } } : record
    ))],
  ];
  const receipt = {
    row: {
      event_type: 'request.completed',
      result: 'success',
      scope: { port: 10000 },
      started_epoch_ms: Date.now(),
      meta: { endpoint: '/v1/responses', provider_status: 200 },
    },
  };
  if (!hasRoundTripEvidence(records)
      || !hasListenerReceipt([receipt], Date.now() - 1000)
      || negativeCases.some(([, value]) => hasRoundTripEvidence(value))
      || hasListenerReceipt([], Date.now() - 1000)
      || hasListenerReceipt([receipt], Date.now() + 1000)) {
    throw new Error('codex TUI tool round-trip contract self-test failed');
  }
  console.log(`[v4_codex_tui_tool_round_trip] CONTRACT SELF-TEST OK marker=${marker}`);
  process.exit(0);
}

if (run('tmux', ['-V']).status !== 0) {
  throw new Error('tmux is required for the Codex TUI tool round-trip gate');
}
if (run('codex', ['--version']).status !== 0) {
  throw new Error('codex CLI is required for the Codex TUI tool round-trip gate');
}
validateLongProfile();
const listenerHealth = await validateManagedListener();

const existing = run('tmux', ['has-session', '-t', sessionName]);
if (existing.status === 0) {
  throw new Error(`refusing to reuse existing tmux session ${sessionName}`);
}

const startedAtMs = Date.now();
let rollout = null;
try {
  const created = run('tmux', [
    'new-session',
    '-d',
    '-s',
    sessionName,
    '-c',
    process.cwd(),
    'codex --profile long',
  ]);
  if (created.status !== 0) {
    throw new Error(`tmux new-session failed: ${created.stderr.trim()}`);
  }

  const deadline = Date.now() + timeoutMs;
  let sent = false;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const pane = run('tmux', ['capture-pane', '-p', '-t', sessionName, '-S', '-80']);
    const ready = pane.stdout.includes('gpt-5.5 high') && !pane.stdout.includes('model: loading');
    if (!sent && ready) {
      const sentResult = run('tmux', ['send-keys', '-l', '-t', sessionName, prompt]);
      if (sentResult.status !== 0) {
        throw new Error(`tmux send-keys failed: ${sentResult.stderr.trim()}`);
      }
      await sleep(500);
      const submitted = run('tmux', ['send-keys', '-t', sessionName, 'C-m']);
      if (submitted.status !== 0) {
        throw new Error(`tmux submit failed: ${submitted.stderr.trim()}`);
      }
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await sleep(250);
        const current = run('tmux', ['capture-pane', '-p', '-t', sessionName, '-S', '-40']);
        if (!current.stdout.includes(prompt)) {
          sent = true;
          break;
        }
      }
      if (!sent) {
        throw new Error('Codex TUI did not submit the prompt');
      }
    }
    if (!sent) continue;
    const candidate = findRollout(startedAtMs);
    if (!candidate || candidate.mtimeMs < startedAtMs) continue;
    rollout = candidate.file;
    if (!rollout) continue;
    const listenerRecords = fs.existsSync(requestRecordsPath)
      ? readJsonLines(requestRecordsPath, true)
      : [];
    if (hasRoundTripEvidence(readRolloutRecords(rollout, true))
        && hasListenerReceipt(listenerRecords, startedAtMs)) {
      readRolloutRecords(rollout);
      console.log(
        `[v4_codex_tui_tool_round_trip] OK session=${sessionName} rollout=${rollout} `
        + `runtime=${listenerHealth.id} version=${listenerHealth.version} `
        + `manifest=${listenerHealth.manifest_digest}`,
      );
      process.exitCode = 0;
      break;
    }
  }
  if (process.exitCode !== 0) {
    if (rollout) readRolloutRecords(rollout);
    const pane = run('tmux', ['capture-pane', '-p', '-t', sessionName, '-S', '-120']).stdout;
    throw new Error(
      `Codex TUI tool round-trip timed out after ${timeoutMs}ms; rollout=${rollout ?? 'none'}; pane=${pane.slice(-2000)}`,
    );
  }
} finally {
  const killed = run('tmux', ['kill-session', '-t', sessionName]);
  if (killed.status !== 0 && !killed.stderr.includes("can't find session")) {
    throw new Error(`tmux cleanup failed for ${sessionName}: ${killed.stderr.trim()}`);
  }
}
