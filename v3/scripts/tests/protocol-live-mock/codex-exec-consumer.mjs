import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export const CODEX_REAL_EXEC_CONSUMER = 'codex-real-exec';
export const CURRENT_CODEX_EXEC_COMMAND_DESCRIPTION =
  'Runs a command in a PTY, returning output or a session ID for ongoing interaction.';

const MAX_PROCESS_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120000;
const CONSUMER_PROMPT = 'Run the exec_command tool call returned by the server exactly once. Report the command result after it completes.';

export function buildCodexExecConfig({ rccUrl }) {
  const url = new URL(String(rccUrl));
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error(`Codex replay requires loopback RCC, got ${url.hostname}`);
  }
  const baseUrl = `${url.origin}/v1`;
  return [
    'model_provider = "rcc_replay"',
    'model = "mock.chat-model"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    '',
    '[model_providers.rcc_replay]',
    'name = "RCC replay"',
    `base_url = "${baseUrl}"`,
    'wire_api = "responses"',
    'env_key = "RCC_REPLAY_API_KEY"',
    'requires_openai_auth = false',
    'supports_websockets = false',
    '',
  ].join('\n');
}

export function parseCodexExecEvents(stdout) {
  if (typeof stdout !== 'string') throw new Error('Codex stdout must be a string');
  const events = [];
  for (const [index, line] of stdout.split(/\r?\n/u).entries()) {
    if (line.trim().length === 0) continue;
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('event must be an object');
      }
      events.push(value);
    } catch (error) {
      throw new Error(`Codex JSONL line ${index + 1} is invalid: ${error.message}`);
    }
  }
  return events;
}

function commandExecutions(events) {
  return events.filter((event) => event?.type === 'item.completed'
    && event?.item?.type === 'command_execution');
}

function canonicalAuthorizedCommand(command, authorizedCommands) {
  if (typeof command !== 'string' || command.length === 0) return null;
  for (const authorized of authorizedCommands) {
    if (command === authorized) return authorized;
    if (authorized === 'pwd' && /^(?:\/bin\/)?(?:zsh|bash) -lc (?:"pwd"|'pwd'|pwd)$/u.test(command)) {
      return authorized;
    }
  }
  return null;
}

export function validateCodexCommandExecution(events, {
  authorized_commands: authorizedCommands,
  expected_cwd: expectedCwd,
} = {}) {
  if (!Array.isArray(authorizedCommands) || authorizedCommands.length === 0
    || authorizedCommands.some((command) => typeof command !== 'string' || command.length === 0)) {
    return { ok: false, diagnostic: 'authorized_commands must be a non-empty string array', executions: [] };
  }
  if (typeof expectedCwd !== 'string' || !isAbsolute(expectedCwd)) {
    return { ok: false, diagnostic: 'expected_cwd must be an absolute path', executions: [] };
  }
  const rawExecutions = commandExecutions(events);
  if (rawExecutions.length !== 1) {
    return {
      ok: false,
      diagnostic: `real Codex must execute exactly one command, observed ${rawExecutions.length}`,
      executions: rawExecutions.map((event) => event.item),
    };
  }
  const execution = rawExecutions[0].item;
  const canonical = canonicalAuthorizedCommand(execution.command, authorizedCommands);
  if (canonical === null) {
    return {
      ok: false,
      diagnostic: `real Codex executed unauthorized command ${JSON.stringify(execution.command)}`,
      executions: [execution],
    };
  }
  if (execution.exit_code !== 0) {
    return { ok: false, diagnostic: `real Codex command exited ${execution.exit_code ?? 'missing'}`, executions: [execution] };
  }
  if (execution.status !== 'completed') {
    return { ok: false, diagnostic: `real Codex command status is ${execution.status ?? 'missing'}`, executions: [execution] };
  }
  if (typeof execution.aggregated_output !== 'string' || execution.aggregated_output.trim().length === 0) {
    return { ok: false, diagnostic: 'real Codex command output is empty', executions: [execution] };
  }
  const output = execution.aggregated_output.trim();
  if (!isAbsolute(output)) {
    return { ok: false, diagnostic: `real Codex command output is not absolute: ${output}`, executions: [execution] };
  }
  let expected;
  let actual;
  try {
    expected = realpathSync(expectedCwd);
    actual = realpathSync(output);
  } catch (error) {
    return { ok: false, diagnostic: `real Codex cwd verification failed: ${error.message}`, executions: [execution] };
  }
  if (actual !== expected) {
    return {
      ok: false,
      diagnostic: `real Codex command output ${actual} does not match expected cwd ${expected}`,
      executions: [execution],
    };
  }
  return {
    ok: true,
    diagnostic: null,
    executions: [{
      ...execution,
      canonical_command: canonical,
      output_channel: 'aggregated',
    }],
  };
}

