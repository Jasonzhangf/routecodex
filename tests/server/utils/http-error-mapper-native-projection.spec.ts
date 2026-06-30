import { describe, expect, it, jest } from '@jest/globals';

const projectSseErrorEventPayloadNativeMock = jest.fn((input: {
  requestId: string;
  status: number;
  message: string;
  code: string;
  error?: Record<string, unknown>;
}) => ({
  type: 'error',
  status: input.status,
  error: {
    ...(input.error ?? {}),
    message: input.message,
    code: input.code,
    request_id: typeof input.error?.request_id === 'string' && input.error.request_id.trim()
      ? input.error.request_id.trim()
      : input.requestId,
  },
}));

jest.unstable_mockModule(
  '../../../src/modules/llmswitch/bridge.js',
  () => ({
    projectSseErrorEventPayloadNative: projectSseErrorEventPayloadNativeMock,
  })
);

const { projectSseErrorEventPayload } = await import('../../../src/server/utils/http-error-mapper.js');

describe('http-error-mapper native SSE projection', () => {
  it('delegates SSE error payload projection to the native wrapper', () => {
    const payload = projectSseErrorEventPayload({
      requestId: 'req_local',
      status: 504,
      message: 'SSE timeout after 50ms',
      code: 'HTTP_SSE_TIMEOUT',
      error: {
        provider_key: 'tab.default.gpt-5.1',
      },
    });

    expect(projectSseErrorEventPayloadNativeMock).toHaveBeenCalledTimes(1);
    expect(projectSseErrorEventPayloadNativeMock).toHaveBeenCalledWith({
      requestId: 'req_local',
      status: 504,
      message: 'SSE timeout after 50ms',
      code: 'HTTP_SSE_TIMEOUT',
      error: {
        provider_key: 'tab.default.gpt-5.1',
      },
    });
    expect(payload).toEqual({
      type: 'error',
      status: 504,
      error: {
        provider_key: 'tab.default.gpt-5.1',
        message: 'SSE timeout after 50ms',
        code: 'HTTP_SSE_TIMEOUT',
        request_id: 'req_local',
      },
    });
  });
});
