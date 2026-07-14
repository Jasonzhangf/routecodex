import {
  disableDebugMode,
  enableDebugMode,
  httpRequestMonitoringHook,
  requestMonitoringHook,
  responsePostProcessingMonitoringHook,
} from '../../../../src/providers/core/hooks/debug-example-hooks.js';
import { describe, expect, it, jest } from '@jest/globals';
import { HookStage, BidirectionalHookManager } from '../../../../src/providers/core/config/provider-debug-hooks.js';
import {
  formatDataForOutput,
  outputDebugInfo,
} from '../../../../src/providers/core/config/provider-debug-output-utils.js';

describe('provider.debug_example_hooks_surface', () => {
  afterEach(() => {
    disableDebugMode();
  });

  it('records response debug metadata observations without changing the payload in read()', () => {
    const now = Date.now();
    const result = responsePostProcessingMonitoringHook.read!(
      {
        data: {
          status: 200,
          _debugMetadata: {
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
        '📋 响应包含调试元数据',
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

  it('writes finalProcessingTimestamp into debug metadata during transform()', () => {
    const before = Date.now() - 50;
    const result = responsePostProcessingMonitoringHook.transform!(
      {
        data: {
          status: 200,
          _debugMetadata: {
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
        _debugMetadata: expect.objectContaining({
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
          path: '_debugMetadata.finalProcessingTimestamp',
        }),
        expect.objectContaining({
          path: '_debugMetadata.performanceMetrics',
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

  it('estimates request debug metrics without serializing the full request payload', () => {
    const originalStringify = JSON.stringify;
    const request = {
      model: 'copy-budget-model',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'function', function: { name: 'tool_1', parameters: { type: 'object' } } }],
    };
    JSON.stringify = jest.fn(() => {
      throw new Error('full payload serialization is forbidden in debug hook size metrics');
    }) as typeof JSON.stringify;
    try {
      const result = httpRequestMonitoringHook.read!(
        {
          data: request,
          metadata: {
            dataType: 'request',
            size: 512,
            changes: [],
            timestamp: Date.now(),
            executionId: 'exec-debug-copy-budget',
          },
        },
        {
          stage: HookStage.HTTP_REQUEST,
          changeCount: 0,
          startTime: Date.now(),
          debugEnabled: true,
          executionId: 'exec-debug-copy-budget',
        } as any
      );

      expect(result.metrics).toEqual(
        expect.objectContaining({
          estimatedHeadersSize: expect.any(Number),
        })
      );
    } finally {
      JSON.stringify = originalStringify;
    }
  });

  it('keeps hook input borrowed while debug dataFlow records only a bounded diagnostic snapshot', async () => {
    disableDebugMode();
    const tools = Array.from({ length: 40 }, (_, index) => ({
      type: 'function',
      function: {
        name: `tool_${index}`,
        parameters: {
          type: 'object',
          properties: {
            payload: {
              type: 'string',
              description: 'x'.repeat(200),
            },
          },
        },
      },
    }));
    const request: Record<string, unknown> = {
      model: 'copy-budget-model',
      messages: [{ role: 'user', content: 'hello' }],
      tools,
      bigint: BigInt(1),
    };
    request.self = request;

    let hookSawFullTools = false;
    BidirectionalHookManager.registerHook({
      ...requestMonitoringHook,
      name: 'request-monitoring-copy-budget-observer',
      stage: HookStage.FINALIZATION,
      target: 'config',
      priority: 1000,
      read(data, context) {
        hookSawFullTools = Array.isArray((data.data as Record<string, unknown>).tools)
          && ((data.data as Record<string, unknown>).tools as unknown[]).length === tools.length
          && context.debugEnabled === true;
        return {
          observations: ['copy-budget-observed'],
        };
      },
    });
    BidirectionalHookManager.setDebugConfig({
      enabled: true,
      level: 'basic',
      maxDataSize: 128,
      stages: [HookStage.FINALIZATION],
      outputTargets: [],
    });

    const result = await BidirectionalHookManager.executeHookChain(
      HookStage.FINALIZATION,
      'config',
      request,
      {} as any
    );

    const snapshot = result.debug.dataFlow[0]?.data as Record<string, unknown> | undefined;
    const snapshotTools = snapshot?.tools as unknown[] | undefined;
    expect(result.data).toBe(request);
    expect(hookSawFullTools).toBe(true);
    expect(snapshot).toBeDefined();
    expect(snapshot).not.toBe(request);
    expect(snapshot?.self).toBe('[CIRCULAR]');
    expect(snapshot?.bigint).toEqual({ __type: 'bigint', value: '1' });
    expect(Array.isArray(snapshotTools)).toBe(true);
    expect(snapshotTools!.length).toBeLessThan(tools.length);
    expect(snapshotTools![0]).not.toBe(tools[0]);
  });

  it('formats oversized debug output with a bounded preview instead of full JSON serialization', () => {
    const payload: Record<string, unknown> = {
      messages: [{ role: 'user', content: 'large debug payload' }],
      secretToolList: Array.from({ length: 100 }, (_, index) => ({ name: `tool_${index}` })),
    };
    payload.self = payload;

    const formatted = formatDataForOutput(
      payload,
      {
        level: 'detailed',
        maxDataSize: 1,
      },
      () => 1024
    );

    expect(formatted).toEqual(
      expect.objectContaining({
        __truncated: true,
        __originalSize: 1024,
        __preview: expect.any(String),
      })
    );
    expect((formatted as Record<string, unknown>).__preview).toContain('[CIRCULAR]');
  });

  it('formats change details from a bounded projection instead of serializing a complete newValue', () => {
    const newValue: Record<string, unknown> = {
      tools: Array.from({ length: 100 }, (_, index) => ({
        name: `tool_${index}`,
        description: 'x'.repeat(200),
      })),
    };
    newValue.self = newValue;
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(() => outputDebugInfo({
        hook: {
          name: 'copy-budget-change',
          stage: HookStage.FINALIZATION,
        },
        dataPacket: {
          data: {},
          metadata: {
            size: 1024,
          },
        },
        changes: [{
          type: 'modified',
          path: 'tools',
          newValue,
        }],
        observations: [],
        debugConfig: {
          level: 'basic',
          maxDataSize: 128,
        },
        formatDataForOutput: data => data,
      })).not.toThrow();

      const detailLine = log.mock.calls
        .map(call => String(call[0]))
        .find(line => line.includes('modified: tools ='));
      expect(detailLine).toBeDefined();
      expect(detailLine!.length).toBeLessThan(320);
      expect(detailLine).not.toContain('tool_99');
    } finally {
      log.mockRestore();
    }
  });

  it('does not reintroduce full-payload debug hook serialization or JSON round-trip clones', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    for (const relative of [
      'src/debug/hooks/bidirectional.ts',
      'src/debug/hooks/example-hooks.ts',
      'src/providers/core/config/provider-debug-output-utils.ts',
    ]) {
      const source = fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');
      expect(source).not.toContain('JSON.parse(JSON.stringify');
      expect(source).not.toContain('JSON.stringify(request).length');
      expect(source).not.toContain('cloneData(');
    }
  });
});
