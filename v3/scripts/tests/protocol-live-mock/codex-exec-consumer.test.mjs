import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CODEX_REAL_EXEC_CONSUMER,
  CURRENT_CODEX_EXEC_COMMAND_DESCRIPTION,
  buildCodexExecConfig,
  codexCliAvailability,
  parseCodexExecEvents,
  runCodexRealExec,
  validateCodexCommandExecution,
} from './codex-exec-consumer.mjs';

const positiveFixture = JSON.parse(readFileSync(
  new URL('../../../fixtures/protocol-live-mock-matrix/cases/issue-3192e71-codex-integer-positive.json', import.meta.url),
  'utf8',
));

function systemProbe(name) {
  const primary = `/bin/${name}`;
  return existsSync(primary) ? primary : `/usr/bin/${name}`;
}

test('codex-real-exec is selected only by its explicit consumer name', () => {
  assert.equal(CODEX_REAL_EXEC_CONSUMER, 'codex-real-exec');
});

test('isolated config targets the current isolated RCC listener with no global auth', () => {
  const config = buildCodexExecConfig({ rccUrl: 'http://127.0.0.1:41234' });
  assert.match(config, /model_provider = "rcc_replay"/u);
  assert.match(config, /model = "mock\.chat-model"/u);
  assert.match(config, /base_url = "http:\/\/127\.0\.0\.1:41234\/v1"/u);
  assert.match(config, /wire_api = "responses"/u);
  assert.match(config, /requires_openai_auth = false/u);
  assert.doesNotMatch(config, /user_token|auth\.json|chatgpt/iu);
});

test('explicit missing Codex path is unavailable with an ENOENT reason', () => {
  const missing = join(tmpdir(), 'routecodex-missing-codex-cli-for-availability-test');
  const availability = codexCliAvailability(missing);
  assert.equal(availability.available, false);
  assert.equal(availability.kind, 'not_found');
  assert.equal(availability.binary, missing);
  assert.match(availability.reason, /ENOENT/u);
});

test('explicit successful Codex probe is available', () => {
  const binary = systemProbe('true');
  const availability = codexCliAvailability(binary);
  assert.deepEqual(availability, { available: true, binary, kind: 'available' });
});

test('explicit failing Codex probe is unavailable with a non-zero exit reason', () => {
  const binary = systemProbe('false');
  const availability = codexCliAvailability(binary);
  assert.equal(availability.available, false);
  assert.equal(availability.kind, 'probe_failed');
  assert.equal(availability.binary, binary);
  assert.match(availability.reason, /^exit [1-9]\d*$/u);
});

test('Codex probe spawn error is probe_failed instead of a capability gap', () => {
  const directory = mkdtempSync(join(tmpdir(), 'routecodex-codex-probe-spawn-error-'));
  try {
    const binary = join(directory, 'not-executable-codex');
    writeFileSync(binary, '#!/bin/sh\nexit 0\n');
    chmodSync(binary, 0o644);
    const availability = codexCliAvailability(binary);
    assert.equal(availability.available, false);
    assert.equal(availability.kind, 'probe_failed');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Codex probe timeout is probe_failed with an injectable deadline', () => {
  const directory = mkdtempSync(join(tmpdir(), 'routecodex-codex-probe-timeout-'));
  try {
    const binary = join(directory, 'hanging-codex');
    writeFileSync(binary, `#!${systemProbe('sh')}\nexec ${systemProbe('sleep')} 5\n`);
    chmodSync(binary, 0o755);
    const availability = codexCliAvailability(binary, { timeoutMs: 100 });
    assert.equal(availability.available, false);
    assert.equal(availability.kind, 'probe_failed');
    assert.match(availability.reason, /timed out|ETIMEDOUT/iu);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Codex JSONL parsing retains the real command execution event', () => {
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-test' }),
    JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_1',
        type: 'command_execution',
        command: 'pwd',
        aggregated_output: '/private/tmp\n',
        exit_code: 0,
        status: 'completed',
      },
    }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n');
  const parsed = parseCodexExecEvents(stdout);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[1].item.type, 'command_execution');
  assert.equal(parsed[1].item.exit_code, 0);
  assert.equal(parsed[1].item.aggregated_output, '/private/tmp\n');
});

