import { describe, expect, test } from '@jest/globals';
import {
  executeServertoolBackendPlan,
  materializeServertoolPlannedResult
} from '../../sharedmodule/llmswitch-core/src/servertool/execution-shell.js';
import type { ServerSideToolEngineOptions } from '../../sharedmodule/llmswitch-core/src/servertool/types.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';

function buildOptions(overrides: Partial<ServerSideToolEngineOptions> = {}): ServerSideToolEngineOptions {
  return {
    chatResponse: {
      id: 'chatcmpl-backend-failfast',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'tool_calls' }]
    } as JsonObject,
    adapterContext: {
      requestId: 'req-backend-failfast',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    } as any,
    entryEndpoint: '/v1/responses',
    requestId: 'req-backend-failfast',
    providerProtocol: 'openai-responses',
    ...overrides
  };
}

describe('execution-shell backend failfast', () => {
  test('handler plan without finalize fails fast instead of being treated as a materialized result', async () => {
    await expect(
      materializeServertoolPlannedResult(
        {
          flowId: 'broken_plan_without_finalize'
        } as any,
        buildOptions()
      )
    ).rejects.toThrow('[servertool] invalid handler plan contract: missing finalize');
  });

  test('vision_analysis backend plan fails fast when reenterPipeline is unavailable', async () => {
    await expect(
      executeServertoolBackendPlan(
        {
          kind: 'vision_analysis',
          requestIdSuffix: ':vision',
          entryEndpoint: '/v1/chat/completions',
          payload: { model: 'gpt-test', messages: [] }
        },
        buildOptions()
      )
    ).rejects.toThrow('[servertool] vision_analysis backend requires reenterPipeline');
  });

  test('unknown backend kind fails fast instead of silently returning undefined', async () => {
    await expect(
      executeServertoolBackendPlan(
        {
          kind: 'unknown_backend_kind',
          requestIdSuffix: ':unknown'
        } as any,
        buildOptions()
      )
    ).rejects.toThrow('[servertool] unsupported backend plan kind: unknown_backend_kind');
  });
});
