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

describe('engine-observation-shell', () => {
  test('engine.ts facade stays deleted and orchestration owner remains explicit', () => {
    expect(fs.existsSync('sharedmodule/llmswitch-core/src/servertool/engine.ts')).toBe(false);
    const source = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.ts',
      'utf8'
    );

    expect(source).toContain('export async function runServerToolOrchestrationShell(');
    expect(source).not.toContain('createServertoolObservation({');
    expect(source).toContain('recordServertoolEngineMatchSkipped({');
    expect(source).toContain('recordServertoolEngineMatchHit({');
    expect(source).toContain('runServertoolEnginePostflight');
    expect(source).toContain('runEnginePreflight');
    expect(source).toContain('planServertoolEngineRuntimeActionWithNative');
  });

  test('engine-observation-shell owns match logging fan-in without progress facade', async () => {
    const source = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/servertool/engine-observation-shell.ts',
      'utf8'
    );
    const orchestrationSource = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.ts',
      'utf8'
    );

    expect(source).not.toContain('export function logServertoolNonBlocking(');
    expect(source).not.toContain('[servertool][non-blocking]');
    expect(source).not.toContain('export function createServertoolObservation(');
    expect(source).not.toContain('createServertoolProgressLogger({');
    expect(source).toContain('appendServertoolMatchSkippedProgressEvent({');
    expect(source).not.toContain('appendServerToolProgressFileEvent({');
    expect(source).not.toContain('readProviderProtocolFromAnyBoundMetadataCenter');
    expect(source).not.toContain(
      'Servertool observation requires metadata center runtime_control.providerProtocol'
    );
    expect(source).toContain("args.stageRecorder?.record('servertool.match'");
    expect(fs.existsSync('sharedmodule/llmswitch-core/src/servertool/match-log-block.ts')).toBe(false);
    expect(orchestrationSource).toContain('function createProgressObservation(');
    expect(orchestrationSource).toContain('createServertoolProgressLogger({');
    expect(orchestrationSource).not.toContain('readProviderProtocolFromAnyBoundMetadataCenter');
    expect(orchestrationSource).not.toContain(
      'Servertool engine orchestration requires metadata center runtime_control.providerProtocol'
    );
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
        engineMode: 'passthrough',
        skipReason: 'passthrough',
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

  test('match skipped consumes native skipReason instead of deriving it from engine mode', async () => {
    const mod = await import('../../sharedmodule/llmswitch-core/src/servertool/engine-observation-shell.js');
    const source = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/servertool/engine-observation-shell.ts',
      'utf8'
    );
    const orchestrationSource = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.ts',
      'utf8'
    );
    const adapterContext: Record<string, unknown> = {};
    bindProviderProtocol(adapterContext, 'openai-chat');

    expect(source).not.toContain("args.engineMode === 'passthrough' ? 'passthrough' : 'no_execution'");
    expect(orchestrationSource).not.toContain("engineSkipPlan.skipReason ?? 'no_execution'");
    expect(source).not.toContain('args.skipReason.trim()');
    expect(orchestrationSource).not.toContain('engineSkipPlan.skipReason.trim()');
    expect(orchestrationSource).not.toContain("throw new Error('[servertool] native engine skip plan missing skipReason')");
    expect(orchestrationSource).toContain('const skipReason = engineSkipPlan.skipReason as string;');
    mod.recordServertoolEngineMatchSkipped({
      requestId: 'req-match-skip-native-reason',
      entryEndpoint: '/v1/chat/completions',
      engineMode: 'passthrough',
      skipReason: 'passthrough',
      adapterContext: adapterContext as any
    });
  });

  test('match hit requires execution flowId instead of falling back to unknown', async () => {
    const mod = await import('../../sharedmodule/llmswitch-core/src/servertool/engine-observation-shell.js');

    expect(() =>
      mod.recordServertoolEngineMatchHit({
        requestId: 'req-match-hit-missing-flow',
        execution: {
          toolName: 'reasoningStop',
          toolCall: {
            id: 'call_missing_flow',
            type: 'function',
            function: {
              name: 'reasoningStop',
              arguments: '{}'
            }
          },
          followup: null
        } as any
      })
    ).toThrow('Servertool match hit requires execution.flowId');
  });

  test('postflight stage recorder failures are fail-fast', async () => {
    const mod = await import('../../sharedmodule/llmswitch-core/src/servertool/engine-postflight-shell.js');
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
        logProgress: jest.fn()
      })
    ).rejects.toThrow('postflight recorder down');
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
    expect(source).not.toContain("if (runtimeAction.action === 'return_servertool_cli_projection_final')");
    expect(source).not.toContain("if (runtimeAction.action === 'return_stop_message_terminal_final')");
    expect(source).not.toContain("if (runtimeAction.action === 'build_stop_message_cli_projection')");
    expect(source).toContain('switch (runtimeAction.action)');
    expect(source).not.toContain('const nativeMetadataCenterSnapshot = metadataCenterSnapshot ?? (');
    expect(source).not.toContain('runtimeControl ? { runtimeControl } : null');
    expect(source).toContain('metadataCenterSnapshot: metadataCenterSnapshot ?? null');

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
      logProgress: jest.fn()
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
    expect(source).not.toMatch(/export interface ServerToolOrchestrationOptions\s*\{[\s\S]{0,220}providerProtocol:\s*string;/);
    expect(source).not.toContain('readProviderProtocolFromAnyBoundMetadataCenter');
    expect(source).not.toContain('providerProtocol: args.providerProtocol');
    expect(source).toContain('createProgressObservation({');
    expect(source).toContain('runEnginePreflight({');
    expect(source).not.toContain("if (preflight.kind === 'return_original_chat' || preflight.kind === 'return_original_chat_direct_passthrough')");
    expect(source).toContain('switch (preflightKind)');
    expect(source).toContain('planServertoolEngineSkipWithNative({');
    expect(source).toContain('switch (engineSkipAction)');
    expect(source).not.toContain("engineSkipPlan.action === 'return_skipped_passthrough' ||");
    expect(source).not.toContain("engineSkipPlan.action === 'return_skipped_no_execution'");
    expect(source).not.toContain('Boolean(engineResult.execution)');
    expect(source).toContain('hasExecution: engineResult.execution != null');
    expect(source).not.toContain("throw new Error('[servertool] native engine skip plan missing skipReason')");
    expect(source).toContain('const skipReason = engineSkipPlan.skipReason as string;');
    expect(source).toContain('planServertoolTimeoutErrorWithNative({');
    expect(source).toContain('createServertoolProviderProtocolErrorFromPlan(');
    expect(source).toContain('recordServertoolEngineMatchSkipped({');
    expect(source).toContain('recordServertoolEngineMatchHit({');
    expect(source).toContain('const stoplessExecutionPlan = planStoplessExecutionWithNative({');
    expect(source).toContain('const runtimeAction = planServertoolEngineRuntimeActionWithNative({');
    expect(source).not.toContain('function planStoplessEngineRuntime(');
    expect(source).not.toContain('const stoplessExecutionInput = {');
    expect(source).toContain('runServertoolEnginePostflight({');
    expect(source).not.toContain('effectiveServerToolTimeoutMs');
    expect(source).not.toContain('args.effectiveServerToolTimeoutMs || args.serverToolTimeoutMs');
    expect(source).not.toContain('function createServerToolEngineRunner(');
    expect(source).not.toContain('createServerToolTimeoutError(');
  });
});
