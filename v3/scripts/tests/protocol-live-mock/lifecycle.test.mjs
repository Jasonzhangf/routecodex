import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { generateRccConfig } from './lifecycle.mjs';
import { distinctFreePorts } from './lifecycle-test-support.mjs';

test('generateRccConfig writes isolated V3 config with task-owned provider references', async () => {
  const workRoot = mkdtempSync(join(tmpdir(), 'lifecycle-config-test-'));
  const [mockPort, rccPort] = await distinctFreePorts();
  const first = await generateRccConfig({ mockPort, rccPort, providerProtocol: 'openai_chat', workRoot });
  const second = await generateRccConfig({ mockPort, rccPort, providerProtocol: 'openai_chat', workRoot });
  let exhaustion = null;
  try {
    exhaustion = await generateRccConfig({
      mockPort,
      rccPort,
      providerProtocol: 'openai_chat',
      workRoot,
      runtimeSetup: {
        provider_id: 'mock-openai_chat',
        model: 'mock.unavailable-model',
        direct_pin: false,
        candidate_ids: ['mock-openai_chat/mock.unavailable-model'],
        all_candidates_fail: true,
      },
    });
    assert.notEqual(first.root, second.root);
    assert.notEqual(first.path, second.path);
    assert.equal(first.server_id, 'loopback');
    assert.equal(first.provider_protocol, 'openai_chat');
    assert.match(first.text, /^version = 3$/m);
    assert.match(first.text, new RegExp(`port = ${rccPort}`));
    assert.match(first.text, /bind = "127\.0\.0\.1"/);
    assert.match(first.text, /use = "mock-openai_chat\/mock\.chat-model"/);
    assert.notEqual(first.admin_port, 8777);
    assert.equal(first.env.ROUTECODEX_V3_ADMIN_BIND, first.admin_bind);
    assert.deepEqual(
      first.listeners.map((listener) => listener.role),
      ['primary', 'admin_webui'],
    );
    assert.equal(first.listeners[0].port, rccPort);
    assert.equal(first.listeners[1].port, first.admin_port);

    const providerText = readFileSync(first.provider_path, 'utf8');
    assert.match(providerText, /version = "2\.0\.0"/);
    assert.match(providerText, new RegExp(`baseURL = "http://127\\.0\\.0\\.1:${mockPort}/v1"`));
    assert.match(providerText, /defaultModel = "chat-model"/);
    assert.match(providerText, /\[provider\.models\."mock\.chat-model"\]/);
    assert.match(providerText, /wireName = "chat-model"/);
    assert.match(providerText, /apiKey = "fake-loopback-token"/);
    assert.doesNotMatch(providerText, /https?:\/\/(?!127\.0\.0\.1)/);
    assert.equal((providerText.match(/fake-loopback-token/g) ?? []).length, 1);
  } finally {
    first.cleanup();
    second.cleanup();
    exhaustion?.cleanup();
    rmSync(workRoot, { recursive: true, force: true });
  }
});

test('generateRccConfig authors the runtime candidate as a real provider model', async () => {
  const setup = {
    provider_id: 'mock-openai_chat',
    model: 'mock.unavailable-model',
    direct_pin: false,
    candidate_ids: ['mock-openai_chat/mock.unavailable-model'],
    all_candidates_fail: true,
  };
  const generated = await generateRccConfig({
    mockPort: 12345,
    rccPort: 12346,
    providerProtocol: 'openai_chat',
    workRoot: '/tmp/lifecycle-setup-inspect',
    runtimeSetup: setup,
  });
  try {
    assert.deepEqual(generated.runtime_setup, setup);
    assert.deepEqual(generated.candidate_ids, ['mock-openai_chat/mock.unavailable-model']);
    assert.match(generated.text, /use = "mock-openai_chat\/mock\.unavailable-model"/);
    assert.match(generated.provider_text, /\[provider\.models\."mock\.unavailable-model"\]/);
    assert.match(generated.provider_text, /wireName = "chat-model"/);
  } finally {
    generated.cleanup();
  }
});

