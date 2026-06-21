import * as fs from 'node:fs';
import { describe, expect, test } from '@jest/globals';
import { runServerToolOrchestration } from '../../sharedmodule/llmswitch-core/src/servertool/engine.js';
import { MetadataCenter } from '../../src/server/runtime/http-server/metadata-center/metadata-center.js';

describe('engine stopless session thin-shell guard', () => {
  test('runServerToolOrchestration does not locally normalize stopless session ids', () => {
    const source = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/servertool/engine.ts',
      'utf8'
    );

    expect(source).not.toContain('function normalizeStoplessSessionToken(');
    expect(source).not.toContain('function readStoplessSessionId(');
    expect(source).toContain('adapterContext: options.adapterContext');
    expect(source).toContain('...(stoplessPlan.sessionId ? { sessionId: stoplessPlan.sessionId } : {}),');
  });

  test('stopless cli projection is not short-circuited by generic servertoolCliProjection context', async () => {
    const adapterContext = {
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
    MetadataCenter.attach(adapterContext);

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

    const toolCall = (result.chat as any)?.choices?.[0]?.message?.tool_calls?.[0];
    expect(toolCall?.function?.name).toBe('exec_command');
    expect(String(toolCall?.function?.arguments || '')).toContain('routecodex hook run reasoning_stop');
  });
});
