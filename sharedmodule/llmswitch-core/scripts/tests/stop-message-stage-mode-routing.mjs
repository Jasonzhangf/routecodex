import assert from 'node:assert';
import { readNativeFunction } from '../../dist/native/router-hotpath/native-router-hotpath-loader.js';

const nativeModulePath = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH ||
  new URL('../../dist/native/router_hotpath_napi.node', import.meta.url).pathname;
process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH = nativeModulePath;

function readNativeJson(name, args) {
  const fn = readNativeFunction(name);
  assert.equal(typeof fn, 'function');
  const raw = fn(...args);
  assert.equal(typeof raw, 'string');
  return JSON.parse(raw);
}

function serializeStateForNative(state) {
  return {
    ...state,
    allowedProviders: Array.isArray(state.allowedProviders)
      ? state.allowedProviders
      : Array.from(state.allowedProviders ?? []),
    disabledProviders: Array.isArray(state.disabledProviders)
      ? state.disabledProviders
      : Array.from(state.disabledProviders ?? []),
    disabledKeys: Array.isArray(state.disabledKeys) ? state.disabledKeys : Array.from(state.disabledKeys ?? new Map()).map(([provider, keys]) => ({
      provider,
      keys: Array.from(keys)
    })),
    disabledModels: Array.isArray(state.disabledModels) ? state.disabledModels : Array.from(state.disabledModels ?? new Map()).map(([provider, models]) => ({
      provider,
      models: Array.from(models)
    }))
  };
}

function parseRoutingInstructions(messages) {
  return readNativeJson('parseRoutingInstructionsJson', [
    JSON.stringify(messages),
    JSON.stringify({})
  ]);
}

function applyRoutingInstructionsToStateWithNative(input) {
  return readNativeJson('applyRoutingInstructionsJson', [
    JSON.stringify({
      instructions: input.instructions,
      state: serializeStateForNative(input.state)
    })
  ]);
}

function serializeRoutingInstructionState(state) {
  return readNativeJson('serializeRoutingInstructionStateJson', [
    JSON.stringify(serializeStateForNative(state))
  ]);
}

function deserializeRoutingInstructionState(state) {
  return readNativeJson('deserializeRoutingInstructionStateJson', [
    JSON.stringify(serializeStateForNative(state))
  ]);
}

function emptyState() {
  return {
    forcedTarget: undefined,
    preferTarget: undefined,
    allowedProviders: new Set(),
    disabledProviders: new Set(),
    disabledKeys: new Map(),
    disabledModels: new Map(),
    stopMessageSource: undefined,
    stopMessageText: undefined,
    stopMessageMaxRepeats: undefined,
    stopMessageUsed: undefined,
    stopMessageUpdatedAt: undefined,
    stopMessageLastUsedAt: undefined,
    stopMessageStageMode: undefined
  };
}

function parseFrom(text) {
  return parseRoutingInstructions([{ role: 'user', content: text }]);
}

function run() {
  const modeOnly = parseFrom('<**stopMessage:off**>');
  assert.strictEqual(modeOnly.length, 1, 'mode-only instruction should be parsed by native');
  assert.strictEqual(modeOnly[0].type, 'stopMessageClear');

  const setInstruction = parseFrom('<**stopMessage:"继续执行",3**>');
  assert.strictEqual(setInstruction.length, 1, 'set instruction should be parsed');
  assert.strictEqual(setInstruction[0].type, 'stopMessageSet');
  assert.strictEqual(setInstruction[0].stopMessageMaxRepeats, 3);
  assert.strictEqual(setInstruction[0].stopMessageStageMode, undefined);

  let state = deserializeRoutingInstructionState(
    applyRoutingInstructionsToStateWithNative({ instructions: setInstruction, state: emptyState() })
  );
  assert.strictEqual(state.stopMessageText, '继续执行');
  assert.strictEqual(state.stopMessageStageMode, 'on');

  const setNoMode = parseFrom('<**stopMessage:"继续执行",2**>');
  state = deserializeRoutingInstructionState(
    applyRoutingInstructionsToStateWithNative({ instructions: setNoMode, state })
  );
  assert.strictEqual(state.stopMessageText, '继续执行');
  assert.strictEqual(state.stopMessageMaxRepeats, 2);
  assert.strictEqual(state.stopMessageStageMode, 'on', 'set after mode=off should re-arm stage mode');

  const serialized = serializeRoutingInstructionState(state);
  const restored = deserializeRoutingInstructionState(serialized);
  assert.strictEqual(restored.stopMessageStageMode, 'on', 'stage mode should persist once re-armed');

  const clear = parseFrom('<**stopMessage:clear**>');
  const cleared = deserializeRoutingInstructionState(
    applyRoutingInstructionsToStateWithNative({ instructions: clear, state: restored })
  );
  assert.strictEqual(cleared.stopMessageText, undefined);
  assert.strictEqual(cleared.stopMessageMaxRepeats, undefined);
  assert.strictEqual(cleared.stopMessageStageMode, undefined, 'clear should remove stopMessage mode marker');
  assert.strictEqual(typeof cleared.stopMessageUpdatedAt, 'number');

  console.log('✅ stop-message stage mode routing checks passed');
}

run();