function resolveCodexBinary(explicit) {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  if (typeof process.env.CODEX_CLI_PATH === 'string' && process.env.CODEX_CLI_PATH.length > 0) {
    return process.env.CODEX_CLI_PATH;
  }
  const appBinary = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  if (existsSync(appBinary)) return appBinary;
  const localBinary = join(homedir(), '.local/bin/codex');
  if (existsSync(localBinary)) return localBinary;
  return 'codex';
}

export const DEFAULT_CODEX_CLI_PROBE_TIMEOUT_MS = 15000;

export function codexCliAvailability(explicit, { timeoutMs = DEFAULT_CODEX_CLI_PROBE_TIMEOUT_MS } = {}) {
  const binary = resolveCodexBinary(explicit);
  let probe;
  try {
    probe = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: timeoutMs });
  } catch (error) {
    return { available: false, binary, kind: 'probe_failed', reason: error?.message ?? String(error) };
  }
  if (probe.error) {
    return {
      available: false,
      binary,
      kind: probe.error.code === 'ENOENT' ? 'not_found' : 'probe_failed',
      reason: probe.error.message ?? String(probe.error),
    };
  }
  if (probe.status !== 0) {
    const reason = probe.signal ? `signal ${probe.signal}` : `exit ${probe.status}`;
    return { available: false, binary, kind: 'probe_failed', reason };
  }
  return { available: true, binary, kind: 'available' };
}

function isolatedEnvironment(codexHome) {
  const env = { ...process.env, CODEX_HOME: codexHome, RCC_REPLAY_API_KEY: 'rcc-replay-test-token' };
  for (const name of [
    'CODEX_SESSION_ID',
    'CODEX_THREAD_ID',
    'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
    'CODEX_APP_TOOLS_PIPE_PATH',
    'CODEX_APP_SERVER_SOCKET',
    'COLLAB_APPSERVER_SOCKET',
  ]) {
    delete env[name];
  }
  return env;
}

function terminateExactChild(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  }, 1000);
  timer.unref?.();
}

