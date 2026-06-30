import * as fs from 'node:fs';
import { describe, expect, test, jest } from '@jest/globals';
import { MetadataCenter } from '../../src/server/runtime/http-server/metadata-center/metadata-center.js';

function bindProviderProtocol(adapterContext: Record<string, unknown>, providerProtocol = 'openai-responses'): void {
  const center = MetadataCenter.attach(adapterContext);
  if (!center.readRuntimeControl().providerProtocol) {
    center.writeRuntimeControl(
      'providerProtocol',
      providerProtocol,
      {
        module: 'tests/servertool/engine-observation-shell.spec.ts',
        symbol: 'bindProviderProtocol',
        stage: 'test'
      }
    );
  }
}

const createServertoolProgressLoggerMock = jest.fn(() => ({
  logStopEntry: jest.fn(),
  logProgress: jest.fn(),
  logAutoHookTrace: jest.fn(),
  logStopCompare: jest.fn()
}));

jest.unstable_mockModule('../../sharedmodule/llmswitch-core/src/servertool/progress-log-block.js', () => ({
  createServertoolProgressLogger: createServertoolProgressLoggerMock
}));

describe('engine-observation-shell', () => {
  test('engine.ts delegates orchestration into engine-orchestration-shell', () => {
    const source = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/servertool/engine.ts',
      'utf8'
    );

    expect(source).toContain("from './engine-orchestration-shell.js'");
    expect(source).toContain('runServerToolOrchestration');
    expect(source).not.toContain('createServertoolObservation({');
    expect(source).not.toContain('recordServertoolEngineMatchSkipped({');
    expect(source).not.toContain('recordServertoolEngineMatchHit({');
    expect(source).not.toContain('runServertoolEnginePostflight');
    expect(source).not.toContain('runEnginePreflight');
    expect(source).not.toContain('planServertoolEngineRuntimeActionWithNative');
  });

  test('engine-observation-shell owns progress logger and match logging fan-in', async () => {
    const source = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/servertool/engine-observation-shell.ts',
      'utf8'
    );

    expect(source).toContain('export function logServertoolNonBlocking(');
    expect(source).toContain('export function createServertoolObservation(');
    expect(source).toContain('createServertoolProgressLogger({');
    expect(source).toContain("args.stageRecorder?.record('servertool.match'");
    expect(source).toContain('appendServerToolProgressFileEvent({');
    expect(fs.existsSync('sharedmodule/llmswitch-core/src/servertool/match-log-block.ts')).toBe(false);

    const progressSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const mod = await import('../../sharedmodule/llmswitch-core/src/servertool/engine-observation-shell.js');
    mod.logServertoolNonBlocking('unit_test', new Error('boom'), { flowId: 'flow_obs_1' });
    expect(progressSpy).toHaveBeenCalledWith(
      expect.stringContaining('[servertool][non-blocking] stage=unit_test error=boom flowId=flow_obs_1')
    );
    progressSpy.mockRestore();
  });

  test('createServertoolObservation prefers bound metadata center providerProtocol over explicit argument', async () => {
    const mod = await import('../../sharedmodule/llmswitch-core/src/servertool/engine-observation-shell.js');
    const adapterContext: Record<string, unknown> = {};
    bindProviderProtocol(adapterContext, 'anthropic-messages');

    const observation = mod.createServertoolObservation({
      requestId: 'req-obs-center-protocol',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'openai-chat',
      adapterContext: adapterContext as any
    });

    expect(createServertoolProgressLoggerMock).toHaveBeenCalledWith(expect.objectContaining({
      providerProtocol: 'anthropic-messages'
    }));
    expect(observation.logProgress).toBeDefined();
  });

  test('createServertoolObservation fails fast when metadata center runtimeControl.providerProtocol is absent', async () => {
    const mod = await import('../../sharedmodule/llmswitch-core/src/servertool/engine-observation-shell.js');

    expect(() => mod.createServertoolObservation({
      requestId: 'req-obs-missing-protocol',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'openai-chat',
      adapterContext: {} as any
    })).toThrow('Servertool observation requires metadata center runtime_control.providerProtocol');
  });

  test('match stage recorder failures are fail-fast', async () => {
    const mod = await import('../../sharedmodule/llmswitch-core/src/servertool/engine-observation-shell.js');
    const adapterContext: Record<string, unknown> = {};
    bindProviderProtocol(adapterContext, 'openai-chat');
    const stageRecorder = {
      record: jest.fn(() => {
        throw new Error('stage recorder down');
      })
    };

    expect(() =>
      mod.recordServertoolEngineMatchSkipped({
        requestId: 'req-match-skip-failfast',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        engineMode: 'passthrough',
        adapterContext: adapterContext as any,
        stageRecorder: stageRecorder as any
      })
    ).toThrow('stage recorder down');

    expect(() =>
      mod.recordServertoolEngineMatchHit({
        requestId: 'req-match-hit-failfast',
        execution: {
          flowId: 'flow-match-hit',
          toolName: 'reasoningStop',
          toolCall: {
            id: 'call_match_hit',
            type: 'function',
            function: {
              name: 'reasoningStop',
              arguments: '{}'
            }
          },
          followup: null
        } as any,
        stageRecorder: stageRecorder as any
      })
    ).toThrow('stage recorder down');
  });

  test('postflight stage recorder failures are fail-fast', async () => {
    const mod = await import('../../sharedmodule/llmswitch-core/src/servertool/engine-postflight-shell.js');
    const logNonBlocking = jest.fn();
    const stageRecorder = {
      record: jest.fn(() => {
        throw new Error('postflight recorder down');
      })
    };

    await expect(
      mod.runServertoolEnginePostflight({
        options: {
          requestId: 'req-postflight-failfast',
          adapterContext: {} as any
        },
        engineResult: {
          mode: 'tool_flow',
          finalChatResponse: {
            tool_outputs: [
              {
                tool_name: 'reasoningStop',
                tool_call_id: 'call_postflight_failfast',
                content: 'ok'
              }
            ]
          },
          execution: {
            flowId: 'flow-postflight-failfast',
            followup: null
          }
        } as any,
        runtimeAction: {
          action: 'return_servertool_cli_projection_final'
        },
        flowId: 'flow-postflight-failfast',
        totalSteps: 5,
        stageRecorder: stageRecorder as any,
        logProgress: jest.fn(),
        logNonBlocking
      })
    ).rejects.toThrow('postflight recorder down');
    expect(logNonBlocking).not.toHaveBeenCalled();
  });

  test('postflight observation summary is native-owned', async () => {
    const source = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/servertool/engine-postflight-shell.ts',
      'utf8'
    );
    expect(source).toContain('buildServertoolPostflightObservationSummaryWithNative({');
    expect(source).not.toContain('const followupSummary: Record<string, unknown> = {');
    expect(source).not.toContain("if ('payload' in followup)");
    expect(source).not.toContain('followup.injection?.ops');

    const mod = await import('../../sharedmodule/llmswitch-core/src/servertool/engine-postflight-shell.js');
    const stageRecorder = {
      record: jest.fn()
    };
    await mod.runServertoolEnginePostflight({
      options: {
        requestId: 'req-postflight-native-summary',
        adapterContext: {} as any
      },
      engineResult: {
        mode: 'tool_flow',
        finalChatResponse: {
          tool_outputs: [
            {
              tool_name: 'reasoningStop',
              tool_call_id: 'call_postflight_summary',
              content: 'ok'
            }
          ]
        },
        execution: {
          flowId: 'flow-postflight-summary',
          followup: {
            injection: {
              ops: [{ op: 'append' }, { op: 1 }]
            }
          }
        }
      } as any,
      runtimeAction: {
        action: 'return_servertool_cli_projection_final'
      },
      flowId: 'flow-postflight-summary',
      totalSteps: 5,
      stageRecorder: stageRecorder as any,
      logProgress: jest.fn(),
      logNonBlocking: jest.fn()
    });

    expect(stageRecorder.record).toHaveBeenCalledWith(
      'servertool.execution',
      expect.objectContaining({
        mode: 'tool_flow',
        flowId: 'flow-postflight-summary',
        hasFollowup: true,
        toolOutputCount: 1,
        toolName: 'reasoningStop',
        toolCallId: 'call_postflight_summary',
        toolOutputContent: 'ok',
        followup: {
          mode: 'injection',
          injectionOps: ['append']
        }
      })
    );
  });

  test('engine-orchestration-shell owns the engine mainline body', () => {
    const source = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.ts',
      'utf8'
    );

    expect(source).toContain('export async function runServerToolOrchestrationShell(');
    expect(source).toContain('createServertoolObservation({');
    expect(source).toContain('runEnginePreflight({');
    expect(source).toContain('planServertoolEngineSkipWithNative({');
    expect(source).toContain('recordServertoolEngineMatchSkipped({');
    expect(source).toContain('recordServertoolEngineMatchHit({');
    expect(source).toContain('planStoplessExecutionWithNative({');
    expect(source).toContain('runServertoolEnginePostflight({');
  });
});
