#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const codecModuleUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'router', 'virtual-router', 'routing-stop-message-state-codec.js')
).href;
const nativeSemanticsModuleUrl = pathToFileURL(
  path.join(
    repoRoot,
    'dist',
    'router',
    'virtual-router',
    'engine-selection',
    'native-virtual-router-stop-message-state-semantics.js'
  )
).href;
const loaderSourcePath = path.join(
  repoRoot,
  'src',
  'router',
  'virtual-router',
  'engine-selection',
  'native-router-hotpath-loader.ts'
);

function setEnvVar(key, value) {
  if (value === undefined || value === null || value === '') {
    delete process.env[key];
    return;
  }
  process.env[key] = String(value);
}

function cacheBustedImport(url, tag) {
  return import(`${url}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

async function importCodec(tag) {
  return cacheBustedImport(codecModuleUrl, tag);
}

async function importNativeSemantics(tag) {
  return cacheBustedImport(nativeSemanticsModuleUrl, tag);
}

async function withTempNativeModule(content, run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-stopmessage-state-native-'));
  const file = path.join(dir, 'mock-native.cjs');
  await fs.writeFile(file, content, 'utf8');
  try {
    await run(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function readRequiredNativeExports() {
  const source = await fs.readFile(loaderSourcePath, 'utf8');
  const block = source.match(/const REQUIRED_NATIVE_EXPORTS = \[(.*?)\] as const;/s);
  assert.ok(block && block[1], 'REQUIRED_NATIVE_EXPORTS block not found');
  const names = [...block[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => String(m[1]));
  assert.ok(names.length > 0, 'no required native exports parsed');
  return names;
}

function buildMockNativeModuleContent(requiredNames, overrides = {}) {
  const lines = ['module.exports = {'];
  for (const name of requiredNames) {
    const impl = typeof overrides[name] === 'string' ? overrides[name] : 'function () { return "null"; }';
    lines.push(`  '${name}': ${impl},`);
  }
  lines.push('};');
  return lines.join('\n');
}

function resolveNativeCandidatePaths() {
  return [
    path.join(repoRoot, 'rust-core', 'target', 'release', 'router_hotpath_napi.node'),
    path.join(repoRoot, 'rust-core', 'target', 'debug', 'router_hotpath_napi.node'),
    path.join(repoRoot, 'dist', 'native', 'router_hotpath_napi.node')
  ];
}

async function withNativeCandidatesHidden(run) {
  const renames = [];
  try {
    for (const original of resolveNativeCandidatePaths()) {
      try {
        await fs.access(original);
      } catch {
        continue;
      }
      const backup = `${original}.bak-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      await fs.rename(original, backup);
      renames.push({ original, backup });
    }
    await run();
  } finally {
    for (const entry of renames.reverse()) {
      await fs.rename(entry.backup, entry.original).catch(() => undefined);
    }
  }
}

function createBaseState() {
  return {
    stopMessageSource: '  source-a  ',
    stopMessageText: ' 继续执行 ',
    stopMessageMaxRepeats: 7.8,
    stopMessageUsed: 2.4,
    stopMessageUpdatedAt: 1000.7,
    stopMessageLastUsedAt: 999.9,
    stopMessageStageMode: ' ON ',
    stopMessageAiMode: ' Off ',
    stopMessageAiSeedPrompt: '  seed prompt  ',
    stopMessageAiHistory: [
      null,
      1,
      {
        ts: 11.9,
        round: 3.6,
        assistantText: '  a  ',
        responseExcerpt: '  e  ',
        invalid: 'x'
      },
      {
        ts: Number.NaN,
        round: -2,
        followupText: '  b  '
      }
    ]
  };
}

function createHistoryOverflow() {
  return Array.from({ length: 10 }, (_, i) => ({
    ts: i + 0.7,
    round: i,
    assistantText: `h-${i}`
  }));
}