function collectChild({ binary, args, cwd, env, prompt, timeoutMs }) {
  return new Promise((resolveRun) => {
    let child;
    let childPid = null;
    try {
      child = spawn(binary, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      childPid = child.pid ?? null;
    } catch (error) {
      resolveRun({
        spawn_error: error,
        child_pid: null,
        stdout: '',
        stderr: '',
        exit_code: null,
        signal: null,
        timed_out: false,
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveRun(result);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateExactChild(child);
    }, timeoutMs);
    const append = (current, chunk, label) => {
      const next = current + chunk.toString('utf8');
      if (Buffer.byteLength(next, 'utf8') > MAX_PROCESS_OUTPUT_BYTES) {
        terminateExactChild(child);
        throw new Error(`Codex ${label} exceeded ${MAX_PROCESS_OUTPUT_BYTES} bytes`);
      }
      return next;
    };
    child.stdout.on('data', (chunk) => {
      try {
        stdout = append(stdout, chunk, 'stdout');
      } catch (error) {
        stderr += `${error.message}\n`;
        terminateExactChild(child);
      }
    });
    child.stderr.on('data', (chunk) => {
      try {
        stderr = append(stderr, chunk, 'stderr');
      } catch (error) {
        stderr += `${error.message}\n`;
        terminateExactChild(child);
      }
    });
    child.once('error', (error) => finish({
      spawn_error: error,
      child_pid: childPid,
      stdout,
      stderr,
      exit_code: null,
      signal: null,
      timed_out: timedOut,
    }));
    child.once('close', (code, signal) => finish({
      spawn_error: null,
      child_pid: childPid,
      stdout,
      stderr,
      exit_code: code,
      signal,
      timed_out: timedOut,
    }));
    child.stdin.once('error', () => {});
    child.stdin.end(prompt);
  });
}

export async function executeCodexClient({
  fixture,
  rccUrl,
  evidenceRoot,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  codexBinary,
}) {
  const runRoot = join(evidenceRoot, 'codex-real-exec');
  const codexHome = join(runRoot, 'codex-home');
  const workdir = join(runRoot, 'workdir');
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(workdir, { recursive: true });
  execFileSync('git', ['init', '--quiet', workdir], { stdio: 'pipe' });
  const configPath = join(codexHome, 'config.toml');
  const promptPath = join(runRoot, 'prompt.txt');
  const stdoutPath = join(runRoot, 'codex-exec.stdout.jsonl');
  const stderrPath = join(runRoot, 'codex-exec.stderr.log');
  const prompt = CONSUMER_PROMPT;
  writeFileSync(configPath, buildCodexExecConfig({ rccUrl }));
  writeFileSync(promptPath, `${prompt}\n`);

  const binary = resolveCodexBinary(codexBinary);
  const args = [
    'exec',
    '--json',
    '--ephemeral',
    '--sandbox',
    'read-only',
    '-C',
    workdir,
    '--strict-config',
    '-c',
    'approval_policy="never"',
    '-c',
    'model_provider="rcc_replay"',
    '-c',
    'model="mock.chat-model"',
    '-',
  ];
  const result = await collectChild({
    binary,
    args,
    cwd: workdir,
    env: isolatedEnvironment(codexHome),
    prompt,
    timeoutMs,
  });
  writeFileSync(stdoutPath, result.stdout);
  writeFileSync(stderrPath, result.stderr);
  return {
    ...result,
    binary,
    args,
    codex_home: codexHome,
    workdir,
    config_path: configPath,
    prompt_path: promptPath,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
  };
}

function providerTools(capture) {
  const tools = capture?.body?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => ({
    declaration: tool?.function && typeof tool.function === 'object' ? tool.function : tool,
    wrapper: tool,
  }));
}

function validateRegisteredExecSchema(capture) {
  const matches = providerTools(capture)
    .map(({ declaration }) => declaration)
    .filter((tool) => tool?.name === 'exec_command');
  if (matches.length !== 1) {
    return { ok: false, diagnostic: `provider request must declare exactly one exec_command tool, observed ${matches.length}` };
  }
  const tool = matches[0];
  if (tool.description !== CURRENT_CODEX_EXEC_COMMAND_DESCRIPTION) {
    return {
      ok: false,
      diagnostic: `provider exec_command description mismatch: ${JSON.stringify(tool.description)}`,
    };
  }
  for (const field of ['max_output_tokens', 'yield_time_ms']) {
    if (tool?.parameters?.properties?.[field]?.type !== 'integer') {
      return {
        ok: false,
        diagnostic: `provider exec_command.${field}.type must be integer, observed ${tool?.parameters?.properties?.[field]?.type ?? 'missing'}`,
      };
    }
  }
  return { ok: true, diagnostic: null };
}

function chatHistory(capture) {
  const messages = capture?.body?.messages;
  return Array.isArray(messages) ? messages : [];
}

function preservesConsumerUserPrompt(capture) {
  return chatHistory(capture).some((message) => {
    if (message?.role !== 'user') return false;
    const content = message.content;
    if (typeof content === 'string') return content === CONSUMER_PROMPT;
    if (!Array.isArray(content)) return false;
    const text = content.map((part) => {
      if (typeof part === 'string') return part;
      return ['text', 'input_text'].includes(part?.type) && typeof part.text === 'string'
        ? part.text : '';
    }).join('');
    return text === CONSUMER_PROMPT;
  });
}

function readOriginalClientFunctionCallOutput({ sampleRoot, listenerPort, callId }) {
  if (typeof sampleRoot !== 'string' || !Number.isSafeInteger(listenerPort)
    || typeof callId !== 'string' || callId.length === 0) {
    return {
      ok: false,
      diagnostic: 'original client sample root, listener port, and call id are required',
    };
  }
  const portRoot = join(sampleRoot, 'openai-responses', 'ports', String(listenerPort));
  if (!existsSync(portRoot)) {
    return { ok: false, diagnostic: `original client sample port root missing: ${portRoot}` };
  }
  let requestDirs;
  try {
    requestDirs = readdirSync(portRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    return { ok: false, diagnostic: `original client sample port read failed: ${error.message}` };
  }
  const matches = [];
  for (const requestDir of requestDirs) {
    const requestPath = join(portRoot, requestDir, 'request.json');
    if (!existsSync(requestPath)) continue;
    let request;
    try {
      request = JSON.parse(readFileSync(requestPath, 'utf8'));
    } catch (error) {
      return { ok: false, diagnostic: `original client sample parse failed for ${requestPath}: ${error.message}` };
    }
    const collect = (value) => {
      if (Array.isArray(value)) {
        for (const entry of value) collect(entry);
        return;
      }
      if (!value || typeof value !== 'object') return;
      if (value.type === 'function_call_output' && value.call_id === callId) {
        matches.push({ output: value.output, path: requestPath, request_id: requestDir });
        return;
      }
      for (const entry of Object.values(value)) collect(entry);
    };
    collect(request);
  }
  if (matches.length !== 1) {
    return {
      ok: false,
      diagnostic: `original client request must contain exactly one function_call_output for ${callId}, observed ${matches.length}`,
    };
  }
  const [match] = matches;
  if (typeof match.output !== 'string' || match.output.length === 0) {
    return {
      ok: false,
      diagnostic: `original client function_call_output ${callId} must be a non-empty string`,
    };
  }
  return { ok: true, diagnostic: null, ...match };
}

const CODEX_TOOL_OUTPUT_PREFIX =
  /^Chunk ID: [^\n]+\nWall time: [^\n]+\nProcess exited with code (\d+)\n(?:Original token count: \d+\n)?Output:\n/u;

function validateCodexToolOutput(content, execution) {
  if (typeof content !== 'string' || content.length === 0) {
    return { ok: false, diagnostic: 'follow-up tool output must be a non-empty string' };
  }
  const match = CODEX_TOOL_OUTPUT_PREFIX.exec(content);
  if (!match) {
    return {
      ok: false,
      diagnostic: 'follow-up tool output is not the complete Codex execution receipt',
    };
  }
  const receiptExitCode = Number(match[1]);
  if (receiptExitCode !== execution.exit_code) {
    return {
      ok: false,
      diagnostic: `follow-up tool output exit code ${receiptExitCode} != command event exit code ${execution.exit_code}`,
    };
  }
  const executionOutput = content.slice(match[0].length);
  if (executionOutput !== execution.aggregated_output) {
    return {
      ok: false,
      diagnostic: 'follow-up tool output execution result does not match the command event aggregated_output',
    };
  }
  return {
    ok: true,
    diagnostic: null,
    execution_output: executionOutput,
  };
}

function validateFollowupCapture(capture, {
  callId,
  expectedArguments,
  execution,
  originalClientOutput,
}) {
  const messages = chatHistory(capture);
  const calls = messages.flatMap((message, messageIndex) => (
    message?.role === 'assistant' && Array.isArray(message.tool_calls)
      ? message.tool_calls.map((call) => ({ call, messageIndex }))
      : []
  ));
  if (calls.length !== 1) {
    return { ok: false, diagnostic: `follow-up provider request must contain exactly one assistant tool call, observed ${calls.length}` };
  }
  const [{ call, messageIndex }] = calls;
  if (call?.id !== callId || call?.type !== 'function' || call?.function?.name !== 'exec_command') {
    return {
      ok: false,
      diagnostic: `follow-up assistant call does not preserve ${callId}/exec_command`,
    };
  }
  if (call?.function?.arguments !== expectedArguments) {
    return {
      ok: false,
      diagnostic: `follow-up assistant arguments ${JSON.stringify(call?.function?.arguments)} do not match ${JSON.stringify(expectedArguments)}`,
    };
  }
  const tools = messages.flatMap((message, toolMessageIndex) => (
    message?.role === 'tool' && message.tool_call_id === callId
      ? [{ tool: message, toolMessageIndex }]
      : []
  ));
  if (tools.length !== 1) {
    return { ok: false, diagnostic: `follow-up provider request must contain exactly one matched tool output ${callId}, observed ${tools.length}` };
  }
  const [{ tool, toolMessageIndex }] = tools;
  if (toolMessageIndex !== messageIndex + 1) {
    return { ok: false, diagnostic: `matched tool output ${callId} is not immediately after its assistant call` };
  }
  const output = validateCodexToolOutput(tool.content, execution);
  if (!output.ok) {
    return { ok: false, diagnostic: output.diagnostic };
  }
  if (!originalClientOutput.ok) {
    return { ok: false, diagnostic: originalClientOutput.diagnostic };
  }
  if (tool.content !== originalClientOutput.output) {
    return {
      ok: false,
      diagnostic: `follow-up tool output does not exactly match original client function_call_output ${callId}`,
    };
  }
  return {
    ok: true,
    diagnostic: null,
    observed_call: {
      call_id: call.id,
      name: call.function.name,
      raw_arguments: call.function.arguments,
      output: tool.content,
      execution_output: output.execution_output,
      original_client_sample: originalClientOutput.path,
      original_client_request_id: originalClientOutput.request_id,
    },
  };
}

export function validateCodexFinalOutcome(events, { expectedText } = {}) {
  if (typeof expectedText !== 'string' || expectedText.length === 0) {
    return { ok: false, diagnostic: 'expected final assistant text is missing' };
  }
  const messages = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event?.type === 'item.completed' && event?.item?.type === 'agent_message');
  const terminals = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event?.type === 'turn.completed');
  if (messages.length === 0) {
    return { ok: false, diagnostic: 'final assistant text missing from Codex events' };
  }
  if (terminals.length !== 1) {
    return {
      ok: false,
      diagnostic: `Codex events must contain exactly one turn.completed, observed ${terminals.length}`,
    };
  }
  const finalMessage = messages.at(-1);
  if (finalMessage.index > terminals[0].index) {
    return { ok: false, diagnostic: 'final assistant text is not followed by turn.completed' };
  }
  const text = finalMessage.event.item.text;
  if (text !== expectedText) {
    return {
      ok: false,
      diagnostic: `final assistant text ${JSON.stringify(text)} does not match expected ${JSON.stringify(expectedText)}`,
    };
  }
  return {
    ok: true,
    diagnostic: null,
    observation: {
      text,
      turn_completed: true,
      message_count: messages.length,
    },
  };
}

