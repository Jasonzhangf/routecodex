import { describe, expect, test } from '@jest/globals';
import path from 'node:path';
import { createRequire } from 'node:module';

import { REQUIRED_NATIVE_HOTPATH_EXPORTS } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-router-hotpath-required-exports.js';

const nodeRequire = createRequire(import.meta.url);

describe('native required exports for sse stream helpers', () => {
  test('includes sse stream resolver/process exports and keeps export list deduplicated', () => {
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).toContain('processSseStreamJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).toContain('resolveSseStreamModeJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).toContain('parseSseEventWithConfigJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).toContain('parseSseStreamWithConfigJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).toContain('parseSseStreamChunkWithConfigJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).toContain('extractDecodeStatsJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).toContain('resolveSseTimeoutOptionsJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).toContain('buildRespInboundSseErrorDescriptorJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).toContain('runReqOutboundStage3CompatJson');
    expect(REQUIRED_NATIVE_HOTPATH_EXPORTS).toContain('runRespInboundStage3CompatJson');
    expect(new Set(REQUIRED_NATIVE_HOTPATH_EXPORTS).size).toBe(REQUIRED_NATIVE_HOTPATH_EXPORTS.length);
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
