#!/usr/bin/env node
// Real Codex TUI tool round-trip regression through the managed rccv4 listener.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const sessionName = `rccv4-tool-round-trip-${process.pid}`;
const marker = 'v4-tool-ok';
const prompt = `Use exec_command to run exactly: printf ${marker}. Then reply with exactly ${marker}.`;
const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
const sessionsRoot = path.join(codexHome, 'sessions');
const timeoutMs = Number(process.env.RCCV4_CODEX_TOOL_ROUND_TRIP_TIMEOUT_MS ?? 180000);
const pollMs = 1000;
const expectedCwd = process.cwd();

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
      return candidate.file;
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

function observeRoundTrip(file, allowIncompleteTail = false) {
  const records = readRolloutRecords(file, allowIncompleteTail);
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
  return {
    toolCall: Boolean(toolCall),
    toolOutput: Boolean(toolOutput),
    finalAnswer,
    taskCompleted,
  };
}

if (run('tmux', ['-V']).status !== 0) {
  throw new Error('tmux is required for the Codex TUI tool round-trip gate');
}
if (run('codex', ['--version']).status !== 0) {
  throw new Error('codex CLI is required for the Codex TUI tool round-trip gate');
}

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
    rollout = findRollout(startedAtMs);
    if (!rollout) continue;
    const observed = observeRoundTrip(rollout, true);
    if (
      observed.toolCall
      && observed.toolOutput
      && observed.finalAnswer
      && observed.taskCompleted
    ) {
      readRolloutRecords(rollout);
      console.log(
        `[v4_codex_tui_tool_round_trip] OK session=${sessionName} rollout=${rollout}`,
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