function writeReceipt(path, receipt) {
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
}

export async function runCodexRealExec({
  fixture,
  mock,
  rccUrl,
  evidenceRoot,
  timeoutMs,
  codexBinary,
  sampleRoot,
  listenerPort,
  executeClient = executeCodexClient,
}) {
  const diagnostic = [];
  const runner = [];
  const evidenceRefs = [];
  if (fixture?.tool_followup?.consumer !== CODEX_REAL_EXEC_CONSUMER) {
    return {
      ok: false,
      productDiagnostics: [`not declared as ${CODEX_REAL_EXEC_CONSUMER}`],
      runnerDiagnostics: [],
      executions: [],
      provider_windows: {},
      evidenceRefs,
    };
  }
  if (!mock || typeof mock.setActiveCase !== 'function' || typeof mock.getCaptures !== 'function') {
    return {
      ok: false,
      productDiagnostics: [],
      runnerDiagnostics: ['codex-real-exec requires the matrix mock provider'],
      executions: [],
      provider_windows: {},
      evidenceRefs,
    };
  }
  const baseline = mock.getCaptures(fixture.case_id).length;
  mock.setActiveCase(fixture, 0);
  if (typeof mock.advanceTurnAfterResponse === 'function') {
    mock.advanceTurnAfterResponse(fixture.case_id, 0, 1);
  }
  let result;
  try {
    result = await executeClient({ fixture, rccUrl, evidenceRoot, timeoutMs, codexBinary });
  } catch (error) {
    runner.push(`Codex client execution failed: ${error.message}`);
    result = {
      spawn_error: error,
      stdout: '',
      stderr: '',
      exit_code: null,
      signal: null,
      timed_out: false,
      workdir: null,
    };
  }

  const captures = mock.getCaptures(fixture.case_id).slice(baseline);
  const providerWindows = {};
  for (const capture of captures) {
    if (capture?.attempt_kind !== 'business') continue;
    const turn = Number.isSafeInteger(capture.turn) ? capture.turn : 0;
    providerWindows[turn] = [...(providerWindows[turn] ?? []), capture];
  }

  if (result.spawn_error) runner.push(`Codex spawn failed: ${result.spawn_error.message ?? result.spawn_error}`);
  if (result.timed_out) runner.push(`Codex execution timed out after ${timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`);
  if (result.exit_code !== 0) diagnostic.push(`Codex exited ${result.exit_code ?? 'without status'}`);

  let events = [];
  try {
    events = parseCodexExecEvents(result.stdout ?? '');
  } catch (error) {
    diagnostic.push(error.message);
  }
  const finalOutcome = validateCodexFinalOutcome(events, {
    expectedText: fixture?.turns?.at(-1)?.expected_client_must?.['output.0.content.0.text'],
  });
  if (!finalOutcome.ok) diagnostic.push(finalOutcome.diagnostic);

  if ((providerWindows[0] ?? []).length !== 1) {
    diagnostic.push(`first provider turn must have exactly one business attempt, observed ${(providerWindows[0] ?? []).length}`);
  } else {
    const schema = validateRegisteredExecSchema(providerWindows[0][0]);
    if (!schema.ok) diagnostic.push(schema.diagnostic);
    if (!preservesConsumerUserPrompt(providerWindows[0][0])) {
      diagnostic.push('provider request must preserve the exact real consumer user prompt');
    }
  }
  if ((providerWindows[1] ?? []).length !== 1) {
    diagnostic.push(`follow-up provider turn must have exactly one business attempt, observed ${(providerWindows[1] ?? []).length}`);
  }

  const commandResult = validateCodexCommandExecution(events, {
    authorized_commands: fixture.tool_followup.authorized_commands,
    expected_cwd: result.workdir,
  });
  if (!commandResult.ok) diagnostic.push(commandResult.diagnostic);
  const execution = commandResult.ok ? commandResult.executions[0] : null;
  let followup = null;
  if (execution && (providerWindows[1] ?? []).length === 1) {
    const callId = fixture.tool_followup.expected_call_id;
    const originalClientOutput = readOriginalClientFunctionCallOutput({
      sampleRoot,
      listenerPort,
      callId,
    });
    followup = validateFollowupCapture(providerWindows[1][0], {
      callId,
      expectedArguments: fixture.tool_followup.expected_arguments,
      execution,
      originalClientOutput,
    });
    if (!followup.ok) diagnostic.push(followup.diagnostic);
  }

  const runRoot = result.workdir ? join(result.workdir, '..') : join(evidenceRoot, 'codex-real-exec');
  mkdirSync(runRoot, { recursive: true });
  const receiptPath = join(runRoot, 'codex-exec.receipt.json');
  const receipt = {
    case_id: fixture.case_id,
    consumer: CODEX_REAL_EXEC_CONSUMER,
    authority: {
      authorized_commands: fixture.tool_followup.authorized_commands,
      expected_call_id: fixture.tool_followup.expected_call_id,
      isolated_codex_home: true,
      global_session_identity_removed: true,
    },
    process: {
      binary: result.binary ?? null,
      pid: result.child_pid ?? null,
      args: result.args ?? [],
      exit_code: result.exit_code,
      signal: result.signal,
      timed_out: Boolean(result.timed_out),
      spawn_error: result.spawn_error ? result.spawn_error.message ?? String(result.spawn_error) : null,
    },
    cwd: result.workdir ?? null,
    observed_exec: followup?.observed_call ?? null,
    final_client: finalOutcome.observation ?? null,
    events,
    command_executions: commandResult.executions,
    provider_turns: Object.fromEntries(Object.entries(providerWindows).map(([turn, values]) => [
      turn,
      {
        business_attempts: values.length,
        requests: values.map((capture) => ({
          path: capture.path,
          method: capture.method,
          raw_body: capture.raw_body,
          headers: capture.headers,
        })),
      },
    ])),
    diagnostics: diagnostic,
    runner_diagnostics: runner,
    cleanup: {
      codex_home: result.codex_home ? 'retained as evidence' : 'not_created',
      workdir: result.workdir ? 'retained as evidence' : 'not_created',
    },
    artifacts: {
      config: result.config_path ?? null,
      prompt: result.prompt_path ?? null,
      stdout: result.stdout_path ?? null,
      stderr: result.stderr_path ?? null,
    },
  };
  writeReceipt(receiptPath, receipt);
  evidenceRefs.push(receiptPath);
  for (const reference of [
    result.config_path,
    result.prompt_path,
    result.stdout_path,
    result.stderr_path,
  ]) {
    if (reference) evidenceRefs.push(reference);
  }

  return {
    ok: diagnostic.length === 0 && runner.length === 0,
    productDiagnostics: diagnostic,
    runnerDiagnostics: runner,
    executions: commandResult.executions,
    provider_windows: providerWindows,
    finalClient: finalOutcome.observation ?? null,
    receipt,
    receiptPath,
    evidenceRefs,
  };
}
