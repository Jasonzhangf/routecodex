// Focused tests for the protocol-live-mock corpus loader/validator.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CorpusError,
  HARNESS_ID,
  SOURCE_LICENSE,
  SOURCE_REPO,
  SOURCE_SHA,
  corpusCoverage,
  inspectCorpus,
  loadFixtures,
} from './corpus.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const realFixtureRoot = join(repoRoot, 'v3', 'fixtures', 'protocol-live-mock-matrix');

function validManifest(cases) {
  return { harness_id: HARNESS_ID, schema_version: 1, source: { repo: SOURCE_REPO, sha: SOURCE_SHA, license: SOURCE_LICENSE }, cases };
}

function baseCase(overrides = {}) {
  return {
    schema_version: 1,
    case_id: 'valid-case',
    cell: { entry_protocol: 'openai_chat', provider_protocol: 'openai_chat', transport: 'json', mode: 'direct' },
    client_request: { method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' }, body: { model: 'mock.chat-model', messages: [{ role: 'user', content: 'hello' }] } },
    expected_provider: { paths: ['/v1/chat/completions'], method: 'POST', auth_required: true, body_must: { 'messages.0.content': 'hello' }, body_must_not: ['routecodex_internal'], exact: null },
    upstream_response: { protocol: 'openai_chat', mode: 'json', status: 200, content_type: 'application/json', body: { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] } },
    expected_client: { transport: 'complete', status: 200, body_must: { 'choices.0.message.content': 'ok' }, body_must_not: ['provider_error'], semantic_terminal_required: true },
    assertions: { provider_attempt_count: 1, probe_attempts_may_occur: true, no_control_leakage: true },
    source: { sha: SOURCE_SHA, files: [], tests: [] },
    contract_differences: [],
    ...overrides,
  };
}

function writeFixture(cases, manifest) {
  const root = mkdtempSync(join(tmpdir(), 'corpus-matrix-'));
  mkdirSync(join(root, 'cases'), { recursive: true });
  writeFileSync(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [id, value] of Object.entries(cases)) {
    writeFileSync(join(root, 'cases', `${id}.json`), `${JSON.stringify(value, null, 2)}\n`);
  }
  return root;
}

