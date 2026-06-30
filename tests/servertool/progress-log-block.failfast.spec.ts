import { describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js',
  () => ({
    normalizeServertoolProgressFlowIdWithNative: jest.fn(({ value }) =>
      typeof value === 'string' && value.trim() ? value.trim() : 'none'
    ),
    normalizeServertoolProgressResultWithNative: jest.fn(() => 'running'),
    normalizeServertoolProgressTokenWithNative: jest.fn(() => 'native_token'),
    resolveServertoolProgressStageWithNative: jest.fn(() => 'followup'),
    resolveServertoolProgressToolNameWithNative: jest.fn(() => 'fixture_tool'),
    shouldUseServertoolGoldProgressHighlightWithNative: jest.fn(() => false)
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/log/progress-file.js',
  () => ({
    appendServerToolProgressFileEvent: jest.fn()
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/metadata-center-carrier.js',
  () => ({
    readStopMessageCompareContext: jest.fn(() => ({
      decision: 'trigger',
      reason: 'matched',
      active: true,
      used: 1,
      left: 1
    }))
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js',
  () => ({
    formatStopMessageCompareContextWithNative: jest.fn(
      () => 'decision=trigger reason=matched used=1 left=1 active=true'
    )
  })
);

describe('progress-log-block fail-fast behavior', () => {
  test('progress stage and result normalization are native-owned', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile('sharedmodule/llmswitch-core/src/servertool/progress-log-block.ts', 'utf8')
    );
    expect(source).not.toContain('function resolveStage(');
    expect(source).not.toContain('function normalizeResult(');
    expect(source).not.toContain('function printServertoolLine(');
    expect(source).not.toContain("event.reason.trim().toLowerCase().replace");
    expect(source).not.toContain("compareContext.reason.toLowerCase().replace");
    expect(source).not.toContain('extra.flowId.trim()');
    expect(source).not.toContain('flowId.trim()');
    expect(source).toContain('normalizeServertoolProgressFlowIdWithNative({ value: extra?.flowId })');
    expect(source).toContain('normalizeServertoolProgressFlowIdWithNative({ value: flowId })');
    expect(source).toContain('resolveServertoolProgressStageWithNative({ step, message })');
    expect(source).toContain('normalizeServertoolProgressResultWithNative({ message })');
    expect(source).toContain('normalizeServertoolProgressTokenWithNative({ value: event.reason })');
    expect(source).toContain('normalizeServertoolProgressTokenWithNative({ value: compareContext.reason })');
  });

  test('console logging failures are not converted to non-blocking warnings', async () => {
    const { createServertoolProgressLogger } = await import(
      '../../sharedmodule/llmswitch-core/src/servertool/progress-log-block.js'
    );
    const logNonBlocking = jest.fn();
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {
      throw new Error('console down');
    });
    const logger = createServertoolProgressLogger({
      requestId: 'req-progress-console-failfast',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      adapterContext: {} as any,
      blue: '',
      yellow: '',
      gold: '',
      reset: '',
      logNonBlocking
    });

    try {
      expect(() => logger.logProgress(2, 5, 'running', { flowId: 'fixture_flow' })).toThrow('console down');
      expect(logNonBlocking).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  test('progress stage recorder failures are fail-fast', async () => {
    const { createServertoolProgressLogger } = await import(
      '../../sharedmodule/llmswitch-core/src/servertool/progress-log-block.js'
    );
    const logNonBlocking = jest.fn();
    const stageRecorder = {
      record: jest.fn(() => {
        throw new Error('stage recorder down');
      })
    };
    const logger = createServertoolProgressLogger({
      requestId: 'req-progress-stage-failfast',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      adapterContext: {} as any,
      stageRecorder: stageRecorder as any,
      blue: '',
      yellow: '',
      gold: '',
      reset: '',
      logNonBlocking
    });

    expect(() =>
      logger.logAutoHookTrace({
        hookId: 'hook_failfast',
        phase: 'post',
        priority: 100,
        queue: 'A_optional',
        queueIndex: 1,
        queueTotal: 1,
        result: 'match',
        reason: 'matched'
      })
    ).toThrow('stage recorder down');
    expect(() => logger.logStopCompare('trigger', 'stop_message_flow')).toThrow('stage recorder down');
    expect(logNonBlocking).not.toHaveBeenCalled();
  });
});
