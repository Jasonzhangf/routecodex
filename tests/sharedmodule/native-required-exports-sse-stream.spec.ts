import { describe, expect, test } from '@jest/globals';
import path from 'node:path';
import { createRequire } from 'node:module';

import { REQUIRED_NATIVE_HOTPATH_EXPORTS } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.js';
import { captureReqInboundResponsesContextSnapshotWithNative } from './helpers/req-inbound-direct-native.js';

const nodeRequire = createRequire(import.meta.url);

describe('native required exports for sse stream helpers', () => {
  test('includes sse stream resolver/process exports and keeps export list deduplicated', () => {
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).toContain('processSseStreamJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).toContain('resolveSseStreamModeJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).toContain('parseSseEventWithConfigJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).toContain('parseSseStreamWithConfigJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).toContain('parseSseStreamChunkWithConfigJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).toContain('buildRespInboundSseErrorDescriptorJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).not.toContain('planProviderResponseServertoolRuntimeActionsJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).not.toContain('resolveProviderResponsePostServertoolEffectJson');
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

  test('packaged native binding exports req_inbound context snapshot helper directly', () => {
    const binding = nodeRequire(
      path.resolve(process.cwd(), 'sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node')
    ) as Record<string, unknown>;
    expect(typeof binding.captureReqInboundResponsesContextSnapshotJson).toBe('function');
  });

  test('native req_inbound capture collapses latest output when an identical tool-call batch repeats', () => {
    const captured = captureReqInboundResponsesContextSnapshotWithNative({
      requestId: 'req_native_dup_batch_1',
      rawRequest: {
        model: 'gpt-5.4',
        tools: [{ type: 'function', function: { name: 'write_stdin', parameters: { type: 'object', properties: {} } } }],
        input: [
          {
            type: 'function_call',
            id: 'call_dup',
            call_id: 'call_dup',
            name: 'write_stdin',
            arguments: '{"session_id":1,"chars":""}',
          },
          {
            type: 'function_call',
            id: 'call_dup',
            call_id: 'call_dup',
            name: 'write_stdin',
            arguments: '{"session_id":1,"chars":""}',
          },
          {
            type: 'function_call_output',
            call_id: 'call_dup',
            output: 'Chunk ID: abc\\nOutput:\\nfirst',
          },
          {
            type: 'function_call_output',
            call_id: 'call_dup',
            output: 'write_stdin failed: Unknown process id 1',
          },
        ],
      },
    });

    const input = Array.isArray(captured.input) ? captured.input : [];
    expect(input).toHaveLength(2);
    expect(input[0]).toMatchObject({ type: 'function_call', call_id: 'call_dup' });
    expect(input[1]).toMatchObject({
      type: 'function_call_output',
      call_id: 'call_dup',
      output: 'write_stdin failed: Unknown process id 1',
    });
  });

  test('native req_inbound capture rewrites auto-injected stop hook pair into text input for next turn', () => {
    const captured = captureReqInboundResponsesContextSnapshotWithNative({
      requestId: 'req_native_stopless_rewrite_1',
      rawRequest: {
        model: 'gpt-5.4',
        tools: [{ type: 'function', function: { name: 'exec_command', parameters: { type: 'object', properties: {} } } }],
        input: [
          {
            type: 'function_call',
            call_id: 'call_servertool_cli_stop_1',
            name: 'exec_command',
            arguments:
              "{\"cmd\":\"routecodex hook run stop_message_auto --input-json '{\\\"flowId\\\":\\\"stop_message_flow\\\",\\\"repeatCount\\\":0,\\\"maxRepeats\\\":3}'\"}",
          },
          {
            type: 'function_call_output',
            call_id: 'call_servertool_cli_stop_1',
            output:
              '{"ok":true,"toolName":"stop_message_auto","continuationPrompt":"你必须补齐 stop schema。","schemaGuidance":{"requiredFields":["stopreason","reason"],"stopreasonValues":{"finished":0,"blocked":1,"continueNeeded":2},"triggerHint":"no_schema"}}',
          },
        ],
      },
    });

    const input = Array.isArray(captured.input) ? captured.input : [];
    expect(input).toHaveLength(3);
    expect(input[0]).toMatchObject({
      type: 'function_call',
      call_id: 'call_servertool_cli_stop_1',
      name: 'reasoningStop',
    });
    expect(input[1]).toMatchObject({
      type: 'function_call_output',
      call_id: 'call_servertool_cli_stop_1',
    });
    expect(input[2]).toMatchObject({
      role: 'user',
      content: [
        expect.objectContaining({
          type: 'input_text',
          text: expect.stringContaining('你必须补齐 stop schema。'),
        }),
      ],
    });
    expect(JSON.stringify(input)).not.toContain('exec_command');
  });

  test('native req_inbound capture preserves user-initiated stop hook tool history', () => {
    const captured = captureReqInboundResponsesContextSnapshotWithNative({
      requestId: 'req_native_stopless_preserve_1',
      rawRequest: {
        model: 'gpt-5.4',
        tools: [{ type: 'function', function: { name: 'exec_command', parameters: { type: 'object', properties: {} } } }],
        input: [
          {
            type: 'function_call',
            call_id: 'call_user_stop_1',
            name: 'exec_command',
            arguments:
              "{\"cmd\":\"routecodex hook run stop_message_auto --input-json '{\\\"flowId\\\":\\\"stop_message_flow\\\",\\\"repeatCount\\\":0,\\\"maxRepeats\\\":3}'\"}",
          },
          {
            type: 'function_call_output',
            call_id: 'call_user_stop_1',
            output:
              '{"ok":true,"toolName":"stop_message_auto","continuationPrompt":"继续。","input":{"flowId":"stop_message_flow","repeatCount":1,"maxRepeats":3,"triggerHint":"no_schema"}}',
          },
        ],
      },
    });

    const input = Array.isArray(captured.input) ? captured.input : [];
    expect(input).toHaveLength(3);
    expect(input[0]).toMatchObject({
      type: 'function_call',
      call_id: 'call_user_stop_1',
      name: 'reasoningStop',
    });
    expect(input[1]).toMatchObject({
      type: 'function_call_output',
      call_id: 'call_user_stop_1',
    });
    expect(input[2]).toMatchObject({
      role: 'user',
      content: [
        expect.objectContaining({
          type: 'input_text',
          text: expect.stringContaining('继续。'),
        }),
      ],
    });
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

  test('responses submit normalization keeps empty function_call_output paired as empty string', () => {
    const binding = nodeRequire(
      path.resolve(process.cwd(), 'sharedmodule/llmswitch-core/dist/native/router_hotpath_napi.node')
    ) as Record<string, unknown>;
    const plan = binding.planResponsesHandlerEntryJson as (
      payloadJson: string,
      entryEndpoint?: string,
      responseIdFromPath?: string
    ) => string;
    const resume = binding.resumeResponsesConversationPayloadJson as (...args: string[]) => string;

    const planned = JSON.parse(
      plan(
        JSON.stringify({
          previous_response_id: 'resp_empty_output_1',
          input: [{ type: 'function_call_output', call_id: 'call_empty_output_1' }],
          model: 'gpt-5.5',
        }),
        '/v1/responses',
        undefined
      )
    ) as {
      payload: {
        tool_outputs?: Array<{ output?: string; tool_call_id?: string }>;
      };
    };
    expect(planned.payload.tool_outputs).toEqual([
      { tool_call_id: 'call_empty_output_1', output: '' },
    ]);

    const resumed = JSON.parse(
      resume(
        JSON.stringify({
          requestId: 'req_empty_output_1',
          basePayload: { model: 'gpt-5.5' },
          input: [
            {
              type: 'function_call',
              id: 'fc_empty_output_1',
              call_id: 'call_empty_output_1',
              name: 'exec_command',
              arguments: '{"cmd":"pwd"}',
            },
          ],
        }),
        'resp_empty_output_1',
        JSON.stringify({
          tool_outputs: [{ call_id: 'call_empty_output_1' }],
        }),
        'req_empty_output_2'
      )
    ) as {
      payload: { input?: Array<{ output?: string; type?: string; call_id?: string }> };
      meta?: { toolOutputsDetailed?: Array<{ outputText?: string; callId?: string }> };
    };
    expect(resumed.payload.input?.[1]).toMatchObject({
      type: 'function_call_output',
      call_id: 'call_empty_output_1',
      output: '',
    });
    expect(resumed.meta?.toolOutputsDetailed).toEqual([
      { callId: 'call_empty_output_1', originalId: 'call_empty_output_1', outputText: '' },
    ]);
  });
});