async function runCodecCoverage() {
  const mod = await importCodec('codec');
  const {
    DEFAULT_STOP_MESSAGE_MAX_REPEATS,
    serializeStopMessageState,
    deserializeStopMessageState,
    normalizeStopMessageStageMode,
    normalizeStopMessageAiMode,
    ensureStopMessageModeMaxRepeats
  } = mod;

  assert.equal(DEFAULT_STOP_MESSAGE_MAX_REPEATS, 10);

  const serialized = serializeStopMessageState({
    ...createBaseState(),
    stopMessageAiHistory: createHistoryOverflow()
  });

  assert.equal(serialized.stopMessageSource, 'source-a');
  assert.equal(serialized.stopMessageText, ' 继续执行 ');
  assert.equal(serialized.stopMessageMaxRepeats, 7);
  assert.equal(serialized.stopMessageUsed, 2);
  assert.equal(serialized.stopMessageUpdatedAt, 1000);
  assert.equal(serialized.stopMessageLastUsedAt, 999);
  assert.equal(serialized.stopMessageStageMode, 'on');
  assert.equal(serialized.stopMessageAiMode, 'off');
  assert.equal(serialized.stopMessageAiSeedPrompt, 'seed prompt');
  assert.equal(Array.isArray(serialized.stopMessageAiHistory), true);
  assert.equal(serialized.stopMessageAiHistory.length, 8);

  const serializedWithMixedHistory = serializeStopMessageState(createBaseState());
  assert.equal(Array.isArray(serializedWithMixedHistory.stopMessageAiHistory), true);
  assert.equal(serializedWithMixedHistory.stopMessageAiHistory.length, 2);

  const stateWithPersistedRepeats = {
    stopMessageStageMode: 'off',
    stopMessageMaxRepeats: 99,
    stopMessageUsed: 0
  };
  deserializeStopMessageState(
    {
      stopMessageSource: '  s2  ',
      stopMessageText: '  t2  ',
      stopMessageMaxRepeats: 3.9,
      stopMessageUsed: -8.9,
      stopMessageUpdatedAt: 77.7,
      stopMessageLastUsedAt: 88.8,
      stopMessageStageMode: ' Auto ',
      stopMessageAiMode: ' ON ',
      stopMessageAiSeedPrompt: '  seed2  ',
      stopMessageAiHistory: createHistoryOverflow()
    },
    stateWithPersistedRepeats
  );
  assert.equal(stateWithPersistedRepeats.stopMessageSource, 's2');
  assert.equal(stateWithPersistedRepeats.stopMessageText, '  t2  ');
  assert.equal(stateWithPersistedRepeats.stopMessageMaxRepeats, 3);
  assert.equal(stateWithPersistedRepeats.stopMessageUsed, 0);
  assert.equal(stateWithPersistedRepeats.stopMessageUpdatedAt, 77);
  assert.equal(stateWithPersistedRepeats.stopMessageLastUsedAt, 88);
  assert.equal(stateWithPersistedRepeats.stopMessageStageMode, 'auto');
  assert.equal(stateWithPersistedRepeats.stopMessageAiMode, 'on');
  assert.equal(stateWithPersistedRepeats.stopMessageAiSeedPrompt, 'seed2');
  assert.equal(stateWithPersistedRepeats.stopMessageAiHistory.length, 8);

  const stateWithInvalidHistory = { stopMessageStageMode: 'off' };
  deserializeStopMessageState(
    {
      stopMessageAiHistory: 'invalid-history',
      stopMessageStageMode: 'off'
    },
    stateWithInvalidHistory
  );
  assert.equal(stateWithInvalidHistory.stopMessageAiHistory, undefined);

  const stateWithoutPersistedRepeats = {
    stopMessageStageMode: 'on',
    stopMessageMaxRepeats: 0
  };
  deserializeStopMessageState(
    {
      stopMessageText: 'x',
      stopMessageStageMode: 'on',
      stopMessageAiMode: 'off'
    },
    stateWithoutPersistedRepeats
  );
  assert.equal(stateWithoutPersistedRepeats.stopMessageMaxRepeats, DEFAULT_STOP_MESSAGE_MAX_REPEATS);

  const noChangeState = { stopMessageStageMode: 'off', stopMessageMaxRepeats: 12 };
  const changedA = ensureStopMessageModeMaxRepeats(noChangeState);
  assert.equal(changedA, false);

  const normalizeState = { stopMessageStageMode: 'auto', stopMessageMaxRepeats: 8.9 };
  const changedB = ensureStopMessageModeMaxRepeats(normalizeState);
  assert.equal(changedB, true);
  assert.equal(normalizeState.stopMessageMaxRepeats, 8);

  const defaultState = { stopMessageStageMode: 'on' };
  const changedC = ensureStopMessageModeMaxRepeats(defaultState);
  assert.equal(changedC, true);
  assert.equal(defaultState.stopMessageMaxRepeats, DEFAULT_STOP_MESSAGE_MAX_REPEATS);

  const unchangedState = { stopMessageStageMode: 'on', stopMessageMaxRepeats: 5 };
  const changedD = ensureStopMessageModeMaxRepeats(unchangedState);
  assert.equal(changedD, false);

  assert.equal(normalizeStopMessageStageMode('  ON  '), 'on');
  assert.equal(normalizeStopMessageStageMode(' auto '), 'auto');
  assert.equal(normalizeStopMessageStageMode('none'), undefined);
  assert.equal(normalizeStopMessageStageMode(undefined), undefined);

  assert.equal(normalizeStopMessageAiMode(' On '), 'on');
  assert.equal(normalizeStopMessageAiMode('off'), 'off');
  assert.equal(normalizeStopMessageAiMode('auto'), undefined);
  assert.equal(normalizeStopMessageAiMode(undefined), undefined);
}

