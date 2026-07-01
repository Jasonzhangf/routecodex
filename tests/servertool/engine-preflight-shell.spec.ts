import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const inspectStopGatewaySignalMock = jest.fn();
const attachStopGatewayContextMock = jest.fn();
const containsSyntheticRouteCodexControlTextMock = jest.fn(() => false);
const planServertoolEnginePreflightWithNativeMock = jest.fn();

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/metadata-center-carrier.js',
  () => ({
    inspectStopGatewaySignal: inspectStopGatewaySignalMock,
    attachStopGatewayContext: attachStopGatewayContextMock,
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js',
  () => ({
    containsSyntheticRouteCodexControlTextWithNative: containsSyntheticRouteCodexControlTextMock,
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js',
  () => ({
    planServertoolEnginePreflightWithNative: planServertoolEnginePreflightWithNativeMock,
  })
);

const { runEnginePreflight } = await import(
  '../../sharedmodule/llmswitch-core/src/servertool/engine-preflight-shell.js'
);

describe('engine-preflight-shell', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    inspectStopGatewaySignalMock.mockReturnValue({
      observed: true,
      eligible: true,
      source: 'chat',
      reason: 'stop_schema_missing',
      choiceIndex: 0,
      hasToolCalls: false,
    });
    planServertoolEnginePreflightWithNativeMock.mockReturnValue({
      action: 'continue_to_engine',
      attachStopGatewayContext: true,
      logStopEntry: {
        stage: 'entry',
        result: 'observed',
        includeChoiceFacts: true
      }
    });
  });

  test('keeps engine preflight planning and stop-gateway wiring in the owner shell', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(
        'sharedmodule/llmswitch-core/src/servertool/engine-preflight-shell.ts',
        'utf8'
      )
    );

    expect(source).toContain('planServertoolEnginePreflightWithNative');
    expect(source).toContain('function runPreflightSideEffects(');
    expect(source).toContain('inspectStopGatewaySignal(');
    expect(source).toContain('attachStopGatewayContext(');
    expect(source).toContain('containsSyntheticRouteCodexControlTextWithNative(');
    expect(source).not.toContain('stopSignal.observed && preflightAction.action');
    expect(source).not.toContain('if (stopSignal.observed) {');
    expect(source).not.toContain("if (preflightAction.action === 'return_original_chat')");
    expect(source).not.toContain("if (preflightAction.action === 'return_original_chat_direct_passthrough')");
    expect(source).toContain("case 'return_original_chat'");
    expect(source).toContain("case 'return_original_chat_direct_passthrough'");
    expect(source).toContain("case 'continue_to_engine'");
    expect(source).toContain('preflightAction.attachStopGatewayContext === true');
    expect(source).toContain('preflightAction.logStopEntry');
    expect(source).toContain('preflightAction.logStopCompare');
    expect(source).not.toContain('preflightAction.logStopEntry.stage');
    expect(source).not.toContain('preflightAction.logStopEntry.result');
    expect(source).not.toContain('./stop-gateway-context.js');
    expect(source).not.toContain('./orchestration-policy-block.js');
  });

  test('returns original chat when native preflight says so', () => {
    planServertoolEnginePreflightWithNativeMock.mockReturnValue({
      action: 'return_original_chat',
      attachStopGatewayContext: false
    });

    const result = runEnginePreflight({
      chat: { id: 'chat-1' } as any,
      adapterContext: {} as any,
      logStopEntry: jest.fn(),
      logStopCompare: jest.fn(),
    });

    expect(result).toEqual({
      kind: 'return_original_chat',
      chat: { id: 'chat-1' },
    });
    expect(attachStopGatewayContextMock).not.toHaveBeenCalled();
  });

  test('returns direct passthrough and logs trigger when native preflight disables stopless', () => {
    const logStopEntry = jest.fn();
    const logStopCompare = jest.fn();
    planServertoolEnginePreflightWithNativeMock.mockReturnValue({
      action: 'return_original_chat_direct_passthrough',
      attachStopGatewayContext: true,
      logStopEntry: {
        stage: 'trigger',
        result: 'skipped_direct_passthrough',
        includeChoiceFacts: false
      },
      logStopCompare: {
        stage: 'trigger'
      }
    });

    const result = runEnginePreflight({
      chat: { id: 'chat-2' } as any,
      adapterContext: {} as any,
      logStopEntry,
      logStopCompare,
    });

    expect(result).toEqual({
      kind: 'return_original_chat_direct_passthrough',
      chat: { id: 'chat-2' },
    });
    expect(attachStopGatewayContextMock).toHaveBeenCalled();
    expect(logStopEntry).toHaveBeenCalledWith(
      'trigger',
      'skipped_direct_passthrough',
      expect.objectContaining({ reason: 'stop_schema_missing', source: 'chat', eligible: true })
    );
    expect(logStopCompare).toHaveBeenCalledWith('trigger');
  });

  test('continues with stop signal and logs observed entry', () => {
    const logStopEntry = jest.fn();
    const logStopCompare = jest.fn();

    const result = runEnginePreflight({
      chat: { id: 'chat-3' } as any,
      adapterContext: {} as any,
      logStopEntry,
      logStopCompare,
    });

    expect(result).toEqual({
      kind: 'continue',
      stopSignal: expect.objectContaining({ observed: true, reason: 'stop_schema_missing' }),
    });
    expect(attachStopGatewayContextMock).toHaveBeenCalled();
    expect(logStopEntry).toHaveBeenCalledWith(
      'entry',
      'observed',
      expect.objectContaining({ reason: 'stop_schema_missing', source: 'chat', eligible: true })
    );
    expect(logStopCompare).not.toHaveBeenCalled();
  });
});
