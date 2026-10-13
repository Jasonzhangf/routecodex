import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const options = {
  repo: '/Volumes/Intel/playground/routecodex/magpie-live-matrix-20261012',
  binary: '/Users/fanzhang/.local/bin/rccv3',
};

for (let i = 0; i < argv.length; i += 2) {
  const key = argv[i]?.replace(/^--/, '');
  const value = argv[i + 1];
  if (!value) throw new Error(`missing value for --${key}`);
  if (key === 'repo') options.repo = resolve(value);
  else if (key === 'binary') options.binary = resolve(value);
  else throw new Error(`unknown argument --${key}`);
}

const root = fileURLToPath(new URL('.', import.meta.url));
const repo = resolve(options.repo);
const helperRoot = resolve(repo, 'v3/scripts/tests/protocol-live-mock');
const lifecycle = await import(`file://${helperRoot}/lifecycle.mjs`);
const { startMockProvider } = await import(`file://${helperRoot}/mock-provider.mjs`);
const { runCase } = await import(`file://${helperRoot}/case-runner.mjs`);
const { extractToolCalls, executeDeclaredEchoTool } = await import(`file://${helperRoot}/tool-consumer.mjs`);

const fixturePath = fileURLToPath(new URL('./direct-chat-echo-control.json', import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const receiptPath = fileURLToPath(new URL('./control-receipt.json', import.meta.url));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const receipt = {
  command: ['node', fileURLToPath(import.meta.url), '--repo', repo, '--binary', options.binary],
  started_at_iso: new Date().toISOString(),
  fixture: { path: fixturePath, case_id: fixture.case_id, sha256: sha256(readFileSync(fixturePath)) },
  binary: lifecycle.captureRuntimeIdentity(options.binary),
  source_hashes: {
    'lifecycle.mjs': sha256(readFileSync(`${helperRoot}/lifecycle.mjs`)),
    'mock-provider.mjs': sha256(readFileSync(`${helperRoot}/mock-provider.mjs`)),
    'case-runner.mjs': sha256(readFileSync(`${helperRoot}/case-runner.mjs`)),
    'tool-consumer.mjs': sha256(readFileSync(`${helperRoot}/tool-consumer.mjs`)),
    'protocol-semantics.mjs': sha256(readFileSync(`${helperRoot}/protocol-semantics.mjs`)),
  },
};

let mock = null;
let generated = null;
let handle = null;

const allocateLoopbackPort = async () => {
  const server = createServer();
  await new Promise((resolvePort, rejectPort) => {
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', resolvePort);
  });
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
};

const providerCaptureByIdx = (idx) => receipt.provider_captures?.[idx] ?? null;

try {
  mock = await startMockProvider({ host: '127.0.0.1', port: 0 });
  receipt.mock_address = mock.url;

  const rccPort = await allocateLoopbackPort();
  generated = await lifecycle.generateRccConfig({
    mockPort: mock.port,
    rccPort,
    providerProtocol: 'openai_chat',
    mode: 'direct',
    workRoot: root,
  });
  receipt.config = {
    path: generated.path,
    state: generated.state,
    listeners: generated.listeners,
    env: generated.env,
    mode: generated.mode,
    mode_receipt: generated.mode_receipt,
    config_sha256: sha256(readFileSync(generated.path)),
    provider_sha256: sha256(readFileSync(generated.provider_path)),
  };
  writeFileSync(fileURLToPath(new URL('./control-config.toml', import.meta.url)), generated.text);
  writeFileSync(fileURLToPath(new URL('./control-provider.toml', import.meta.url)), generated.provider_text);

  receipt.bind_diagnosis = await lifecycle.diagnoseListenerSet(generated.listeners);
  if (!receipt.bind_diagnosis.all_bound || !receipt.bind_diagnosis.all_released) {
    throw new Error('declared loopback/Admin addresses are not both free');
  }

  const configCheck = spawnSync(options.binary, ['config', 'check', '-c', generated.path], {
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      HOME: generated.home,
      ROUTECODEX_V3_STATE_DIR: generated.state,
      ...generated.env,
    },
  });
  receipt.config_check = {
    command: [options.binary, 'config', 'check', '-c', generated.path],
    exit_code: configCheck.status,
    signal: configCheck.signal,
    stdout: configCheck.stdout,
    stderr: configCheck.stderr,
    error: configCheck.error?.message ?? null,
  };
  if (configCheck.status !== 0 || configCheck.error) throw new Error('RCC config check failed');

  receipt.start_command = [options.binary, 'server', 'start', '--foreground', '--config', generated.path];
  handle = await lifecycle.startRcc(options.binary, generated, rccPort, receipt, { startupTimeoutMs: 10000 });
  receipt.pid = handle.pid;
  receipt.health = handle.health;
  if (!handle.ready) throw new Error(receipt.infra_failure?.diagnostic ?? 'RCC foreground process was not ready');

  const evidenceRoot = fileURLToPath(new URL('./evidence', import.meta.url));
  receipt.case_report = await runCase({
    fixture,
    mock,
    rccUrl: `http://127.0.0.1:${rccPort}`,
    sendHttp: lifecycle.sendHttp,
    evidenceRoot,
    timeoutMs: 15000,
  });

  receipt.provider_captures = mock.getCaptures(fixture.case_id);
  const business = receipt.provider_captures.filter((capture) => capture.attempt_kind === 'business');

  const firstClientEvidence = JSON.parse(readFileSync(`${evidenceRoot}/captures/direct-chat-echo-control-turn-1-client.json`, 'utf8'));
  const observedCall = extractToolCalls('openai_chat', firstClientEvidence.client_response)[0] ?? null;
  const output = executeDeclaredEchoTool({
    request: fixture.turns[0].client_request,
    call: observedCall,
  });

  const secondCapture = business.find((capture) => capture.turn === 1);
  const secondClientEvidence = JSON.parse(readFileSync(`${evidenceRoot}/captures/direct-chat-echo-control-turn-2-client.json`, 'utf8'));

  receipt.control_assertions = {
    run_case_passed: receipt.case_report?.status === 'passed',
    observed_call: {
      count: extractToolCalls('openai_chat', firstClientEvidence.client_response).length,
      id: observedCall?.id,
      name: observedCall?.name,
      arguments: observedCall?.arguments,
    },
    execution: {
      count: receipt.case_report?.observations?.live?.find((entry) => entry.kind === 'tool_execution')?.executions?.length ?? 0,
      output,
    },
    second_provider: {
      business_attempt_count: business.filter((capture) => capture.turn === 1).length,
      model: secondCapture?.body?.model,
      stream: secondCapture?.body?.stream,
      assistant_tool_call: secondCapture?.body?.messages?.[1],
      tool_result: secondCapture?.body?.messages?.[2],
    },
    second_client: {
      status: secondClientEvidence.client_response.status,
      body: secondClientEvidence.client_response.body,
    },
  };

  const assertions = receipt.control_assertions;
  receipt.behavior_pass = Boolean(
    assertions.run_case_passed &&
    assertions.observed_call.count === 1 &&
    assertions.observed_call.id === 'call_direct_echo_control' &&
    assertions.observed_call.name === 'echo' &&
    assertions.observed_call.arguments === '{"text":"control-42"}' &&
    assertions.execution.count === 1 &&
    assertions.execution.output === 'control-42' &&
    assertions.second_provider.business_attempt_count === 1 &&
    assertions.second_provider.assistant_tool_call?.tool_calls?.[0]?.id === 'call_direct_echo_control' &&
    assertions.second_provider.tool_result?.tool_call_id === 'call_direct_echo_control' &&
    assertions.second_provider.tool_result?.content === 'control-42' &&
    assertions.second_client.status === 200 &&
    assertions.second_client.body?.choices?.[0]?.message?.content === 'control-42' &&
    assertions.second_client.body?.choices?.[0]?.finish_reason === 'stop'
  );
} catch (error) {
  receipt.failure = {
    message: error.message,
    stack: error.stack,
    code: error.code ?? null,
  };
} finally {
  if (handle) {
    receipt.cleanup = receipt.cleanup ?? await lifecycle.stopRcc(handle, receipt, {
      shutdownTimeoutMs: 3000,
      socketCloseTimeoutMs: 1000,
    });
    receipt.child = handle.diagnostics();
  }
  if (mock) {
    receipt.provider_captures = receipt.provider_captures ?? mock.getCaptures();
    await mock.close();
    receipt.mock_closed = true;
  }
  if (generated && (!handle || receipt.cleanup?.complete)) {
    generated.cleanup();
    receipt.config_state_removed = !existsSync(generated.root);
  }
  receipt.pass = Boolean(
    receipt.behavior_pass &&
    receipt.cleanup?.complete &&
    receipt.cleanup?.all_listeners_closed &&
    !receipt.cleanup?.force_killed &&
    receipt.mock_closed &&
    receipt.config_state_removed
  );
  receipt.exit_code = receipt.pass ? 0 : 1;
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
}

console.log(JSON.stringify({
  pass: receipt.pass,
  exit_code: receipt.exit_code,
  receipt: receiptPath,
  failure: receipt.failure,
  cleanup: receipt.cleanup,
}));
process.exitCode = receipt.exit_code;
