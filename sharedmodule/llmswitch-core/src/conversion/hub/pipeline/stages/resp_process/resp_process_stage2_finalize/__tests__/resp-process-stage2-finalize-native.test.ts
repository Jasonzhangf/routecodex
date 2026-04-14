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

  it('always strips executed internal servertool calls even on followup paths', async () => {
    const result = await runRespProcessStage2Finalize({
      payload: {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_reasoning_stop_1',
                  type: 'function',
                  function: {
                    name: 'reasoning.stop',
                    arguments: '{"task_goal":"done","is_completed":true,"completion_evidence":"ok"}'
                  }
                }
              ]
            }
          }
        ]
      } as any,
      originalPayload: {
        tool_outputs: [
          {
            tool_call_id: 'call_reasoning_stop_1',
            name: 'reasoning.stop',
            content: '{"ok":true,"armed":true}'
          }
        ]
      } as any,
      skipServerToolStrip: true,
      entryEndpoint: '/v1/responses',
      requestId: 'req-stage2-strip-followup',
      wantsStream: false,
      reasoningMode: 'keep'
    });

    expect((result.finalizedPayload as any).choices[0].message.tool_calls).toEqual([]);
    expect((result.finalizedPayload as any).choices[0].finish_reason).toBe('stop');
  });
});