function withFixture(cases, manifest, fn) {
  const root = writeFixture(cases, manifest);
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function findingsOf(root) {
  return inspectCorpus(root).findings.join('\n');
}

test('real corpus loads 61 fixtures sorted with exact identities', () => {
  const loaded = loadFixtures(realFixtureRoot);
  assert.equal(loaded.length, 61);
  const ids = loaded.map((entry) => entry.value.case_id);
  assert.equal(ids.length, new Set(ids).size);
  assert.equal(ids[0], 'anthropic-to-anthropic-json');
  assert.equal(ids.at(-1), 'usage-missing-or-null-preserved');
  assert.deepEqual(loaded.map((entry) => entry.relative), [...loaded.map((entry) => entry.relative)].sort());
  const report = inspectCorpus(realFixtureRoot);
  assert.equal(report.ok, true, report.findings.join('\n'));
  assert.equal(report.case_count, 61);
  assert.deepEqual(report.findings, []);
  assert.equal(report.coverage.base_cells, 16);
  assert.equal(report.coverage.base_cells_covered, 16);
  assert.equal(report.coverage.base_variants_covered, 32);
  assert.equal(report.extensions.length, 29);
  assert.equal(report.source_refs.checked, false);
  assert.deepEqual(report.source_refs.stale_files, []);
  assert.deepEqual(report.source_refs.stale_tests, []);
});

test('fe1ec4b fixtures bind public JSON/SSE evidence and typed countercases', () => {
  const loaded = loadFixtures(realFixtureRoot);
  const byId = new Map(loaded.map((entry) => [entry.value.case_id, entry.value]));
  const primary = byId.get('fe1ec4b-responses-ciphertext-json-sse-two-turn');
  assert.ok(primary);
  assert.equal(primary.public_entry.kind, 'http-listener');
  assert.deepEqual(primary.public_entry.turn_transports, ['json', 'sse']);
  assert.deepEqual(primary.runtime_setup.candidate_ids, [
    'mock-responses-a/mock.responses-model',
    'mock-responses-b/mock.responses-model',
  ]);
  assert.equal(primary.upstream_response.mode, 'json');
  assert.equal(primary.turns[1].upstream_response.mode, 'sse');
  assert.equal(primary.turns[1].expected_provider.paths[0], '/v1/responses');
  assert.ok(primary.expected_client.body_must_not.includes('411bd3dd-47a6-49c0-8eef-6a826f349bf6-0'));
  assert.ok(primary.expected_client.body_must_not.includes('113833ee-native-cipher'));
  assert.equal(primary.expected_client.body_must['output.3.output.encrypted_content'], 'tool-business-cipher-json');
  assert.equal(primary.expected_client.body_must['output.3.output.nested.opaque'], 'keep-json-business-value');
  assert.ok(primary.turns[1].expected_provider.body_must_not.includes('input.1.encrypted_content'));
  assert.equal(
    primary.turns[1].expected_provider.body_must['input.4.output.encrypted_content'],
    'tool-business-cipher-json',
  );
  assert.equal(
    primary.turns[1].expected_client_must['output_items.3.output.encrypted_content'],
    'tool-business-cipher-sse',
  );

  for (const caseId of [
    'fe1ec4b-responses-anthropic-signature-json',
    'fe1ec4b-responses-anthropic-signature-sse',
  ]) {
    const countercase = byId.get(caseId);
    assert.ok(countercase);
    assert.equal(countercase.cell.provider_protocol, 'anthropic');
    const encryptedPath = countercase.upstream_response.mode === 'json'
      ? 'output.0.encrypted_content'
      : 'output_items.0.encrypted_content';
    assert.equal(countercase.expected_client.body_must[encryptedPath],
      countercase.upstream_response.mode === 'json'
        ? 'redacted-anthropic-fe1ec4b-json'
        : 'redacted-anthropic-fe1ec4b-sse');
  }
});

test('manifest identity and source mismatches are rejected', () => {
  const root = writeFixture({ 'valid-case': baseCase() }, { ...validManifest(['valid-case']), harness_id: 'other' });
  assert.throws(() => loadFixtures(root), /manifest identity mismatch/);
  rmSync(root, { recursive: true, force: true });
});

test('manifest source repo, sha, and license stay descriptive without an admission gate', () => {
  // The declared source metadata is descriptive history. The loader must not
  // reject a manifest whose declared source sha differs from the constant,
  // because that would turn attribution into a fixed-SHA admission check.
  const shifted = { repo: SOURCE_REPO, sha: 'a'.repeat(40), license: SOURCE_LICENSE };
  const root = writeFixture({ 'valid-case': baseCase() }, { ...validManifest(['valid-case']), source: shifted });
  try {
    assert.doesNotThrow(() => loadFixtures(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const missingLicense = { repo: SOURCE_REPO, sha: SOURCE_SHA, license: 'GPL-3.0' };
  const licenseRoot = writeFixture({ 'valid-case': baseCase() }, { ...validManifest(['valid-case']), source: missingLicense });
  try {
    assert.throws(() => loadFixtures(licenseRoot), /license mismatch/);
  } finally {
    rmSync(licenseRoot, { recursive: true, force: true });
  }
});

test('case-level source sha stays descriptive and is not a fixed-SHA admission', () => {
  // The per-case source.sha is historical attribution, so a different declared
  // sha must not create a corpus finding; the required arrays are still checked.
  const shifted = baseCase({ source: { sha: 'b'.repeat(40), files: [], tests: [] } });
  withFixture({ 'valid-case': shifted }, validManifest(['valid-case']), (root) => {
    assert.deepEqual(inspectCorpus(root).findings, []);
  });
  const missingArrays = baseCase({ source: { sha: 'c'.repeat(40) } });
  withFixture({ 'valid-case': missingArrays }, validManifest(['valid-case']), (root) => {
    const message = findingsOf(root);
    assert.match(message, /source\.files must be an array/);
    assert.match(message, /source\.tests must be an array/);
  });
});

test('duplicate manifest case ids are rejected', () => {
  withFixture({ 'valid-case': baseCase() }, validManifest(['valid-case', 'valid-case']), (root) => {
    assert.throws(() => loadFixtures(root), (error) => error instanceof CorpusError && /duplicates/.test(error.message));
  });
});

test('manifest case declared but missing on disk is rejected', () => {
  withFixture({ 'valid-case': baseCase() }, validManifest(['valid-case', 'missing-case']), (root) => {
    assert.throws(() => loadFixtures(root), /manifest case missing on disk: missing-case/);
  });
});

test('file name and declared case_id mismatch is rejected', () => {
  withFixture({ 'wrong-id': baseCase({ case_id: 'valid-case' }) }, validManifest(['valid-case']), (root) => {
    assert.throws(() => loadFixtures(root), /case_id mismatch/);
  });
});

test('a case present on disk but not declared in the manifest is rejected', () => {
  withFixture({ 'extra-case': baseCase({ case_id: 'extra-case' }) }, validManifest([]), (root) => {
    assert.throws(() => loadFixtures(root), /not declared in manifest/);
  });
});

test('missing json response script is reported without throwing', () => {
  const value = baseCase();
  delete value.upstream_response.body;
  withFixture({ 'valid-case': value }, validManifest(['valid-case']), (root) => {
    const message = findingsOf(root);
    assert.match(message, /upstream_response: body must be an object for json mode/);
  });
});

test('missing sse response script is reported', () => {
  const value = baseCase({ upstream_response: { protocol: 'openai_chat', mode: 'sse', status: 200, content_type: 'text/event-stream' } });
  withFixture({ 'valid-case': value }, validManifest(['valid-case']), (root) => {
    assert.match(findingsOf(root), /sse_events must be a non-empty array for sse mode/);
  });
});

test('fault script requires attempts and each attempt needs its kind script', () => {
  const value = baseCase({ upstream_response: { protocol: 'openai_chat', mode: 'fault', status: 200, fault: 'stream_cut', attempts: [{ kind: 'fault' }, { kind: 'json' }] } });
  withFixture({ 'valid-case': value }, validManifest(['valid-case']), (root) => {
    const message = findingsOf(root);
    assert.match(message, /attempts\[0\]: fault must be a non-empty string for kind=fault/);
    assert.match(message, /attempts\[1\]: body must be an object for kind=json/);
  });
});

test('real fault fixture declares two candidates and both literal auth orders', () => {
  const loaded = loadFixtures(realFixtureRoot);
  const fault = loaded.find((entry) => entry.value.case_id === 'provider-fault-stream-cut')?.value;
  assert.ok(fault);
  assert.deepEqual(fault.runtime_setup, {
    provider_id: 'mock-chat-a',
    model: 'mock.chat-model',
    wire_model: 'chat-model',
    candidate_ids: ['mock-chat-a/mock.chat-model', 'mock-chat-b/mock.chat-model'],
  });
  assert.deepEqual(fault.expected_provider.auth_orders, [
    ['Bearer fake-loopback-token-mock-chat-a', 'Bearer fake-loopback-token-mock-chat-b'],
    ['Bearer fake-loopback-token-mock-chat-b', 'Bearer fake-loopback-token-mock-chat-a'],
  ]);
  assert.equal(fault.assertions.provider_attempt_count, 2);
  assert.equal(fault.cell.mode, 'direct');
  assert.equal(fault.cell.transport, 'sse');
});

test('runtime_setup accepts single and multi-candidate typed declarations', () => {
  const single = baseCase({
    runtime_setup: {
      provider_id: 'mock-chat',
      model: 'mock.unavailable-model',
      wire_model: 'unavailable-model',
      candidate_ids: ['mock-chat/mock.unavailable-model'],
      all_candidates_fail: true,
    },
  });
  withFixture({ 'valid-case': single }, validManifest(['valid-case']), (root) => {
    assert.deepEqual(inspectCorpus(root).findings, []);
  });

  const multi = baseCase({
    runtime_setup: {
      provider_id: 'mock-chat-a',
      model: 'mock.chat-model',
      wire_model: 'chat-model',
      candidate_ids: ['mock-chat-a/mock.chat-model', 'mock-chat-b/mock.chat-model'],
    },
  });
  withFixture({ 'valid-case': multi }, validManifest(['valid-case']), (root) => {
    assert.deepEqual(inspectCorpus(root).findings, []);
  });
});

test('runtime_setup rejects unsupported or inconsistent typed declarations', () => {
  const value = baseCase({
    runtime_setup: {
      provider_id: 'mock-chat-a',
      model: 'mock.chat-model',
      wire_model: 'chat-model',
      candidate_ids: ['mock-chat-a/mock.chat-model', 'mock-chat-a/mock.chat-model'],
      unsupported: true,
    },
  });
  withFixture({ 'valid-case': value }, validManifest(['valid-case']), (root) => {
    const message = findingsOf(root);
    assert.match(message, /runtime_setup\.unsupported is not a supported field/);
    assert.match(message, /runtime_setup\.candidate_ids must be unique/);
  });
});

test('local namespace mock consumer requires the declared binding, exclusive effect and declared origin', () => {
  const declaredTool = {
    type: 'namespace',
    name: 'collaboration',
    tools: [{ type: 'function', name: 'spawn_agent', parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } }],
  };
  const valid = baseCase({
    client_request: { method: 'POST', path: '/v1/responses', headers: { 'content-type': 'application/json' }, body: { model: 'mock.chat-model', input: 'go', tools: [declaredTool] } },
    turns: [
      { turn_id: 'call' },
      { turn_id: 'followup', client_request: { method: 'POST', path: '/v1/responses', body: { input: [{ type: 'function_call_output', call_id: 'call_ns_1', output: 'local namespace mock recorded: do work' }] } } },
    ],
    tool_followup: { consumer: 'local-namespace-mock', side_effect: 'exclusive-local-file', binding: { namespace: 'collaboration', name: 'spawn_agent', type: 'function' }, input: { message: 'do work' }, expected_output: 'local namespace mock recorded: do work', assert_no_synthesized_tool_result: true, assert_declared_tool_binding_only: true, assert_tool_executed_once: true },
  });
  withFixture({ 'valid-case': valid }, validManifest(['valid-case']), (root) => {
    assert.deepEqual(inspectCorpus(root).findings, []);
  });

  const invalid = baseCase({
    turns: [
      { turn_id: 'call' },
      { turn_id: 'followup', client_request: { method: 'POST', path: '/v1/responses', body: { input: [] } } },
    ],
    tool_followup: { consumer: 'local-namespace-mock', side_effect: 'none', binding: { namespace: 'other', name: 'spawn_agent', type: 'function' }, assert_tool_executed_once: true },
  });
  withFixture({ 'valid-case': invalid }, validManifest(['valid-case']), (root) => {
    const message = findingsOf(root);
    assert.match(message, /tool_followup\.consumer local-namespace-mock requires binding \{namespace: collaboration/);
    assert.match(message, /tool_followup\.consumer local-namespace-mock requires side_effect exclusive-local-file/);
    assert.match(message, /tool_followup\.consumer local-namespace-mock requires the originating collaboration\.spawn_agent declaration/);
  });
});

test('echo-line-result consumer requires the declared echo tool and the exact structured paired response', () => {
  const response = { output: 'native-tool-result\n', exitCode: 0 };
  const base = {
    cell: { entry_protocol: 'gemini', provider_protocol: 'gemini', transport: 'json', mode: 'relay' },
    client_request: {
      method: 'POST',
      path: '/v1beta/models/mock.chat-model:generateContent',
      headers: { 'content-type': 'application/json' },
      body: {
        contents: [{ role: 'user', parts: [{ text: 'go' }] }],
        tools: [{ functionDeclarations: [{ name: 'echo', parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } }] }],
      },
    },
    turns: [
      { turn_id: 'call' },
      {
        turn_id: 'followup',
        client_request: {
          method: 'POST',
          path: '/v1beta/models/mock.chat-model:generateContent',
          body: { contents: [{ role: 'user', parts: [{ text: 'go' }] }, { parts: [{ functionResponse: { name: 'echo', response } }] }] },
        },
      },
    ],
    tool_followup: {
      consumer: 'echo-line-result',
      side_effect: 'none',
      input: { message: 'native-tool-result' },
      expected_output: response,
      assert_no_synthesized_tool_result: true,
      assert_declared_tool_binding_only: true,
      assert_tool_executed_once: true,
    },
  };
  withFixture({ 'valid-case': baseCase(base) }, validManifest(['valid-case']), (root) => {
    assert.deepEqual(inspectCorpus(root).findings, []);
  });

  const polluted = baseCase(structuredClone(base));
  polluted.turns[1].client_request.body.contents[1].parts[0].functionResponse.response = { output: 'native-tool-result\n', exitCode: 7 };
  withFixture({ 'valid-case': polluted }, validManifest(['valid-case']), (root) => {
    assert.match(findingsOf(root), /paired functionResponse\.response to equal expected_output/);
  });

  const invalid = baseCase(structuredClone(base));
  invalid.cell.entry_protocol = 'openai_chat';
  invalid.tool_followup.side_effect = 'exclusive-local-file';
  invalid.tool_followup.input = { text: 'wrong-key' };
  invalid.tool_followup.expected_output = { output: 'x', exitCode: 1 };
  withFixture({ 'valid-case': invalid }, validManifest(['valid-case']), (root) => {
    const message = findingsOf(root);
    assert.match(message, /tool_followup\.consumer echo-line-result requires side_effect none/);
    assert.match(message, /requires a string input\.message/);
    assert.match(message, /requires expected_output \{output: string, exitCode: 0\}/);
    assert.match(message, /requires the gemini entry protocol/);
  });
});

test('auth_orders requires exactly two ordered two-identity proofs', () => {
  const valid = baseCase({
    expected_provider: {
      ...baseCase().expected_provider,
      auth_orders: [
        ['Bearer fake-loopback-token-mock-chat-a', 'Bearer fake-loopback-token-mock-chat-b'],
        ['Bearer fake-loopback-token-mock-chat-b', 'Bearer fake-loopback-token-mock-chat-a'],
      ],
    },
  });
  withFixture({ 'valid-case': valid }, validManifest(['valid-case']), (root) => {
    assert.deepEqual(inspectCorpus(root).findings, []);
  });

  const invalid = baseCase({
    expected_provider: {
      ...baseCase().expected_provider,
      auth_orders: [
        ['Bearer duplicate', 'Bearer duplicate'],
        ['Bearer one', 'Bearer two', 'Bearer three'],
      ],
    },
  });
  withFixture({ 'valid-case': invalid }, validManifest(['valid-case']), (root) => {
    const message = findingsOf(root);
    assert.match(message, /auth_orders\[0\] must list two distinct identities/);
    assert.match(message, /auth_orders\[1\] must be exactly two non-empty auth strings/);
  });

  const extraIdentity = baseCase({
    expected_provider: {
      ...baseCase().expected_provider,
      auth_orders: [
        ['Bearer one', 'Bearer two'],
        ['Bearer three', 'Bearer four'],
      ],
    },
  });
  withFixture({ 'valid-case': extraIdentity }, validManifest(['valid-case']), (root) => {
    assert.match(findingsOf(root), /auth_orders must use exactly two identities across both orders/);
  });
});

test('invalid cell protocol, transport, mode, and direct mismatch are reported', () => {
  const value = baseCase({ cell: { entry_protocol: 'bogus', provider_protocol: 'openai_chat', transport: 'xml', mode: 'sideways' } });
  withFixture({ 'valid-case': value }, validManifest(['valid-case']), (root) => {
    const message = findingsOf(root);
    assert.match(message, /cell.entry_protocol invalid: bogus/);
    assert.match(message, /cell.transport invalid: xml/);
    assert.match(message, /cell.mode invalid: sideways/);
  });
  const mismatch = baseCase({ cell: { entry_protocol: 'openai_chat', provider_protocol: 'anthropic', transport: 'json', mode: 'direct' } });
  withFixture({ 'valid-case': mismatch }, validManifest(['valid-case']), (root) => {
    assert.match(findingsOf(root), /direct cell must target the same protocol/);
  });
});

test('missing expected upstream/client assertions are reported', () => {
  const value = baseCase();
  delete value.expected_provider.body_must;
  delete value.expected_client.semantic_terminal_required;
  withFixture({ 'valid-case': value }, validManifest(['valid-case']), (root) => {
    const message = findingsOf(root);
    assert.match(message, /expected_provider needs body_must or exact/);
    assert.match(message, /semantic_terminal_required must be boolean/);
  });
});

test('invalid turns and bad tool_followup references are reported', () => {
  const badTurns = baseCase({
    turns: [
      { turn_id: 'first', upstream_response: { protocol: 'openai_chat', mode: 'json', body: {} } },
      { turn_id: 'first', client_request: { method: 'POST', path: '/v1/chat/completions', body: {} } },
    ],
  });
  withFixture({ 'valid-case': badTurns }, validManifest(['valid-case']), (root) => {
    const message = findingsOf(root);
    assert.match(message, /turns\[0\].upstream_response must not redefine/);
    assert.match(message, /turn_id duplicate: first/);
  });
  const badFollowup = baseCase({
    turns: [
      { turn_id: 'tool-call', expected_client_must: { 'item.type': 'function_call' } },
      { turn_id: 'followup', client_request: { method: 'POST', path: '/v1/chat/completions', body: {} }, expected_client_must: { status: 'completed' } },
    ],
    tool_followup: { consumer: 'echo', side_effect: 'none', input: { text: 'missing-token' }, expected_output: 'absent-output', assert_no_synthesized_tool_result: true },
  });
  withFixture({ 'valid-case': badFollowup }, validManifest(['valid-case']), (root) => {
    const message = findingsOf(root);
    assert.match(message, /tool_followup.input.text not present in scripted history: missing-token/);
    assert.match(message, /tool_followup.expected_output not present in scripted history: absent-output/);
  });
});

test('valid multi-turn definitions are accepted', () => {
  const value = baseCase({
    turns: [
      { turn_id: 'first', expected_client_must: { 'item.type': 'function_call' } },
      { turn_id: 'followup', client_request: { method: 'POST', path: '/v1/chat/completions', body: { model: 'mock.chat-model', messages: [] } }, expected_provider_exact: { model: 'chat-model', messages: [] }, expected_client_must: { status: 'completed' }, upstream_response: { protocol: 'openai_chat', mode: 'json', status: 200, content_type: 'application/json', body: { choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] } } },
    ],
    tool_followup: { consumer: 'echo', side_effect: 'none', input: { text: 'ping' }, expected_output: 'ping', assert_tool_executed_once: true },
  });
  value.client_request.body.messages = [{ role: 'user', content: 'ping' }];
  withFixture({ 'valid-case': value }, validManifest(['valid-case']), (root) => {
    assert.deepEqual(inspectCorpus(root).findings, []);
  });
});

test('static namespace history cannot claim actual execution by the echo consumer', () => {
  const value = baseCase({
    turns: [{ turn_id: 'first' }, { turn_id: 'followup', client_request: { method: 'POST', path: '/v1/responses', body: { input: [] } } }],
    tool_followup: { consumer: 'namespace declaration only', assert_tool_executed_once: true },
  });
  withFixture({ 'valid-case': value }, validManifest(['valid-case']), (root) => {
    assert.match(findingsOf(root), /assert_tool_executed_once requires an executing consumer/);
  });
});

test('arguments and media bytes survive the loader unchanged', () => {
  const cases = {
    'namespace-custom-complete-args': baseCase({
      case_id: 'namespace-custom-complete-args',
      client_request: { method: 'POST', path: '/v1/responses', body: { input: 'go', tools: [] } },
      turns: [
        { turn_id: 'call' },
        { turn_id: 'followup', client_request: { method: 'POST', path: '/v1/responses', body: { input: [{ type: 'function_call_output', call_id: 'call_ns_1', output: 'agent started' }] } }, expected_provider_exact: { model: 'chat-model', messages: [{ role: 'assistant', tool_calls: [{ id: 'call_ns_1', type: 'function', function: { name: 'collaboration__spawn_agent', arguments: '{"message":"do work"}' } }] }] } },
      ],
      tool_followup: { consumer: 'none', side_effect: 'none', assert_declared_tool_binding_only: true },
    }),
    'media-gemini-function-response-image': baseCase({
      case_id: 'media-gemini-function-response-image',
      cell: { entry_protocol: 'gemini', provider_protocol: 'openai_chat', transport: 'sse', mode: 'relay' },
      client_request: { method: 'POST', path: '/v1beta/models/mock.chat-model:generateContent', body: { contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: '/9j/4AAQSkZJRgABAQAAAQABAAD' } }] }] } },
    }),
  };
  const root = writeFixture(cases, validManifest(Object.keys(cases)));
  try {
    const loaded = loadFixtures(root);
    const byId = new Map(loaded.map((entry) => [entry.value.case_id, entry.value]));
    const args = byId.get('namespace-custom-complete-args').turns[1].expected_provider_exact.messages[0].tool_calls[0].function.arguments;
    assert.equal(args, '{"message":"do work"}');
    const media = byId.get('media-gemini-function-response-image').client_request.body.contents[0].parts[0].inlineData.data;
    assert.equal(media, '/9j/4AAQSkZJRgABAQAAAQABAAD');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('coverage tracks the 16 base cells and 32 variants', () => {
  const loaded = loadFixtures(realFixtureRoot);
  const coverage = corpusCoverage(loaded);
  assert.equal(coverage.base_cells, 16);
  assert.equal(coverage.base_cells_covered, 16);
  assert.equal(coverage.base_variants, 32);
  assert.equal(coverage.base_variants_covered, 32);
  assert.equal(coverage.variants.length, 16);
  assert.ok(coverage.variants.every((cell) => cell.covered));
});

test('non-base extension ids are reported, not rejected', () => {
  const value = baseCase({ case_id: 'extra-variant' });
  withFixture({ 'extra-variant': value }, validManifest(['extra-variant']), (root) => {
    const report = inspectCorpus(root);
    assert.deepEqual(report.findings, []);
    assert.deepEqual(report.extensions, ['extra-variant']);
  });
});

test('stale source references are reported rather than fabricated', () => {
  const value = baseCase();
  value.source = {
    sha: SOURCE_SHA,
    files: ['wire_test.go', 'internal/gateway/does_not_exist_test.go'],
    tests: [
      'wire_test.go::TestPresentSourceFunctionPinned',
      'internal/gateway/does_not_exist_test.go::TestNope',
      'internal/gateway/wire_test.go::TestAbsentSourceFunctionPinned',
    ],
  };
  const sourceRoot = mkdtempSync(join(tmpdir(), 'corpus-source-refs-'));
  try {
    mkdirSync(join(sourceRoot, 'internal', 'gateway'), { recursive: true });
    writeFileSync(join(sourceRoot, 'wire_test.go'), 'package gateway\n\nfunc TestPresentSourceFunctionPinned() {}\n');
    writeFileSync(join(sourceRoot, 'internal', 'gateway', 'wire_test.go'), 'package gateway\n\nfunc TestExistingWireCase() {}\n');
    withFixture({ 'valid-case': value }, validManifest(['valid-case']), (root) => {
      const report = inspectCorpus(root, { magpieRoot: sourceRoot });
      assert.equal(report.ok, true, report.findings.join('\n'));
      assert.equal(report.source_refs.checked, true);
      assert.deepEqual(report.source_refs.stale_files, [
        'source file missing: cases/valid-case.json -> internal/gateway/does_not_exist_test.go',
      ]);
      assert.deepEqual(report.source_refs.stale_tests, [
        'source test file missing: cases/valid-case.json -> internal/gateway/does_not_exist_test.go',
        'source test name missing: cases/valid-case.json -> internal/gateway/wire_test.go::TestAbsentSourceFunctionPinned',
      ]);
      assert.ok(!report.source_refs.stale_tests.some((ref) => /TestPresentSourceFunctionPinned/.test(ref)));
    });
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
  }
});
