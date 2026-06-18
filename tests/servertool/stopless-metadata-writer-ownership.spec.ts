import { describe, expect, test } from '@jest/globals';

import { runServerSideToolEngine } from '../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';
import { MetadataCenter } from '../../src/server/runtime/http-server/metadata-center/metadata-center.ts';

describe('stopless metadata writer ownership', () => {
  test('server-side-tools does not rewrite stopless runtime control from precommand routing state', async () => {
    const metadata: Record<string, unknown> = {
      __rt: {
        stopMessageState: {
          stopMessageText: '继续推进当前任务。',
          stopMessageMaxRepeats: 3,
          stopMessageUsed: 1
        }
      }
    };
    const metadataCenter = MetadataCenter.attach(metadata);

    const adapterContext: AdapterContext = {
      requestId: 'req-stopless-writer-owner',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      sessionId: 'sess-stopless-writer-owner',
      metadata,
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: '继续执行' }]
      }
    } as any;

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stopless-writer-owner',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'done'
          },
          finish_reason: 'stop'
        }
      ]
    };

    await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-stopless-writer-owner',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => ({ body: {} as JsonObject })
    });

    const stoplessHistory = metadataCenter.snapshot().runtimeControl.stopless?.history ?? [];
    expect(
      stoplessHistory.some((entry) => entry.reason === 'seed-from-routing-state')
    ).toBe(false);
  });
});
