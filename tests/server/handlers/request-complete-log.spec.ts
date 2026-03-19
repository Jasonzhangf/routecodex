import { jest } from '@jest/globals';
import { logRequestComplete } from '../../../src/server/handlers/handler-utils.js';
import { STREAM_LOG_FINISH_REASON_KEY } from '../../../src/server/utils/finish-reason.js';

describe('logRequestComplete', () => {
  const originalMode = process.env.ROUTECODEX_HTTP_LOG_VERBOSE;
  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

  beforeEach(() => {
    process.env.ROUTECODEX_HTTP_LOG_VERBOSE = '1';
    logSpy.mockClear();
  });

  afterAll(() => {
    if (originalMode === undefined) {
      delete process.env.ROUTECODEX_HTTP_LOG_VERBOSE;
    } else {
      process.env.ROUTECODEX_HTTP_LOG_VERBOSE = originalMode;
    }
    logSpy.mockRestore();
  });

  it('shows finish_reason for chat-like payloads', () => {
    logRequestComplete('/v1/chat/completions', 'req-chat', 200, {
      choices: [
        {
          finish_reason: 'stop'
        }
      ]
    });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('finish_reason=stop'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('\x1b[97mfinish_reason=stop\x1b[0m'));
  });

  it('maps anthropic stop_reason into finish_reason', () => {
    logRequestComplete('/v1/messages', 'req-msg', 200, {
      stop_reason: 'tool_use'
    });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('finish_reason=tool_calls'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('\x1b[97mfinish_reason=tool_calls\x1b[0m'));
  });

  it('derives tool_calls for responses required_action payloads', () => {
    logRequestComplete('/v1/responses', 'req-resp-tool', 200, {
      status: 'requires_action',
      required_action: {
        submit_tool_outputs: {
          tool_calls: []
        }
      }
    });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('finish_reason=tool_calls'));
  });

  it('derives stop for completed responses payloads', () => {
    logRequestComplete('/v1/responses', 'req-resp-stop', 200, {
      status: 'completed',
      output: [
        {
          type: 'message'
        }
      ]
    });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('finish_reason=stop'));
  });

  it('reads finish_reason from streamed responses wrapper metadata', () => {
    logRequestComplete('/v1/responses', 'req-resp-stream', 200, {
      __sse_responses: { pipe: () => undefined },
      [STREAM_LOG_FINISH_REASON_KEY]: 'tool_calls'
    });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('finish_reason=tool_calls'));
  });
});
