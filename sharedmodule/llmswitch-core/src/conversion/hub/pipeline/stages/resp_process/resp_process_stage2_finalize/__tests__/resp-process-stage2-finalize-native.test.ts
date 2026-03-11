import { describe, expect, it } from '@jest/globals';

import { runRespProcessStage2Finalize } from '../index.js';

describe('resp-process-stage2-finalize native wrapper', () => {
  it('native finalize handles keep passthrough, drop normalization, and anthropic endpoint normalization', async () => {
    const keepResult = await runRespProcessStage2Finalize({
      payload: {
        choices: [
          {
            message: {
              content: 'visible <think>internal</think> answer'
            }
          }
        ]
      } as any,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-stage2-keep',
      wantsStream: false,
      reasoningMode: 'keep'
    });

    expect((keepResult.finalizedPayload as any).choices[0].message.content).toBe('visible <think>internal</think> answer');
    expect((keepResult.finalizedPayload as any).choices[0].message.reasoning_content).toBeUndefined();

    const dropResult = await runRespProcessStage2Finalize({
      payload: {
        choices: [
          {
            message: {
              content: 'visible <think>internal</think> answer'
            }
          }
        ]
      } as any,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-stage2-drop',
      wantsStream: false,
      reasoningMode: 'drop'
    });

    expect((dropResult.finalizedPayload as any).choices[0].message.content).toBe('visible  answer');
    expect((dropResult.finalizedPayload as any).choices[0].message.reasoning_content).toBeUndefined();

    const anthropicResult = await runRespProcessStage2Finalize({
      payload: {
        choices: [
          {
            message: {
              content: 'visible <reflection>internal</reflection> answer'
            }
          }
        ]
      } as any,
      entryEndpoint: '/v1/messages',
      requestId: 'req-stage2-anthropic',
      wantsStream: false,
      reasoningMode: 'keep'
    });

    expect((anthropicResult.finalizedPayload as any).choices[0].message.content).toBe('visible  answer');
    expect((anthropicResult.finalizedPayload as any).choices[0].message.reasoning_content).toBe('internal');
  });
});
