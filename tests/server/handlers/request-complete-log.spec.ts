import { jest } from '@jest/globals';
import { logRequestComplete } from '../../../src/server/handlers/handler-utils.js';

describe('logRequestComplete', () => {
  const originalMode = process.env.ROUTECODEX_HTTP_LOG_VERBOSE;
  const logSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

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
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('status=200'));
  });

  it('maps anthropic stop_reason into finish_reason', () => {
    logRequestComplete('/v1/messages', 'req-msg', 200, {
      stop_reason: 'tool_use'
    });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('finish_reason=tool_calls'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('status=200'));
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

  it('does not read finish_reason from streamed wrapper custom metadata', () => {
    logRequestComplete('/v1/responses', 'req-resp-stream', 200, {
      sseStream: { pipe: () => undefined }
    });

    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('finish_reason=tool_calls'));
  });

  it('can preserve timing without printing completed line', () => {
    logRequestComplete('/v1/responses', 'req-resp-suppressed', 200, {
      status: 'completed'
    }, {
      preserveTimingForUsage: true,
      suppressCompletedLog: true
    });

    expect(logSpy).not.toHaveBeenCalled();
  });
});
