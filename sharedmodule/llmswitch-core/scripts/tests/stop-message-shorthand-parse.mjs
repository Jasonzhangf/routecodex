import assert from 'node:assert';
import { readNativeFunction } from '../helpers/native-router-hotpath-loader.mjs';

const nativeModulePath = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH ||
  new URL('../../dist/native/router_hotpath_napi.node', import.meta.url).pathname;
process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH = nativeModulePath;

function parseFrom(text) {
  return parseRoutingInstructions([{ role: 'user', content: text }]);
}

function parseRoutingInstructions(messages) {
  const parseRoutingInstructionsJson = readNativeFunction('parseRoutingInstructionsJson');
  assert.equal(typeof parseRoutingInstructionsJson, 'function');
  const rawJson = parseRoutingInstructionsJson(
    JSON.stringify(messages),
    JSON.stringify({})
  );
  return JSON.parse(rawJson);
}

function applyRoutingInstructionsToStateWithNative(input) {
  const applyRoutingInstructionsJson = readNativeFunction('applyRoutingInstructionsJson');
  assert.equal(typeof applyRoutingInstructionsJson, 'function');
  const rawJson = applyRoutingInstructionsJson(JSON.stringify({
    instructions: input.instructions,
    state: serializeStateForNative(input.state)
  }));
  return JSON.parse(rawJson);
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

function createStateSnapshot() {
  return {
    forcedTarget: undefined,
    preferTarget: undefined,
    allowedProviders: new Set(),
    disabledProviders: new Set(),
    disabledKeys: new Map(),
    disabledModels: new Map(),
    stopMessageSource: 'explicit',
    stopMessageText: '继续执行',
    stopMessageMaxRepeats: 5,
    stopMessageUsed: 2,
    stopMessageUpdatedAt: 1000,
    stopMessageLastUsedAt: 2000,
    stopMessageStageMode: 'on'
  };
}

function run() {
  const setDefault = parseFrom('<**stopMessage:"继续"**>');
  assert.strictEqual(setDefault.length, 1);
  assert.strictEqual(setDefault[0].type, 'stopMessageSet');
  assert.strictEqual(setDefault[0].stopMessageText, '继续');
  assert.strictEqual(setDefault[0].stopMessageMaxRepeats, 10);

  const supportsModeShorthand = parseFrom('<**stopMessage:on**>').some((inst) => inst?.type === 'stopMessageMode');

  const setLowercasePrefix = parseFrom('<**stopmessage:"继续"**>');
  assert.strictEqual(setLowercasePrefix.length, 0);

  const modeWithTrailingText = parseFrom('<**stopMessage:on**>继续');
  assert.strictEqual(modeWithTrailingText.length, supportsModeShorthand ? 1 : 0);
  if (supportsModeShorthand) {
    assert.strictEqual(modeWithTrailingText[0].type, 'stopMessageMode');
    assert.strictEqual(modeWithTrailingText[0].stopMessageStageMode, 'on');
    assert.strictEqual(modeWithTrailingText[0].stopMessageMaxRepeats, 10);
  }

  const modeWithRepeat = parseFrom('<**stopMessage:on,3**>继续');
  assert.strictEqual(modeWithRepeat.length, supportsModeShorthand ? 1 : 0);
  if (supportsModeShorthand) {
    assert.strictEqual(modeWithRepeat[0].type, 'stopMessageMode');
    assert.strictEqual(modeWithRepeat[0].stopMessageStageMode, 'on');
    assert.strictEqual(modeWithRepeat[0].stopMessageMaxRepeats, 3);
  }

  const modeWithRepeatAndTimeTag = parseFrom(
    '<**stopMessage:on,3**>继续\n[Time/Date]: utc=2026-02-07T00:00:00.000Z local=2026-02-07 08:00:00.000 +08:00'
  );
  assert.strictEqual(modeWithRepeatAndTimeTag.length, supportsModeShorthand ? 1 : 0);
  if (supportsModeShorthand) {
    assert.strictEqual(modeWithRepeatAndTimeTag[0].type, 'stopMessageMode');
    assert.strictEqual(modeWithRepeatAndTimeTag[0].stopMessageStageMode, 'on');
    assert.strictEqual(modeWithRepeatAndTimeTag[0].stopMessageMaxRepeats, 3);
  }

  const modeWithoutTrailing = parseFrom('<**stopMessage:on,3**>');
  assert.strictEqual(modeWithoutTrailing.length, supportsModeShorthand ? 1 : 0);
  if (supportsModeShorthand) {
    assert.strictEqual(modeWithoutTrailing[0].type, 'stopMessageMode');
    assert.strictEqual(modeWithoutTrailing[0].stopMessageStageMode, 'on');
    assert.strictEqual(modeWithoutTrailing[0].stopMessageMaxRepeats, 3);
  }
  const historicalSetInstructions = parseRoutingInstructions([
    { role: 'user', content: '<**stopMessage:"继续执行",5**>继续' },
    { role: 'assistant', content: '收到' },
    { role: 'user', content: '继续下一步' }
  ]);
  assert.strictEqual(
    historicalSetInstructions.length,
    0,
    'only latest message marker should be parsed; historical user marker must be ignored'
  );

  const latestSetInstructions = parseRoutingInstructions([{ role: 'user', content: '<**stopMessage:"继续执行",5**>继续' }]);
  assert.strictEqual(latestSetInstructions.length, 1);
  assert.strictEqual(latestSetInstructions[0].type, 'stopMessageSet');
  const latestState = applyRoutingInstructionsToStateWithNative({
    instructions: latestSetInstructions,
    state: createStateSnapshot()
  });
  assert.strictEqual(latestState.stopMessageUsed, 0, 'latest explicit stopMessage command should rearm counter');
  assert.strictEqual(latestState.stopMessageLastUsedAt, undefined, 'latest explicit command should clear last-used marker');

  const aiModeSet = parseFrom('<**stopMessage:"推进到测试通过",4,ai:on**>');
  assert.strictEqual(aiModeSet.length, 1);
  assert.strictEqual(aiModeSet[0].type, 'stopMessageSet');
  assert.strictEqual(aiModeSet[0].stopMessageAiMode, 'on');

  const commaAliasSet = parseFrom('<**stopMessage,"现在重点是对话 ui 可以完成既定目标，正确渲染对话",ai:on,10**>');
  assert.strictEqual(commaAliasSet.length, 1);
  assert.strictEqual(commaAliasSet[0].type, 'stopMessageSet');
  assert.strictEqual(commaAliasSet[0].stopMessageAiMode, 'on');
  assert.strictEqual(commaAliasSet[0].stopMessageMaxRepeats, 10);

  const aiModeAliasSet = parseFrom('<**stopMessage:"推进到测试通过",4,mode auto=ai**>');
  assert.strictEqual(aiModeAliasSet.length, 1);
  assert.strictEqual(aiModeAliasSet[0].type, 'stopMessageSet');
  assert.strictEqual(aiModeAliasSet[0].stopMessageAiMode, 'on');

  const invalidAiModeWithoutText = parseFrom('<**stopMessage:ai:on**>');
  assert.strictEqual(invalidAiModeWithoutText.length, 0);

  const clearCaseInsensitive = parseFrom('<**stopmessage:clear**>');
  assert.strictEqual(clearCaseInsensitive.length, 0);

  console.log('✅ stop-message shorthand parse checks passed');
}

run();