test('generateRccConfig writes a supported execution policy and receipts the written mode', async () => {
  for (const mode of ['direct', 'relay']) {
    const generated = await generateRccConfig({
      mockPort: 12345, rccPort: 12346, providerProtocol: 'openai_chat', mode,
      workRoot: tmpdir(),
    });
    try {
      const actual = readFileSync(generated.path, 'utf8');
      assert.match(actual, /\[servers\.loopback\.execution\]/);
      assert.match(actual, new RegExp(`allowed_modes = \\["${mode}"\\]`));
      assert.equal(generated.mode, mode);
      assert.equal(generated.mode_receipt.field, 'servers.loopback.execution.allowed_modes');
      assert.deepEqual(generated.mode_receipt.allowed_modes, [mode]);
    } finally {
      generated.cleanup();
    }
  }
});

test('generateRccConfig overrides an inherited 8777 admin bind with a task-owned port', async () => {
  const previous = process.env.ROUTECODEX_V3_ADMIN_BIND;
  process.env.ROUTECODEX_V3_ADMIN_BIND = '127.0.0.1:8777';
  const workRoot = mkdtempSync(join(tmpdir(), 'lifecycle-admin-inherit-test-'));
  const [mockPort, rccPort] = await distinctFreePorts();
  let generated = null;
  try {
    generated = await generateRccConfig({ mockPort, rccPort, providerProtocol: 'openai_chat', workRoot });
    assert.equal(generated.inherited_admin_bind, '127.0.0.1:8777');
    assert.notEqual(generated.admin_bind, '127.0.0.1:8777');
    assert.notEqual(generated.admin_port, 8777);
    assert.equal(generated.env.ROUTECODEX_V3_ADMIN_BIND, generated.admin_bind);
    assert.notEqual(generated.admin_port, rccPort);
    assert.notEqual(generated.admin_port, mockPort);
    assert.equal(
      generated.listeners.find((listener) => listener.role === 'admin_webui').port,
      generated.admin_port,
    );
  } finally {
    generated?.cleanup();
    rmSync(workRoot, { recursive: true, force: true });
    if (previous === undefined) delete process.env.ROUTECODEX_V3_ADMIN_BIND;
    else process.env.ROUTECODEX_V3_ADMIN_BIND = previous;
  }
});

test('generateRccConfig authors two same-tier providers with distinct fake identities', async () => {
  const workRoot = mkdtempSync(join(tmpdir(), 'lifecycle-multi-provider-test-'));
  const [mockPort, rccPort] = await distinctFreePorts();
  const runtimeSetup = {
    provider_id: 'mock-chat-a',
    model: 'mock.chat-model',
    wire_model: 'chat-model',
    candidate_ids: ['mock-chat-a/mock.chat-model', 'mock-chat-b/mock.chat-model'],
  };
  const generated = await generateRccConfig({
    mockPort,
    rccPort,
    providerProtocol: 'openai_chat',
    workRoot,
    runtimeSetup,
  });
  try {
    // Red control: the old generator rejected any setup with more than one
    // candidate. A multi-candidate setup must now author both providers.
    assert.deepEqual(
      generated.candidate_ids,
      ['mock-chat-a/mock.chat-model', 'mock-chat-b/mock.chat-model'],
    );
    assert.equal(generated.provider_files.length, 2);
    assert.deepEqual(
      generated.provider_files.map((file) => file.provider_id),
      ['mock-chat-a', 'mock-chat-b'],
    );
    for (const file of generated.provider_files) {
      assert.equal(file.model, 'mock.chat-model');
      assert.equal(file.wire_model, 'chat-model');
      assert.equal(readFileSync(file.path, 'utf8'), file.text);
      assert.match(file.text, /\[provider\.models\."mock\.chat-model"\]/);
      assert.match(file.text, /wireName = "chat-model"/);
      assert.match(file.text, new RegExp(`baseURL = "http://127\\.0\\.0\\.1:${mockPort}/v1"`));
      assert.doesNotMatch(file.text, /https?:\/\/(?!127\.0\.0\.1)/);
    }
    const [a, b] = generated.provider_files;
    assert.match(a.text, /apiKey = "fake-loopback-token-mock-chat-a"/);
    assert.match(b.text, /apiKey = "fake-loopback-token-mock-chat-b"/);
    // Red control: two candidates must not share one token.
    assert.notEqual(
      a.text.match(/apiKey = "([^"]+)"/)[1],
      b.text.match(/apiKey = "([^"]+)"/)[1],
    );
    // Red control: both candidates stay in one default pool tier.
    assert.match(
      generated.text,
      /tiers = \[\[\n {2}\{ use = "mock-chat-a\/mock\.chat-model" \},\n {2}\{ use = "mock-chat-b\/mock\.chat-model" \}\n\]\]/,
    );
    assert.equal((generated.text.match(/\{ use = /g) ?? []).length, 2);
    // Candidate identity receipt names both declared identities independently.
    assert.equal(generated.candidate_identity_receipts.validated, true);
    assert.equal(generated.candidate_identity_receipts.protocol, 'openai_chat');
    assert.equal(generated.candidate_identity_receipts.wire_model, 'chat-model');
    assert.equal(generated.candidate_identity_receipts.tier_count, 1);
    assert.deepEqual(
      generated.candidate_identity_receipts.candidates.map((candidate) => candidate.authorization),
      ['Bearer fake-loopback-token-mock-chat-a', 'Bearer fake-loopback-token-mock-chat-b'],
    );
    // Legacy single-caller keys still point at the primary authored provider.
    assert.equal(generated.provider_path, a.path);
    assert.equal(generated.provider_text, a.text);
    assert.equal(generated.provider_dir, a.path.replace(/\/config\.v2\.toml$/, ''));
    assert.equal(generated.provider_id, 'mock-chat-a');
  } finally {
    generated.cleanup();
    rmSync(workRoot, { recursive: true, force: true });
  }
});

