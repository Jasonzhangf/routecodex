import assert from 'node:assert';
import {
  applyRoutingInstructions,
  deserializeRoutingInstructionState,
  parseRoutingInstructions,
  serializeRoutingInstructionState
} from '../../dist/router/virtual-router/routing-instructions.js';

function emptyState() {
  return {
    forcedTarget: undefined,
    stickyTarget: undefined,
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
  assert.strictEqual(modeOnly.length, 0, 'mode-only instruction should not be parsed');

  const setInstruction = parseFrom('<**stopMessage:"继续执行",3**>');
  assert.strictEqual(setInstruction.length, 1, 'set instruction should be parsed');
  assert.strictEqual(setInstruction[0].type, 'stopMessageSet');
  assert.strictEqual(setInstruction[0].stopMessageMaxRepeats, 3);
  assert.strictEqual(setInstruction[0].stopMessageStageMode, undefined);

  let state = applyRoutingInstructions(setInstruction, emptyState());
  assert.strictEqual(state.stopMessageText, '继续执行');
  assert.strictEqual(state.stopMessageStageMode, 'on');

  const setNoMode = parseFrom('<**stopMessage:"继续执行",2**>');
  state = applyRoutingInstructions(setNoMode, state);
  assert.strictEqual(state.stopMessageText, '继续执行');
  assert.strictEqual(state.stopMessageMaxRepeats, 2);
  assert.strictEqual(state.stopMessageStageMode, 'on', 'set after mode=off should re-arm stage mode');

  const serialized = serializeRoutingInstructionState(state);
  const restored = deserializeRoutingInstructionState(serialized);
  assert.strictEqual(restored.stopMessageStageMode, 'on', 'stage mode should persist once re-armed');

  const clear = parseFrom('<**stopMessage:clear**>');
  const cleared = applyRoutingInstructions(clear, restored);
  assert.strictEqual(cleared.stopMessageText, undefined);
  assert.strictEqual(cleared.stopMessageMaxRepeats, undefined);
  assert.strictEqual(cleared.stopMessageStageMode, undefined, 'clear should remove stopMessage mode marker');

  console.log('✅ stop-message stage mode routing checks passed');
}

run();