test('real command validation accepts one successful pwd and rejects extra execution', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-real-exec-cwd-'));
  try {
    const event = (overrides = {}) => ({
      type: 'item.completed',
      item: {
        type: 'command_execution',
        command: 'pwd',
        aggregated_output: `${root}\n`,
        exit_code: 0,
        status: 'completed',
        ...overrides,
      },
    });
    const accepted = validateCodexCommandExecution([event()], {
      authorized_commands: ['pwd'],
      expected_cwd: root,
    });
    assert.equal(accepted.ok, true, accepted.diagnostic);
    assert.equal(accepted.executions.length, 1);
    assert.equal(accepted.executions[0].command, 'pwd');
    assert.equal(accepted.executions[0].aggregated_output, `${root}\n`);

    const duplicated = validateCodexCommandExecution([event(), event()], {
      authorized_commands: ['pwd'],
      expected_cwd: root,
    });
    assert.equal(duplicated.ok, false);
    assert.match(duplicated.diagnostic, /exactly one/u);

    const injected = validateCodexCommandExecution([event({ command: 'rm -rf /tmp/x' })], {
      authorized_commands: ['pwd'],
      expected_cwd: root,
    });
    assert.equal(injected.ok, false);
    assert.match(injected.diagnostic, /unauthorized/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('real command validation rejects nonzero, empty, and relative output', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-real-exec-invalid-'));
  try {
    const validate = (aggregatedOutput, exitCode) => validateCodexCommandExecution([{
      type: 'item.completed',
      item: {
        type: 'command_execution',
        command: 'pwd',
        aggregated_output: aggregatedOutput,
        exit_code: exitCode,
        status: 'completed',
      },
    }], {
      authorized_commands: ['pwd'],
      expected_cwd: root,
    });
    assert.equal(validate('', 0).ok, false);
    assert.equal(validate(`${root}\n`, 1).ok, false);
    assert.equal(validate('relative/path\n', 0).ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function formattedFunctionCallOutput(output, {
  chunkId = 'a3c03a',
  exitCode = 0,
  originalTokenCount = 512,
} = {}) {
  return [
    `Chunk ID: ${chunkId}`,
    'Wall time: 0.0000 seconds',
    `Process exited with code ${exitCode}`,
    `Original token count: ${originalTokenCount}`,
    'Output:',
    output,
  ].join('\n');
}

function codexEvent(type, extra = {}) {
  return { type, ...extra };
}

function commandExecution(output) {
  return codexEvent('item.completed', {
    item: {
      type: 'command_execution',
      command: 'pwd',
      aggregated_output: output,
      exit_code: 0,
      status: 'completed',
    },
  });
}

function agentMessage(text) {
  return codexEvent('item.completed', {
    item: {
      type: 'agent_message',
      text,
    },
  });
}

async function runInjectedCodex({
  root,
  events,
  functionCallOutput,
  originalFunctionCallOutput,
}) {
  const runRoot = join(root, 'codex-real-exec');
  const workdir = join(runRoot, 'workdir');
  mkdirSync(workdir, { recursive: true });
  const sampleRoot = join(root, 'home', '.rcc', 'codex-samples');
  const sampleDir = join(sampleRoot, 'openai-responses', 'ports', '12345', 'req-followup');
  mkdirSync(sampleDir, { recursive: true });
  const sourceOutput = originalFunctionCallOutput ?? formattedFunctionCallOutput(`${workdir}\n`);
  writeFileSync(join(sampleDir, 'request.json'), `${JSON.stringify({
    model: 'mock.chat-model',
    stream: true,
    input: [
      {
        type: 'function_call',
        call_id: 'call_int_1',
        name: 'exec_command',
        arguments: positiveFixture.tool_followup.expected_arguments,
      },
      {
        type: 'function_call_output',
        call_id: 'call_int_1',
        output: sourceOutput,
      },
    ],
  }, null, 2)}\n`);
  const output = `${workdir}\n`;
  const expectedArguments = positiveFixture.tool_followup.expected_arguments;
  const parameters = structuredClone(positiveFixture.client_request.body.tools[0].parameters);
  parameters.properties.max_output_tokens.type = 'integer';
  parameters.properties.yield_time_ms.type = 'integer';
  const captures = [];
  const mock = {
    setActiveCase() {},
    advanceTurnAfterResponse() {},
    getCaptures() { return captures; },
  };
  const executeClient = async () => {
    captures.push(
      {
        attempt_kind: 'business',
        turn: 0,
        path: '/v1/chat/completions',
        method: 'POST',
        raw_body: JSON.stringify({ model: 'chat-model', stream: true }),
        headers: {},
        captured_at_epoch_ms: 1,
        body: {
          model: 'chat-model',
          messages: [],
          tools: [{
            type: 'function',
            function: {
              name: 'exec_command',
              description: CURRENT_CODEX_EXEC_COMMAND_DESCRIPTION,
              parameters,
            },
          }],
          stream: true,
        },
      },
      {
        attempt_kind: 'business',
        turn: 1,
        path: '/v1/chat/completions',
        method: 'POST',
        raw_body: JSON.stringify({ model: 'chat-model', stream: true }),
        headers: {},
        captured_at_epoch_ms: 2,
        body: {
          model: 'chat-model',
          messages: [
            { role: 'user', content: 'run pwd' },
            {
              role: 'assistant',
              tool_calls: [{
                id: 'call_int_1',
                type: 'function',
                function: { name: 'exec_command', arguments: expectedArguments },
              }],
            },
            { role: 'tool', tool_call_id: 'call_int_1', content: functionCallOutput },
          ],
          stream: true,
        },
      },
    );
    return {
      child_pid: 4242,
      stdout: `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
      stderr: '',
      exit_code: 0,
      signal: null,
      timed_out: false,
      binary: 'fake-codex',
      args: ['exec'],
      workdir,
      codex_home: join(runRoot, 'codex-home'),
      config_path: join(runRoot, 'codex-home', 'config.toml'),
      prompt_path: join(runRoot, 'prompt.txt'),
      stdout_path: join(runRoot, 'codex-exec.stdout.jsonl'),
      stderr_path: join(runRoot, 'codex-exec.stderr.log'),
    };
  };

  const result = await runCodexRealExec({
    fixture: positiveFixture,
    mock,
    rccUrl: 'http://127.0.0.1:1',
    evidenceRoot: root,
    timeoutMs: 1000,
    sampleRoot,
    listenerPort: 12345,
    executeClient,
  });
  return { result, output, expectedArguments };
}

test('runCodexRealExec preserves the complete Codex-authored tool output and final turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-real-exec-receipt-'));
  const workdir = join(root, 'codex-real-exec', 'workdir');
  const output = `${workdir}\n`;
  const functionCallOutput = formattedFunctionCallOutput(output);

  try {
    const { result, expectedArguments } = await runInjectedCodex({
      root,
      functionCallOutput,
      events: [
        commandExecution(output),
        agentMessage('done'),
        codexEvent('turn.completed'),
      ],
    });
    assert.equal(result.ok, true, result.productDiagnostics.join('; '));
    assert.equal(result.receipt.process.pid, 4242);
    assert.equal(result.receipt.observed_exec.call_id, 'call_int_1');
    assert.equal(result.receipt.observed_exec.raw_arguments, expectedArguments);
    assert.equal(result.receipt.observed_exec.output, functionCallOutput);
    assert.equal(result.receipt.final_client.text, 'done');
    assert.equal(result.receipt.final_client.turn_completed, true);
    assert.equal(result.receipt.artifacts.stdout, join(root, 'codex-real-exec', 'codex-exec.stdout.jsonl'));
    assert.equal(result.receipt.artifacts.stderr, join(root, 'codex-real-exec', 'codex-exec.stderr.log'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runCodexRealExec rejects a missing final assistant output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-real-exec-missing-final-'));
  const workdir = join(root, 'codex-real-exec', 'workdir');
  const output = `${workdir}\n`;

  try {
    const { result } = await runInjectedCodex({
      root,
      functionCallOutput: formattedFunctionCallOutput(output),
      events: [
        commandExecution(output),
        codexEvent('turn.completed'),
      ],
    });
    assert.equal(result.ok, false);
    assert.match(result.productDiagnostics.join('; '), /final assistant/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runCodexRealExec rejects a changed final assistant output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-real-exec-changed-final-'));
  const workdir = join(root, 'codex-real-exec', 'workdir');
  const output = `${workdir}\n`;

  try {
    const { result } = await runInjectedCodex({
      root,
      functionCallOutput: formattedFunctionCallOutput(output),
      events: [
        commandExecution(output),
        agentMessage('not-done'),
        codexEvent('turn.completed'),
      ],
    });
    assert.equal(result.ok, false);
    assert.match(result.productDiagnostics.join('; '), /final assistant text/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runCodexRealExec rejects a changed receipt header not present in the original client request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-real-exec-changed-original-'));
  const output = `${join(root, 'codex-real-exec', 'workdir')}\n`;

  try {
    const { result } = await runInjectedCodex({
      root,
      functionCallOutput: formattedFunctionCallOutput(output, { chunkId: 'changed-header' }),
      events: [
        commandExecution(output),
        agentMessage('done'),
        codexEvent('turn.completed'),
      ],
    });
    assert.equal(result.ok, false);
    assert.match(
      result.productDiagnostics.join('; '),
      /does not exactly match original client function_call_output/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