test('generateRccConfig rejects a multi-candidate model that leaves the declared model', async () => {
  await assert.rejects(
    generateRccConfig({
      mockPort: 12345,
      rccPort: 12346,
      providerProtocol: 'openai_chat',
      workRoot: tmpdir(),
      runtimeSetup: {
        provider_id: 'mock-chat-a',
        model: 'mock.chat-model',
        wire_model: 'chat-model',
        candidate_ids: ['mock-chat-a/mock.chat-model', 'mock-chat-b/mock.other-model'],
      },
    }),
    /must match declared model/,
  );
});

test('generateRccConfig rejects the same provider twice instead of collapsing to one', async () => {
  await assert.rejects(
    generateRccConfig({
      mockPort: 12345,
      rccPort: 12346,
      providerProtocol: 'openai_chat',
      workRoot: tmpdir(),
      runtimeSetup: {
        provider_id: 'mock-chat-a',
        model: 'mock.chat-model',
        wire_model: 'chat-model',
        candidate_ids: ['mock-chat-a/mock.chat-model', 'mock-chat-a/mock.chat-model'],
      },
    }),
    /duplicate provider/,
  );
});

test('generateRccConfig keeps the exhaustion model key distinct from its wire name', async () => {
  const workRoot = mkdtempSync(join(tmpdir(), 'lifecycle-exhaustion-model-test-'));
  const generated = await generateRccConfig({
    mockPort: 12345,
    rccPort: 12346,
    providerProtocol: 'openai_chat',
    workRoot,
    runtimeSetup: {
      provider_id: 'mock-openai_chat',
      model: 'mock.unavailable-model',
      wire_model: 'unavailable-model',
      candidate_ids: ['mock-openai_chat/mock.unavailable-model'],
      all_candidates_fail: true,
    },
  });
  try {
    // Red control: the model key is not the wire name.
    assert.equal(generated.model, 'mock.unavailable-model');
    assert.equal(generated.wire_model, 'unavailable-model');
    assert.match(generated.provider_text, /\[provider\.models\."mock\.unavailable-model"\]/);
    assert.doesNotMatch(generated.provider_text, /\[provider\.models\."unavailable-model"\]/);
    assert.match(generated.provider_text, /wireName = "unavailable-model"/);
    assert.match(generated.provider_text, /apiKey = "fake-loopback-token"/);
    assert.match(generated.text, /use = "mock-openai_chat\/mock\.unavailable-model"/);
    assert.equal(generated.provider_files.length, 1);
  } finally {
    generated.cleanup();
    rmSync(workRoot, { recursive: true, force: true });
  }
});
