#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const actionsModuleUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'router', 'virtual-router', 'routing-stop-message-actions.js')
).href;
const nativeSemanticsModuleUrl = pathToFileURL(
  path.join(
    repoRoot,
    'dist',
    'router',
    'virtual-router',
    'engine-selection',
    'native-virtual-router-stop-message-actions-semantics.js'
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

async function importActions(tag) {
  return cacheBustedImport(actionsModuleUrl, tag);
}

async function importNativeSemantics(tag) {
  return cacheBustedImport(nativeSemanticsModuleUrl, tag);
}

async function withTempNativeModule(content, run) {
  const prevNativePath = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-stopmessage-actions-native-'));
  const file = path.join(dir, 'mock-native.cjs');
  await fs.writeFile(file, content, 'utf8');
  try {
    await run(file);
  } finally {
    if (prevNativePath === undefined) {
      delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
    } else {
      process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH = prevNativePath;
    }
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

function createState(overrides = {}) {
  return {
    allowedProviders: new Set(),
    disabledProviders: new Set(),
    disabledKeys: new Map(),
    disabledModels: new Map(),
    stopMessageSource: 'old-source',
    stopMessageText: 'old-text',
    stopMessageMaxRepeats: 2,
    stopMessageUsed: 1,
    stopMessageUpdatedAt: 111,
    stopMessageLastUsedAt: 222,
    stopMessageStageMode: 'off',
    stopMessageAiMode: 'on',
    stopMessageAiSeedPrompt: 'seed',
    stopMessageAiHistory: [{ ts: 1, round: 1, assistantText: 'a' }],
    ...overrides
  };
}

async function runActionsCoverage() {
  const mod = await importActions('actions');
  const { applyStopMessageInstructionToState } = mod;
  const requiredNames = await readRequiredNativeExports();

  {
    const state = createState();
    const applied = applyStopMessageInstructionToState(
      {
        type: 'stopMessageSet',
        stopMessageText: '  继续执行  ',
        stopMessageMaxRepeats: 7.8,
        stopMessageAiMode: 'off',
        stopMessageSource: '  explicit-source  '
      },
      state
    );
    assert.equal(applied, true);
    assert.equal(state.stopMessageText, '继续执行');
    assert.equal(state.stopMessageMaxRepeats, 7);
    assert.equal(state.stopMessageSource, 'explicit-source');
    assert.equal(state.stopMessageStageMode, 'on');
    assert.equal(state.stopMessageAiMode, 'off');
    assert.equal(state.stopMessageUsed, 0);
    assert.equal(typeof state.stopMessageUpdatedAt, 'number');
    assert.equal(state.stopMessageLastUsedAt, undefined);
    assert.equal(state.stopMessageAiSeedPrompt, undefined);
    assert.equal(state.stopMessageAiHistory, undefined);
  }

  {
    const state = createState({
      stopMessageText: 'same',
      stopMessageMaxRepeats: 5,
      stopMessageStageMode: 'on',
      stopMessageAiMode: 'off',
      stopMessageUsed: 0,
      stopMessageUpdatedAt: 321,
      stopMessageLastUsedAt: undefined
    });
    const applied = applyStopMessageInstructionToState(
      {
        type: 'stopMessageSet',
        stopMessageText: 'same',
        stopMessageMaxRepeats: 5,
        stopMessageAiMode: 'off',
        fromHistoricalUserMessage: true
      },
      state
    );
    assert.equal(applied, true);
    assert.equal(state.stopMessageUpdatedAt, 321);
  }

  {
    const state = createState({ stopMessageStageMode: 'on', stopMessageMaxRepeats: 3 });
    const applied = applyStopMessageInstructionToState(
      {
        type: 'stopMessageMode',
        stopMessageStageMode: 'off'
      },
      state
    );
    assert.equal(applied, true);
    assert.equal(state.stopMessageStageMode, 'off');
    assert.equal(typeof state.stopMessageUpdatedAt, 'number');
  }

  {
    const state = createState({ stopMessageStageMode: 'off', stopMessageMaxRepeats: undefined });
    const applied = applyStopMessageInstructionToState(
      {
        type: 'stopMessageMode',
        stopMessageStageMode: 'auto'
      },
      state
    );
    assert.equal(applied, true);
    assert.equal(state.stopMessageStageMode, 'auto');
    assert.equal(state.stopMessageSource, 'explicit');
    assert.equal(state.stopMessageMaxRepeats, 10);
  }

  {
    const state = createState({ stopMessageStageMode: 'off', stopMessageMaxRepeats: 3 });
    const applied = applyStopMessageInstructionToState(
      {
        type: 'stopMessageMode',
        stopMessageStageMode: 'on',
        stopMessageMaxRepeats: 12.9
      },
      state
    );
    assert.equal(applied, true);
    assert.equal(state.stopMessageMaxRepeats, 12);
  }

  {
    const state = createState({ stopMessageStageMode: 'off', stopMessageMaxRepeats: 4.8 });
    const applied = applyStopMessageInstructionToState(
      {
        type: 'stopMessageMode',
        stopMessageStageMode: 'on',
        stopMessageMaxRepeats: -1
      },
      state
    );
    assert.equal(applied, true);
    assert.equal(state.stopMessageMaxRepeats, 4);
  }

  await withTempNativeModule(
    buildMockNativeModuleContent(requiredNames, {
      applyStopMessageInstructionJson: `function () {
        return JSON.stringify({
          applied: true,
          set: {
            stopMessageSource: 42,
            stopMessageText: "native-text",
            stopMessageAiSeedPrompt: "native-seed",
            stopMessageStageMode: " AUTO ",
            stopMessageAiMode: "invalid",
            stopMessageMaxRepeats: "oops",
            stopMessageUsed: 6,
            stopMessageUpdatedAt: 7,
            stopMessageLastUsedAt: 8,
            stopMessageAiHistory: [{ ts: 1 }, null],
            unknownField: 123
          },
          unset: ["stopMessageText", "unknown"]
        });
      }`
    }),
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      const state = createState({ stopMessageAiMode: 'off', stopMessageMaxRepeats: 9, stopMessageSource: 'keep-source' });
      const applied = applyStopMessageInstructionToState(
        {
          type: 'stopMessageSet',
          stopMessageText: 'fallback-set',
          stopMessageMaxRepeats: 2
        },
        state
      );
      assert.equal(applied, true);
      assert.equal(state.stopMessageSource, 'keep-source');
      assert.equal(state.stopMessageText, 'native-text');
      assert.equal(state.stopMessageAiSeedPrompt, 'native-seed');
      assert.equal(state.stopMessageStageMode, 'auto');
      assert.equal(state.stopMessageAiMode, 'off');
      assert.equal(state.stopMessageMaxRepeats, 9);
      assert.equal(state.stopMessageUsed, 6);
      assert.equal(state.stopMessageUpdatedAt, 7);
      assert.equal(state.stopMessageLastUsedAt, 8);
      assert.equal(Array.isArray(state.stopMessageAiHistory), true);
      assert.equal(state.stopMessageAiHistory.length, 1);
    }
  );

  await withTempNativeModule(
    buildMockNativeModuleContent(requiredNames, {
      applyStopMessageInstructionJson:
        'function () { return JSON.stringify({ applied: true, set: { stopMessageAiHistory: "invalid-history" }, unset: [] }); }'
    }),
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      const state = createState({ stopMessageAiHistory: [{ keep: true }] });
      const applied = applyStopMessageInstructionToState(
        {
          type: 'stopMessageSet',
          stopMessageText: 'fallback-set',
          stopMessageMaxRepeats: 2
        },
        state
      );
      assert.equal(applied, true);
      assert.deepEqual(state.stopMessageAiHistory, [{ keep: true }]);
    }
  );

  {
    const cycle = {};
    cycle.self = cycle;
    const state = createState({
      stopMessageAiHistory: [cycle]
    });
    assert.throws(
      () =>
        applyStopMessageInstructionToState(
          {
            type: 'enable',
            provider: 'noop'
          },
          state
        ),
      /json stringify failed/i
    );
  }

  {
    const state = createState();
    const applied = applyStopMessageInstructionToState(
      {
        type: 'stopMessageClear'
      },
      state
    );
    assert.equal(applied, true);
    assert.equal(state.stopMessageText, undefined);
    assert.equal(state.stopMessageMaxRepeats, undefined);
    assert.equal(state.stopMessageUsed, undefined);
    assert.equal(state.stopMessageSource, undefined);
    assert.equal(state.stopMessageStageMode, undefined);
    assert.equal(state.stopMessageAiMode, undefined);
    assert.equal(state.stopMessageAiSeedPrompt, undefined);
    assert.equal(state.stopMessageAiHistory, undefined);
    assert.equal(typeof state.stopMessageUpdatedAt, 'number');
  }

  {
    const state = createState({ stopMessageText: 'keep', stopMessageMaxRepeats: 3 });
    const applied = applyStopMessageInstructionToState(
      {
        type: 'stopMessageSet',
        stopMessageText: ' ',
        stopMessageMaxRepeats: 0
      },
      state
    );
    assert.equal(applied, true);
    assert.equal(state.stopMessageText, 'keep');
    assert.equal(state.stopMessageMaxRepeats, 3);
  }

  {
    const state = createState({ stopMessageStageMode: 'off' });
    const applied = applyStopMessageInstructionToState(
      {
        type: 'stopMessageMode',
        stopMessageStageMode: 'invalid'
      },
      state
    );
    assert.equal(applied, true);
    assert.equal(state.stopMessageStageMode, 'off');
  }

  {
    const state = createState({ stopMessageText: 'untouched' });
    const applied = applyStopMessageInstructionToState(
      {
        type: 'enable',
        provider: 'abc'
      },
      state
    );
    assert.equal(applied, false);
    assert.equal(state.stopMessageText, 'untouched');
  }
}

async function runNativeBridgeCoverage() {
  const mod = await importNativeSemantics('native-bridge');
  const { applyStopMessageInstructionWithNative } = mod;
  const requiredNames = await readRequiredNativeExports();

  await withNativeCandidatesHidden(async () => {
    setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', '/tmp/routecodex-missing-native-stop-actions.node');
    assert.throws(
      () =>
        applyStopMessageInstructionWithNative({}, {}, Date.now(), () => ({
          applied: true,
          set: {},
          unset: []
        })),
      /native applyStopMessageInstructionJson is required but unavailable/i
    );
  });

  await withTempNativeModule(
    buildMockNativeModuleContent(requiredNames, {
      applyStopMessageInstructionJson: 'function () { return ""; }'
    }),
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      assert.throws(
        () =>
          applyStopMessageInstructionWithNative({}, {}, Date.now(), () => ({
            applied: true,
            set: {},
            unset: []
          })),
        /native applyStopMessageInstructionJson is required but unavailable: empty result/i
      );
    }
  );

  await withTempNativeModule(
    buildMockNativeModuleContent(requiredNames, {
      applyStopMessageInstructionJson: 'function () { return "{}"; }'
    }),
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      assert.throws(
        () =>
          applyStopMessageInstructionWithNative({}, {}, Date.now(), () => ({
            applied: true,
            set: {},
            unset: []
          })),
        /native applyStopMessageInstructionJson is required but unavailable: invalid payload/i
      );
    }
  );

  await withTempNativeModule(
    buildMockNativeModuleContent(requiredNames, {
      applyStopMessageInstructionJson: 'function () { return "{bad"; }'
    }),
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      assert.throws(
        () =>
          applyStopMessageInstructionWithNative({}, {}, Date.now(), () => ({
            applied: true,
            set: {},
            unset: []
          })),
        /native applyStopMessageInstructionJson is required but unavailable: invalid payload/i
      );
    }
  );

  await withTempNativeModule(
    buildMockNativeModuleContent(requiredNames, {
      applyStopMessageInstructionJson: 'function () { return "[]"; }'
    }),
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      assert.throws(
        () =>
          applyStopMessageInstructionWithNative({}, {}, Date.now(), () => ({
            applied: true,
            set: {},
            unset: []
          })),
        /native applyStopMessageInstructionJson is required but unavailable: invalid payload/i
      );
    }
  );

  await withTempNativeModule(
    buildMockNativeModuleContent(requiredNames, {
      applyStopMessageInstructionJson: 'function () { throw "string-failed"; }'
    }),
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      assert.throws(
        () =>
          applyStopMessageInstructionWithNative({}, {}, Date.now(), () => ({
            applied: true,
            set: {},
            unset: []
          })),
        /string-failed/i
      );
    }
  );

  await withTempNativeModule(
    buildMockNativeModuleContent(requiredNames, {
      applyStopMessageInstructionJson: 'function () { throw new Error("error-failed"); }'
    }),
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      assert.throws(
        () =>
          applyStopMessageInstructionWithNative({}, {}, Date.now(), () => ({
            applied: true,
            set: {},
            unset: []
          })),
        /error-failed/i
      );
    }
  );

  await withTempNativeModule(
    buildMockNativeModuleContent(requiredNames, {
      applyStopMessageInstructionJson: 'function () { throw null; }'
    }),
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      assert.throws(
        () =>
          applyStopMessageInstructionWithNative({}, {}, Date.now(), () => ({
            applied: true,
            set: {},
            unset: []
          })),
        /unknown/i
      );
    }
  );

  await withTempNativeModule(
    buildMockNativeModuleContent(requiredNames, {
      applyStopMessageInstructionJson:
        'function () { return JSON.stringify({ applied: true, set: { stopMessageText: "x", unknown: 1 }, unset: ["stopMessageAiMode", "bad"] }); }'
    }),
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      const patch = applyStopMessageInstructionWithNative({}, {}, Date.now(), () => ({
        applied: false,
        set: {},
        unset: []
      }));
      assert.equal(patch.applied, true);
      assert.deepEqual(patch.set, { stopMessageText: 'x', unknown: 1 });
      assert.deepEqual(patch.unset, ['stopMessageAiMode', 'bad']);
    }
  );

  await withTempNativeModule(
    buildMockNativeModuleContent(requiredNames, {
      applyStopMessageInstructionJson:
        'function () { return JSON.stringify({ applied: true, set: { stopMessageStageMode: "on" }, unset: {} }); }'
    }),
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      const patch = applyStopMessageInstructionWithNative({}, {}, Date.now(), () => ({
        applied: false,
        set: {},
        unset: []
      }));
      assert.equal(patch.applied, true);
      assert.deepEqual(patch.set, { stopMessageStageMode: 'on' });
      assert.deepEqual(patch.unset, []);
    }
  );

  const cycle = {};
  cycle.self = cycle;

  await withTempNativeModule(
    buildMockNativeModuleContent(requiredNames, {
      applyStopMessageInstructionJson:
        'function () { return JSON.stringify({ applied: true, set: {}, unset: [] }); }'
    }),
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      assert.throws(
        () =>
          applyStopMessageInstructionWithNative(cycle, {}, Date.now(), () => ({
            applied: true,
            set: { stopMessageText: 'fallback' },
            unset: []
          })),
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
    await runActionsCoverage();
    console.log('✅ coverage-virtual-router-stop-message-actions passed');
  } finally {
    if (prevNativePath === undefined) {
      delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
    } else {
      process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH = prevNativePath;
    }
  }
}

main().catch((error) => {
  console.error('❌ coverage-virtual-router-stop-message-actions failed:', error);
  process.exit(1);
});
