import { describe, expect, jest, test } from '@jest/globals';
import { MetadataCenter } from '../../src/server/runtime/http-server/metadata-center/metadata-center.js';

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js',
  () => ({
    buildServertoolAutoHookTraceProgressEventWithNative: jest.fn((event) => ({
      flowId: event.flowId || `hook:${event.hookId}`,
      tool: event.hookId,
      stage: 'hook',
      result: `${event.result}_native_token`,
      message: 'native auto-hook trace message',
      step: 2
    })),
    buildServertoolMatchSkippedProgressEventWithNative: jest.fn(({ skipReason }) => ({
      flowId: 'none',
      tool: 'none',
      stage: 'match',
      result: `skipped_${skipReason}`,
      message: `skipped (${skipReason})`,
      step: 0
    })),
    buildServertoolStopEntryProgressEventWithNative: jest.fn(({ stage, result }) => ({
      flowId: 'stop_message_flow',
      tool: 'stop_message_auto',
      stage,
      result,
      message: result,
      step: stage === 'entry' ? 0 : 2
    })),
    buildServertoolStopCompareProgressEventWithNative: jest.fn(({ stage, flowId, summary, compare }) => ({
      flowId: flowId || 'none',
      tool: 'stop_message_auto',
      stage: 'compare',
      result: compare ? `${compare.decision}_native_token` : 'unknown_no_context',
      message: summary,
      step: stage === 'entry' ? 1 : 3
    })),
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
    readProviderProtocolFromAnyBoundMetadataCenter: jest.fn(() => 'openai-responses'),
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
  function bindProviderProtocol(adapterContext: Record<string, unknown>): Record<string, unknown> {
    MetadataCenter.attach(adapterContext).writeRuntimeControl(
      'providerProtocol',
      'openai-responses',
      {
        module: 'tests/servertool/progress-log-block.failfast.spec.ts',
        symbol: 'bindProviderProtocol',
        stage: 'test'
      }
    );
    return adapterContext;
  }

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
    expect(source).toContain('resolveServertoolProgressStageWithNative({ step, message })');
    expect(source).toContain('normalizeServertoolProgressResultWithNative({ message })');
    expect(source).toContain('export function appendServertoolMatchSkippedProgressEvent(');
    expect(source).toContain('readProviderProtocolFromAnyBoundMetadataCenter(args.adapterContext');
    expect(source).toContain('buildServertoolAutoHookTraceProgressEventWithNative(event)');
    expect(source).toContain('buildServertoolMatchSkippedProgressEventWithNative({');
    expect(source).toContain('buildServertoolStopEntryProgressEventWithNative({');
    expect(source).toContain('buildServertoolStopCompareProgressEventWithNative({');
    expect(source).not.toContain('const reasonToken = normalizeServertoolProgressTokenWithNative({ value: event.reason })');
    expect(source).not.toContain('result: `${event.result}_${reasonToken ||');
    expect(source).not.toContain('message: `${event.result} (${event.reason}) queue=');
    expect(source).not.toContain("result: 'skipped_' + args.skipReason");
    expect(source).not.toContain("message: 'skipped (' + args.skipReason + ')'");
    expect(source).not.toContain('const compareResult = compareContext');
    expect(source).not.toContain('normalizeServertoolProgressTokenWithNative({ value: compareContext.reason })');
    expect(source).not.toContain("stage: 'compare'");
    expect(source).not.toContain("unknown_no_context");
    expect(source).not.toContain("step: stage === 'entry' ? 0 : 2");
    expect(source).not.toContain("step: stage === 'entry' ? 1 : 3");
  });

  test('match skipped progress event reads protocol in progress log owner', async () => {
    const { appendServertoolMatchSkippedProgressEvent } = await import(
      '../../sharedmodule/llmswitch-core/src/servertool/progress-log-block.js'
    );
    const { appendServerToolProgressFileEvent } = await import(
      '../../sharedmodule/llmswitch-core/src/servertool/log/progress-file.js'
    );

    appendServertoolMatchSkippedProgressEvent({
      requestId: 'req-match-skipped-progress',
      entryEndpoint: '/v1/responses',
      adapterContext: bindProviderProtocol({}) as any,
      skipReason: 'passthrough'
    });

    expect(appendServerToolProgressFileEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-match-skipped-progress',
        flowId: 'none',
        tool: 'none',
        stage: 'match',
        result: 'skipped_passthrough',
        message: 'skipped (passthrough)',
        step: 0,
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses'
      })
    );
    const { buildServertoolMatchSkippedProgressEventWithNative } = await import(
      '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js'
    );
    expect(buildServertoolMatchSkippedProgressEventWithNative).toHaveBeenCalledWith({
      skipReason: 'passthrough'
    });
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
      adapterContext: bindProviderProtocol({}) as any,
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
      adapterContext: bindProviderProtocol({}) as any,
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
