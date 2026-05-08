import { __requestExecutorTestables } from '../../../../src/server/runtime/http-server/request-executor.js';

describe('request-executor stopless visible marker guard', () => {
  it('does not treat hidden metadata marker as reasoning.stop finalization', () => {
    const hiddenOnly = {
      status: 'completed',
      metadata: {
        hidden: '[app.finished:reasoning.stop] {"tool":"reasoning.stop","completed":true}'
      },
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: '普通文本，没有结束标记'
            }
          ]
        }
      ]
    };

    expect(__requestExecutorTestables.bodyContainsReasoningStopFinalizedMarker(hiddenOnly)).toBe(false);
    expect(
      __requestExecutorTestables.detectStoplessTerminationWithoutFinalization(hiddenOnly, 'on')
    ).toMatchObject({
      marker: 'derived_stopless_missing_reasoning_stop_finalization'
    });
  });

  it('accepts anthropic tool_use followup body as legal continue state without finalized marker', () => {
    const anthropicToolUse = {
      data: {
        stop_reason: 'tool_use',
        content: [
          { type: 'thinking', thinking: '继续执行工具' },
          {
            type: 'tool_use',
            id: 'call_dd97d989154849fea9380e44',
            name: 'exec_command',
            input: { cmd: 'pwd' }
          }
        ]
      }
    };

    expect(__requestExecutorTestables.bodyContainsReasoningStopFinalizedMarker(anthropicToolUse)).toBe(false);
    expect(
      __requestExecutorTestables.detectStoplessTerminationWithoutFinalization(anthropicToolUse, 'on')
    ).toBeNull();
  });

  it('accepts historical mimo reasoning_stop_continue followup sample without finalized marker', () => {
    const historicalMimoFollowup = {
      data: {
        id: '4b23bd908d714eeba02c871a7bf6475b',
        model: 'mimo-v2.5-pro',
        role: 'assistant',
        type: 'message',
        stop_reason: 'tool_use',
        content: [
          {
            type: 'thinking',
            signature: '',
            thinking:
              'The user wants me to continue executing. Let me check the current state and look at the logs for C2C_MESSAGE_CREATE events. I need to stop overthinking and just act.'
          },
          {
            type: 'tool_use',
            id: 'call_d2f9da428dbe4a48a4618629',
            name: 'exec_command',
            input: {
              cmd: `bash -lc 'date && echo "=== PROCESSES ===" && ps aux | grep -E "(fin daemon-run|qqbot-peer-runner|fin web-debug|run-qqbot-minimal)" | grep -v grep && echo "=== BRIDGE EVENTS: inbound ===" && grep -i "C2C_MESSAGE_CREATE\\|inbound\\|message_received" ~/.fin/runtime/peers/qqbot/events.jsonl 2>/dev/null | tail -5 && echo "=== BRIDGE STDERR: last 10 ===" && tail -10 ~/.fin/runtime/peers/qqbot/bridge.stderr.log 2>/dev/null && echo "=== FINGER BRIDGE LOG ===" && tail -20 /tmp/finger-qqbot.log 2>/dev/null | grep -v "Heartbeat ACK"'`
            }
          }
        ],
        usage: {
          cache_read_input_tokens: 196608,
          input_tokens: 14959,
          output_tokens: 233
        }
      }
    };

    expect(__requestExecutorTestables.bodyContainsReasoningStopFinalizedMarker(historicalMimoFollowup)).toBe(false);
    expect(
      __requestExecutorTestables.detectStoplessTerminationWithoutFinalization(historicalMimoFollowup, 'on')
    ).toBeNull();
  });


  it('accepts visible assistant finalized marker from responses output', () => {
    const visibleDone = {
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              output_text:
                '[reasoning.stop]\n结束标记: [app.finished:reasoning.stop] {"tool":"reasoning.stop","completed":true}'
            }
          ]
        }
      ]
    };

    expect(__requestExecutorTestables.bodyContainsReasoningStopFinalizedMarker(visibleDone)).toBe(true);
    expect(
      __requestExecutorTestables.detectStoplessTerminationWithoutFinalization(visibleDone, 'on')
    ).toBeNull();
  });

  it('rejects assistant content that resolves to stop via derived finish reason without finalized marker', () => {
    const derivedStopChat = {
      id: 'chatcmpl_derived_stop_1',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '阶段性汇报，但没有 reasoning.stop 完成标记'
          }
        }
      ]
    };

    expect(
      __requestExecutorTestables.detectStoplessTerminationWithoutFinalization(derivedStopChat, 'on')
    ).toMatchObject({
      marker: 'derived_stopless_missing_reasoning_stop_finalization'
    });
  });
});
