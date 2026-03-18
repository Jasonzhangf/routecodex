#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const nativeNodePath = path.join(repoRoot, 'dist', 'native', 'router_hotpath_napi.node');

function moduleUrl(relPath) {
  return pathToFileURL(path.join(repoRoot, 'dist', relPath)).href;
}

function cacheBustedImport(url, tag) {
  return import(`${url}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

function makeNativeMockSource(overrides) {
  return [
    `const real = require(${JSON.stringify(nativeNodePath)});`,
    'module.exports = {',
    '  ...real,',
    ...overrides.map((line) => `  ${line}`),
    '};'
  ].join('\n');
}

async function withTempNativeModule(source, run) {
  const prev = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-snapshot-hooks-'));
  const file = path.join(dir, 'mock-native.cjs');
  await fs.writeFile(file, source, 'utf8');
  try {
    process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH = file;
    await run(file);
  } finally {
    if (prev === undefined) {
      delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
    } else {
      process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH = prev;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function loadModules(tag) {
  const [nativeHooks, snapshotUtils, snapshotRecorder] = await Promise.all([
    cacheBustedImport(
      moduleUrl('router/virtual-router/engine-selection/native-snapshot-hooks.js'),
      `native-snapshot-hooks-${tag}`
    ),
    cacheBustedImport(moduleUrl('conversion/snapshot-utils.js'), `snapshot-utils-${tag}`),
    cacheBustedImport(moduleUrl('conversion/hub/snapshot-recorder.js'), `snapshot-recorder-${tag}`)
  ]);
  return { nativeHooks, snapshotUtils, snapshotRecorder };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

async function main() {
  // Scenario A: full success path + recorder/writer orchestration branches.
  await withTempNativeModule(
    makeNativeMockSource([
      `shouldRecordSnapshotsJson() { return JSON.stringify(true); },`,
      `writeSnapshotViaHooksJson(inputJson) {
        globalThis.__snapshot_calls = globalThis.__snapshot_calls || [];
        globalThis.__snapshot_calls.push(JSON.parse(inputJson));
        return JSON.stringify({ ok: true });
      },`,
      `normalizeSnapshotStagePayloadJson(stage, payloadJson) {
        const payload = JSON.parse(payloadJson);
        if (stage === "drop-stage") return JSON.stringify(false);
        if (stage === "annotated") return JSON.stringify({ stage, payload, normalized: true });
        return JSON.stringify(payload);
      },`,
      `noopSnapshotProbe() { return JSON.stringify({ ok: true }); }`
    ]),
    async () => {
      globalThis.__snapshot_calls = [];
      const { nativeHooks, snapshotUtils, snapshotRecorder } = await loadModules('a');
      const { SnapshotStageRecorder, createSnapshotRecorder } = snapshotRecorder;

      assert.equal(nativeHooks.shouldRecordSnapshotsWithNative(), true);
      assert.equal(snapshotUtils.shouldRecordSnapshots(), true);

      await snapshotUtils.writeSnapshotViaHooks({
        endpoint: '/v1/chat/completions',
        stage: 'direct-write',
        requestId: 'req-direct',
        data: { ok: true },
        channel: 'compat',
        providerKey: 'provider-1',
        groupRequestId: 'group-1'
      });

      const writer = snapshotUtils.createSnapshotWriter({
        requestId: 'req-writer',
        endpoint: '/v1/messages',
        providerKey: 'provider-2',
        groupRequestId: 'group-2'
      });
      assert.equal(typeof writer, 'function');
      writer('writer-stage', { nested: { value: 1 } });
      await flushMicrotasks();

      await snapshotUtils.recordSnapshot({
        stage: 'record-stage',
        requestId: 'req-record',
        data: { hello: 'world' }
      });

      const recorderWithClientRequest = new SnapshotStageRecorder({
        context: { requestId: 'req-rec-1', providerId: 'provider-a', clientRequestId: 'client-001' },
        endpoint: '/v1/chat/completions'
      });
      recorderWithClientRequest.record('annotated', { alpha: 1 });

      const recorderWithGroupRequest = new SnapshotStageRecorder({
        context: { requestId: 'req-rec-2', providerId: 'provider-b', groupRequestId: 'group-raw-002' },
        endpoint: '/v1/responses'
      });
      recorderWithGroupRequest.record('annotated', { beta: 2 });
      recorderWithGroupRequest.record('drop-stage', { ignored: true });

      // Force "writer throws" catch branch.
      recorderWithGroupRequest.writer = () => {
        throw new Error('writer failed');
      };
      recorderWithGroupRequest.record('annotated', { shouldBeIgnored: true });

      const recorderWithoutStringProvider = new SnapshotStageRecorder({
        context: { requestId: 'req-rec-3', providerId: 12345 },
        endpoint: '/v1/chat/completions'
      });
      recorderWithoutStringProvider.record('annotated', { gamma: 3 });

      const recorderApi = createSnapshotRecorder(
        { requestId: 'req-rec-api', providerId: 'provider-c' },
        '/v1/chat/completions'
      );
      assert.equal(typeof recorderApi.record, 'function');

      const calls = globalThis.__snapshot_calls;
      assert.ok(Array.isArray(calls));
      assert.ok(calls.length >= 5);
      const hasClientGroup = calls.some((row) => row?.groupRequestId === 'client-001');
      const hasRawGroup = calls.some((row) => row?.groupRequestId === 'group-raw-002');
      assert.equal(hasClientGroup, true);
      assert.equal(hasRawGroup, true);
    }
  );

  // Scenario B: shouldRecordSnapshots=false gates writer/recorder.
  await withTempNativeModule(
    makeNativeMockSource([
      `shouldRecordSnapshotsJson() { return JSON.stringify(false); },`,
      `writeSnapshotViaHooksJson() { throw new Error("should-not-write"); },`,
      `normalizeSnapshotStagePayloadJson(_stage, payloadJson) { return payloadJson; }`
    ]),
    async () => {
      const { snapshotUtils, snapshotRecorder } = await loadModules('b');
      const writer = snapshotUtils.createSnapshotWriter({ requestId: 'req-off' });
      assert.equal(writer, undefined);
      await snapshotUtils.recordSnapshot({
        stage: 'off-stage',
        requestId: 'req-off',
        data: { off: true }
      });
      const rec = new snapshotRecorder.SnapshotStageRecorder({
        context: { requestId: 'req-off-rec', providerId: 'provider-off' },
        endpoint: '/v1/chat/completions'
      });
      rec.record('annotated', { off: true });
    }
  );

  // Scenario C: invalid/empty bool payload branch.
  await withTempNativeModule(
    makeNativeMockSource([
      `shouldRecordSnapshotsJson() { return JSON.stringify("not-bool"); },`,
      `writeSnapshotViaHooksJson() { return JSON.stringify({ ok: true }); },`,
      `normalizeSnapshotStagePayloadJson(_stage, payloadJson) { return payloadJson; }`
    ]),
    async () => {
      const { nativeHooks } = await loadModules('c1');
      assert.throws(() => nativeHooks.shouldRecordSnapshotsWithNative(), /invalid payload/);
    }
  );
  await withTempNativeModule(
    makeNativeMockSource([
      `shouldRecordSnapshotsJson() { return ""; },`,
      `writeSnapshotViaHooksJson() { return JSON.stringify({ ok: true }); },`,
      `normalizeSnapshotStagePayloadJson(_stage, payloadJson) { return payloadJson; }`
    ]),
    async () => {
      const { nativeHooks } = await loadModules('c2');
      assert.throws(() => nativeHooks.shouldRecordSnapshotsWithNative(), /empty result/);
    }
  );

  // Scenario D: write hooks branches (fn throw + stringify fail).
  await withTempNativeModule(
    makeNativeMockSource([
      `shouldRecordSnapshotsJson() { return JSON.stringify(true); },`,
      `writeSnapshotViaHooksJson() { throw new Error("write-native-failed"); },`,
      `normalizeSnapshotStagePayloadJson(_stage, payloadJson) { return payloadJson; }`
    ]),
    async () => {
      const { nativeHooks } = await loadModules('d1');
      assert.throws(
        () => nativeHooks.writeSnapshotViaHooksWithNative({ requestId: 'req-write-fail' }),
        /write-native-failed/
      );
      const circular = {};
      circular.self = circular;
      assert.throws(() => nativeHooks.writeSnapshotViaHooksWithNative(circular), /json stringify failed/);
    }
  );

  // Scenario D2: recordSnapshot catches hook failures.
  await withTempNativeModule(
    makeNativeMockSource([
      `shouldRecordSnapshotsJson() { return JSON.stringify(true); },`,
      `writeSnapshotViaHooksJson() { throw new Error("write-native-failed-for-record-snapshot"); },`,
      `normalizeSnapshotStagePayloadJson(_stage, payloadJson) { return payloadJson; }`
    ]),
    async () => {
      const { snapshotUtils } = await loadModules('d2');
      await snapshotUtils.recordSnapshot({
        stage: 'record-failed-but-swallowed',
        requestId: 'req-record-fail',
        data: { ok: false }
      });
      await flushMicrotasks();
    }
  );

  // Scenario E: normalize payload branches.
  await withTempNativeModule(
    makeNativeMockSource([
      `shouldRecordSnapshotsJson() { return JSON.stringify(true); },`,
      `writeSnapshotViaHooksJson() { return JSON.stringify({ ok: true }); },`,
      `normalizeSnapshotStagePayloadJson(stage, payloadJson) {
        if (stage === "invalid") return "not-json";
        if (stage === "empty") return "";
        if (stage === "throw") throw new Error("normalize-failed");
        const payload = JSON.parse(payloadJson);
        return JSON.stringify({ wrapped: payload, stage });
      }`
    ]),
    async () => {
      const { nativeHooks } = await loadModules('e');
      assert.equal(nativeHooks.normalizeSnapshotStagePayloadWithNative('any', null), null);
      assert.equal(nativeHooks.normalizeSnapshotStagePayloadWithNative('any', undefined), null);

      const circular = {};
      circular.self = circular;
      const fallbackPayload = nativeHooks.normalizeSnapshotStagePayloadWithNative('circular', circular);
      assert.equal(fallbackPayload, circular);

      const ok = nativeHooks.normalizeSnapshotStagePayloadWithNative('ok', { k: 1 });
      assert.deepEqual(ok, { wrapped: { k: 1 }, stage: 'ok' });
      const nonStringStage = nativeHooks.normalizeSnapshotStagePayloadWithNative(123, { k: 2 });
      assert.deepEqual(nonStringStage, { wrapped: { k: 2 }, stage: '' });
      assert.throws(() => nativeHooks.normalizeSnapshotStagePayloadWithNative('invalid', { k: 1 }), /invalid payload/);
      assert.throws(() => nativeHooks.normalizeSnapshotStagePayloadWithNative('empty', { k: 1 }), /empty result/);
      assert.throws(() => nativeHooks.normalizeSnapshotStagePayloadWithNative('throw', { k: 1 }), /normalize-failed/);
    }
  );

  // Scenario F: missing native functions + non-string results.
  await withTempNativeModule(
    `module.exports = { shouldRecordSnapshotsJson() { return 123; } };`,
    async () => {
      const { nativeHooks } = await loadModules('f');
      assert.throws(() => nativeHooks.shouldRecordSnapshotsWithNative(), /empty result/);
      assert.throws(() => nativeHooks.writeSnapshotViaHooksWithNative({ x: 1 }), /writeSnapshotViaHooksJson/);
      assert.throws(() => nativeHooks.normalizeSnapshotStagePayloadWithNative('x', { y: 1 }), /normalizeSnapshotStagePayloadJson/);
    }
  );

  console.log('✅ coverage-hub-snapshot-hooks-utils-recorder passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-snapshot-hooks-utils-recorder failed:', error);
  process.exit(1);
});
