import { describe, expect, test } from '@jest/globals';
import path from 'node:path';
import { createRequire } from 'node:module';

import { REQUIRED_NATIVE_HOTPATH_EXPORTS } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.js';

const nodeRequire = createRequire(import.meta.url);

describe('native required exports for sse stream helpers', () => {
  test('includes sse stream resolver/process exports and keeps export list deduplicated', () => {
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).toContain('processSseStreamJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).toContain('resolveSseStreamModeJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).toContain('parseSseEventWithConfigJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).toContain('parseSseStreamWithConfigJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).toContain('parseSseStreamChunkWithConfigJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).toContain('buildRespInboundSseErrorDescriptorJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).toContain('planProviderResponseServertoolRuntimeActionsJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).toContain('runReqOutboundStage3CompatJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).toContain('runRespInboundStage3CompatJson');
    expect(new Set(REQUIRED_NATIVE_HOTPATH_EXPORTS).size).toBe(REQUIRED_NATIVE_HOTPATH_EXPORTS.length);
  });

  test('does not require retired legacy HubPipeline stage export', () => {
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).not.toContain('runHubPipelineStageJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).toContain('runHubPipelineLibJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).toContain('executeHubPipelineJson');
  });

  test('required export list matches the packaged native binding', () => {
    const binding = nodeRequire(
      path.resolve(process.cwd(), 'sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node')
    ) as Record<string, unknown>;
    const missing = REQUIRED_NATIVE_HOTPATH_EXPORTS.filter((key) => typeof binding[key] !== 'function');
    expect(missing).toEqual([]);
  });

  test('does not require removed apply_patch legacy export', () => {
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).not.toContain('augmentApplyPatchErrorContentJson');
  });

  test('does not require retired standalone SSE stats/timeout helper exports', () => {
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).not.toContain('extractDecodeStatsJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).not.toContain('resolveSseTimeoutOptionsJson');
  });

  test('does not require retired req_inbound standalone helper exports', () => {
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).not.toContain('mapResumeToolOutputsDetailedJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).not.toContain('resolveClientInjectReadyJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).not.toContain('normalizeContextCaptureLabelJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).not.toContain('shouldRunHubChatProcessJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).not.toContain('isShellLikeToolNameTokenJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).not.toContain('resolveServerToolFollowupSnapshotJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).not.toContain('augmentContextSnapshotJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).not.toContain('normalizeToolCallIdStyleCandidateJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).not.toContain('normalizeReqInboundReasoningPayloadJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).not.toContain('shouldNormalizeReasoningPayloadJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).not.toContain('normalizeReasoningPayloadV2Json');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).not.toContain('applyReqInboundSemanticLiftJson');
  });

  test('does not require retired servertool continuation helper exports', () => {
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).not.toContain('buildContinueExecutionOperationsJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).not.toContain('planContinueExecutionOperationsJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).not.toContain('injectContinueExecutionDirectiveJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).not.toContain('isStopMessageStateActiveJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).not.toContain('resolveHasActiveStopMessageForContinueExecutionJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).not.toContain('isCanonicalChatCompletionPayloadJson');
  });

  test('native resume helper returns protocol error envelope instead of napi generic failure', () => {
    const binding = nodeRequire(
      path.resolve(process.cwd(), 'sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node')
    ) as Record<string, unknown>;
    const fn = binding.resumeResponsesConversationPayloadJson as (...args: string[]) => string;
    const raw = fn(
      JSON.stringify({
        requestId: 'req_native_resume_bad_id_1',
        basePayload: { model: 'gpt-5.5' },
        input: [{ type: 'function_call', id: 'fc_expected', call_id: 'call_expected', name: 'exec_command', arguments: '{"cmd":"pwd"}' }]
      }),
      'resp_native_resume_bad_id_1',
      JSON.stringify({ tool_outputs: [{ call_id: 'call_function_snr978zyv21w_1', output: '/tmp' }] }),
      'req_native_resume_bad_id_2'
    );
    const parsed = JSON.parse(raw) as { error?: { type?: string; message?: string; status?: number; origin?: string } };
    expect(parsed.error?.type).toBe('orphan_tool_result');
    expect(parsed.error?.origin).toBe('client');
    expect(parsed.error?.status).toBe(400);
    expect(parsed.error?.message).toContain('call_function_snr978zyv21w_1');
  });
});
