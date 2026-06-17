import {
  disableDebugMode,
  enableDebugMode,
  responsePostProcessingMonitoringHook,
} from '../../../../src/providers/core/hooks/debug-example-hooks.js';
import { HookStage, BidirectionalHookManager } from '../../../../src/providers/core/config/provider-debug-hooks.js';

describe('provider.debug_example_hooks_surface', () => {
  afterEach(() => {
    disableDebugMode();
  });

  it('records response metadata observations without changing the payload in read()', () => {
    const now = Date.now();
    const result = responsePostProcessingMonitoringHook.read!(
      {
        data: {
          status: 200,
          metadata: {
            requestId: 'req-debug-1',
            usage: {
              prompt_tokens: 3,
              completion_tokens: 5,
            },
            hookMetrics: {
              totalHooks: 2,
            },
          },
        },
        metadata: {
          dataType: 'response',
          size: 128,
          changes: [],
          timestamp: now,
          executionId: 'exec-debug-1',
        },
      },
      {
        stage: HookStage.RESPONSE_POSTPROCESSING,
        changeCount: 0,
        startTime: now - 25,
        debugEnabled: true,
        executionId: 'exec-debug-1',
      } as any
    );

    expect(result.observations).toEqual(
      expect.arrayContaining([
        '📋 响应包含元数据',
        '🆔 请求ID: req-debug-1',
        '🔧 Hook执行指标已记录',
      ])
    );
    expect(result.metrics).toEqual(
      expect.objectContaining({
        totalProcessingTime: expect.any(Number),
        hookMetrics: {
          totalHooks: 2,
        },
      })
    );
  });

  it('writes finalProcessingTimestamp into metadata during transform()', () => {
    const before = Date.now() - 50;
    const result = responsePostProcessingMonitoringHook.transform!(
      {
        data: {
          status: 200,
          metadata: {
            requestId: 'req-debug-2',
          },
        },
        metadata: {
          dataType: 'response',
          size: 96,
          changes: [],
          timestamp: before,
          executionId: 'exec-debug-2',
        },
      },
      {
        stage: HookStage.RESPONSE_POSTPROCESSING,
        changeCount: 0,
        startTime: before,
        debugEnabled: true,
        executionId: 'exec-debug-2',
      } as any
    );

    expect(result.data).toEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({
          requestId: 'req-debug-2',
          finalProcessingTimestamp: expect.any(Number),
          performanceMetrics: expect.objectContaining({
            totalProcessingTime: expect.any(Number),
          }),
        }),
      })
    );
    expect(result.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'metadata.finalProcessingTimestamp',
        }),
        expect.objectContaining({
          path: 'metadata.performanceMetrics',
        }),
      ])
    );
  });

  it('toggles BidirectionalHookManager debug config through enable/disable helpers', () => {
    disableDebugMode();
    expect(BidirectionalHookManager.getDebugConfig().enabled).toBe(false);

    enableDebugMode('verbose');
    expect(BidirectionalHookManager.getDebugConfig()).toEqual(
      expect.objectContaining({
        enabled: true,
        level: 'verbose',
        maxDataSize: 2048,
      })
    );

    disableDebugMode();
    expect(BidirectionalHookManager.getDebugConfig()).toEqual(
      expect.objectContaining({
        enabled: false,
        level: 'basic',
      })
    );
  });
});
