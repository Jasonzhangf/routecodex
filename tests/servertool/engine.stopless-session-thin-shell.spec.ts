import * as fs from 'node:fs';
import { describe, expect, test } from '@jest/globals';
import { runServerToolOrchestrationShell as runServerToolOrchestration } from '../../sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.js';
import { MetadataCenter } from '../../src/server/runtime/http-server/metadata-center/metadata-center.js';

describe('engine stopless session thin-shell guard', () => {
  test('runServerToolOrchestration does not locally normalize stopless session ids', () => {
    const source = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.ts',
      'utf8'
    );

    expect(source).not.toContain('function normalizeStoplessSessionToken(');
    expect(source).not.toContain('function readStoplessSessionId(');
    expect(source).not.toContain('const preflightChat = (preflight as { chat?: JsonObject }).chat');
    expect(source).not.toContain('const preflightStopSignal = (preflight as { stopSignal?: typeof stopSignal }).stopSignal');
    expect(source).not.toContain('chat: preflightChat as JsonObject');
    expect(source).not.toContain('stopSignal = preflightStopSignal as typeof stopSignal');
    expect(source).not.toContain('const requestTruth = metadataCenterSnapshot?.requestTruth');
    expect(source).not.toContain('const rawSessionId = requestTruth?.sessionId');
    expect(source).not.toContain('requestTruthSessionId,');
    expect(source).not.toContain('options.adapterContext as Record<string, unknown>');
    expect(source).not.toContain('options.adapterContext as unknown as Record<string, unknown>');
    expect(source).not.toContain('engineResult.execution as unknown as Record<string, unknown>');
    expect(source).not.toContain('runtimeControl as Record<string, unknown>');
    expect(source).not.toContain('runtimeControl != null && typeof runtimeControl ===');
    expect(source).not.toContain('runtimeMetadataSnapshot?.metadataCenterSnapshot as Record<string, unknown>');
    expect(source).toContain('metadataCenterSnapshot: metadataCenterSnapshot ?? null');
    expect(source).toContain('runtimeControl: runtimeControl ?? null');
    expect(source).toContain('adapterContext: options.adapterContext');
  });

  test('runServerToolOrchestration delegates stopless session projection into the postflight shell', () => {
    const source = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/servertool/engine-postflight-shell.ts',
      'utf8'
    );

    expect(source).toContain('switch (runtimeAction.finalPayloadSource)');
    expect(source).toContain("case 'stop_message_cli_projection'");
  });

  test('runServerToolOrchestration does not locally derive stopless CLI projection context', () => {
    const source = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/servertool/engine-postflight-shell.ts',
      'utf8'
    );

    expect(source).not.toContain('const triggerHint = [');
    expect(source).not.toContain('const schemaFeedbackCandidate = [');
    expect(source).not.toContain('const repeatCount =');
    expect(source).not.toContain('const maxRepeats =');
    expect(source).not.toContain("||\n      '继续推进当前任务。'");
  });

  test('runServerToolOrchestration routes post-engine branches through native runtime action planning', () => {
    const source = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.ts',
      'utf8'
    );

    expect(source).toContain('planServertoolEngineRuntimeActionWithNative');
    expect(source).not.toContain('if (engineResult.pendingInjection)');
    expect(source).not.toContain('const preflightKind = preflight.kind');
    expect(source).not.toContain('switch (preflightKind)');
    expect(source).toContain('planServertoolEngineOrchestrationPreflightActionWithNative({');
    expect(source).toContain('switch (preflightOrchestrationAction.action)');
    expect(source).toContain('chat: preflight.chat');
    expect(source).toContain('stopSignal = preflight.stopSignal');
    expect(source).not.toContain('String(preflightOrchestrationAction.action)');
    expect(source).not.toContain("if (stoplessPlan.action === 'terminal_final')");
    expect(source).not.toContain("if (stoplessPlan.action === 'cli_projection' && stoplessPlan.isStopMessageFlow)");
    expect(source).not.toContain('!stoplessPlan.isStopMessageFlow &&');
    expect(source).toContain('const stoplessExecutionPlan = planStoplessExecutionWithNative({');
    expect(source).toContain('const runtimeAction = planServertoolEngineRuntimeActionWithNative({');
    expect(source).toContain('planServertoolEngineTriggerObservationWithNative({');
    expect(source).not.toContain('if (stopSignal.observed) {');
    expect(source).not.toContain('function planStoplessEngineRuntime(');
    expect(source).not.toContain('const stoplessExecutionInput = {');
    expect(source).not.toContain('const hasServertoolCliProjectionContext =');
    expect(source).not.toContain('hasServertoolCliProjectionContext:');
    expect(source).toContain('stoplessExecutionFlowId:');
    expect(source).not.toContain('const postflightEngineResult = {');
    expect(source).toContain('engineResult: {');
  });

  test('runServerToolOrchestration routes synthetic/direct preflight through native planning', () => {
    const source = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/servertool/engine-preflight-shell.ts',
      'utf8'
    );

    expect(source).toContain('planServertoolEnginePreflightWithNative');
    expect(source).toContain('function runPreflightSideEffects(');
    expect(source).toContain('inspectStopGatewaySignal(');
    expect(source).toContain('attachStopGatewayContext(');
    expect(source).toContain('containsSyntheticRouteCodexControlTextWithNative(');
    expect(source).toContain("case 'return_original_chat'");
    expect(source).toContain("case 'return_original_chat_direct_passthrough'");
    expect(source).toContain("case 'continue_to_engine'");
    expect(source).toContain('preflightAction.attachStopGatewayContext === true');
    expect(source).toContain('preflightAction.logStopEntry');
    expect(source).toContain('preflightAction.logStopCompare');
    expect(source).not.toContain('preflightAction.logStopEntry.stage');
    expect(source).not.toContain('preflightAction.logStopEntry.result');
    expect(source).not.toContain('stopSignal.observed && preflightAction.action');
    expect(source).not.toContain('if (stopSignal.observed) {');
    expect(source).not.toContain("if (preflightAction.action === 'return_original_chat')");
    expect(source).not.toContain("if (preflightAction.action === 'return_original_chat_direct_passthrough')");
  });

  test('runServerToolOrchestration routes passthrough/no-execution skip through native planning', () => {
    const source = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.ts',
      'utf8'
    );

    expect(source).toContain('planServertoolEngineSkipWithNative');
    expect(source).toContain('switch (engineSkipPlan.action)');
    expect(source).not.toContain('const engineSkipAction = engineSkipPlan.action as');
    expect(source).not.toContain("engineSkipPlan.action === 'return_skipped_passthrough' ||");
    expect(source).not.toContain("engineSkipPlan.action === 'return_skipped_no_execution'");
    expect(source).not.toContain('Boolean(engineResult.execution)');
    expect(source).not.toContain("engineResult.execution && typeof engineResult.execution === 'object'");
    expect(source).toContain("engineResult.execution != null && typeof engineResult.execution === 'object'");
    expect(source).not.toContain("runtimeControl && typeof runtimeControl === 'object'");
    expect(source).not.toContain("runtimeControl != null && typeof runtimeControl === 'object'");
    expect(source).toContain('runtimeControl: runtimeControl ?? null');
    expect(source).not.toContain("if (engineResult.mode === 'passthrough' || !engineResult.execution)");
  });

  test('stopless cli projection is not short-circuited by generic servertoolCliProjection context', async () => {
    const adapterContext = {
      requestId: 'req_stopless_engine_short_circuit',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      sessionId: 'sess-stopless-engine-short-circuit',
      routecodexPortStopMessageEnabled: true,
      stopMessageEnabled: true,
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: '继续执行 stopless 红测' }]
      },
      __rt: {
        stopMessageState: {
          stopMessageText: '继续执行原任务',
          stopMessageMaxRepeats: 3,
          stopMessageUsed: 1,
          stopMessageStageMode: 'on'
        }
      }
    } as any;
    const metadataCenter = MetadataCenter.attach(adapterContext);
    metadataCenter.writeRuntimeControl(
      'providerProtocol',
      'openai-responses',
      {
        module: 'tests.servertool.engine.stopless-session-thin-shell',
        symbol: 'stopless cli projection sample',
        stage: 'test'
      },
      'test control provider protocol'
    );

    const result = await runServerToolOrchestration({
      chat: {
        id: 'chatcmpl_stopless_engine_short_circuit',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '阶段完成：schema 缺失。'
            },
            finish_reason: 'stop'
          }
        ]
      },
      adapterContext,
      requestId: 'req_stopless_engine_short_circuit',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => {
        throw new Error('stopless cli projection must not reenter followup');
      }
    });

    expect(result.executed).toBe(true);
    expect((result.chat as any)?.choices?.[0]?.message?.tool_calls).toBeUndefined();
  });
});