async function runNativeBridgeCoverage() {
  const mod = await importNativeSemantics('native-bridge');
  const { serializeStopMessageStateWithNative, deserializeStopMessageStateWithNative } = mod;
  const requiredNames = await readRequiredNativeExports();

  await withNativeCandidatesHidden(async () => {
    setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', '/tmp/routecodex-missing-native-stop-state.node');
    assert.throws(
      () => serializeStopMessageStateWithNative({}, () => ({ fallback: true })),
      /native serializeStopMessageStateJson is required but unavailable/i
    );
    assert.throws(
      () => deserializeStopMessageStateWithNative({}, {}, () => ({ fallback: true })),
      /native deserializeStopMessageStateJson is required but unavailable/i
    );
  });

  await withTempNativeModule(
    buildMockNativeModuleContent(requiredNames, {
      serializeStopMessageStateJson: 'function () { return ""; }',
      deserializeStopMessageStateJson: 'function () { return ""; }'
    }),
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      assert.throws(
        () => serializeStopMessageStateWithNative({}, () => ({ fallback: true })),
        /native serializeStopMessageStateJson is required but unavailable: empty result/i
      );
      assert.throws(
        () => deserializeStopMessageStateWithNative({}, {}, () => ({ fallback: true })),
        /native deserializeStopMessageStateJson is required but unavailable: empty result/i
      );
    }
  );

  await withTempNativeModule(
    buildMockNativeModuleContent(requiredNames, {
      serializeStopMessageStateJson: 'function () { throw "string-serialize"; }',
      deserializeStopMessageStateJson: 'function () { throw "string-deserialize"; }'
    }),
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      assert.throws(
        () => serializeStopMessageStateWithNative({}, () => ({ fallback: true })),
        /string-serialize/i
      );
      assert.throws(
        () => deserializeStopMessageStateWithNative({}, {}, () => ({ fallback: true })),
        /string-deserialize/i
      );
    }
  );

  await withTempNativeModule(
    buildMockNativeModuleContent(requiredNames, {
      serializeStopMessageStateJson: 'function () { return "[]"; }',
      deserializeStopMessageStateJson: 'function () { return "{bad"; }'
    }),
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      assert.throws(
        () => serializeStopMessageStateWithNative({}, () => ({ fallback: true })),
        /native serializeStopMessageStateJson is required but unavailable: invalid payload/i
      );
      assert.throws(
        () => deserializeStopMessageStateWithNative({}, {}, () => ({ fallback: true })),
        /native deserializeStopMessageStateJson is required but unavailable: invalid payload/i
      );
    }
  );

  await withTempNativeModule(
    buildMockNativeModuleContent(requiredNames, {
      serializeStopMessageStateJson: 'function () { throw new Error("boom-serialize"); }',
      deserializeStopMessageStateJson: 'function () { throw new Error("boom-deserialize"); }'
    }),
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      assert.throws(
        () => serializeStopMessageStateWithNative({}, () => ({ fallback: true })),
        /boom-serialize/i
      );
      assert.throws(
        () => deserializeStopMessageStateWithNative({}, {}, () => ({ fallback: true })),
        /boom-deserialize/i
      );
    }
  );

  await withTempNativeModule(
    buildMockNativeModuleContent(requiredNames, {
      serializeStopMessageStateJson: 'function () { return JSON.stringify({ ok: true }); }',
      deserializeStopMessageStateJson: 'function () { return JSON.stringify({ patch: 1 }); }'
    }),
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      const serialized = serializeStopMessageStateWithNative({ any: 'value' }, () => ({ fallback: false }));
      assert.deepEqual(serialized, { ok: true });
      const deserialized = deserializeStopMessageStateWithNative(
        { key: 'v' },
        { state: true },
        () => ({ fallback: false })
      );
      assert.deepEqual(deserialized, { patch: 1 });
    }
  );

  const cycle = {};
  cycle.self = cycle;

  await withTempNativeModule(
    buildMockNativeModuleContent(requiredNames, {
      serializeStopMessageStateJson: 'function () { return JSON.stringify({ shouldNotReach: true }); }',
      deserializeStopMessageStateJson: 'function () { return JSON.stringify({ shouldNotReach: true }); }'
    }),
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      assert.throws(
        () => serializeStopMessageStateWithNative(cycle, () => ({ fallback: true })),
        /json stringify failed/i
      );
      assert.throws(
        () => deserializeStopMessageStateWithNative({ key: 'v' }, cycle, () => ({ fallback: true })),
        /json stringify failed/i
      );
    }
  );
}

async function main() {
  const prevNativePath = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;

  try {
    delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
    await runNativeBridgeCoverage();
    delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
    await runCodecCoverage();
    console.log('✅ coverage-virtual-router-stop-message-state-codec passed');
  } finally {
    if (prevNativePath === undefined) {
      delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
    } else {
      process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH = prevNativePath;
    }
  }
}

main().catch((error) => {
  console.error('❌ coverage-virtual-router-stop-message-state-codec failed:', error);
  process.exit(1);
});
