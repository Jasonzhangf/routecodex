import { shouldRetryProviderError } from '../../../src/server/runtime/http-server/executor-provider.js';

describe('shouldRetryProviderError', () => {
  it('does not retry on upstream prompt-too-long 400 errors', () => {
    const err: any = new Error(
      'HTTP 400: {"error":{"code":400,"message":"{\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"Prompt is too long\\"}}","status":"FAILED_PRECONDITION"}}'
    );
    err.statusCode = 400;
    err.upstreamMessage = err.message;
    expect(shouldRetryProviderError(err)).toBe(false);
  });

  it('does not retry when status is nested but message is a strong match', () => {
    const err: any = new Error('Prompt is too long');
    err.response = { data: { error: { status: 400, message: 'Prompt is too long' } } };
    expect(shouldRetryProviderError(err)).toBe(false);
  });

  it('retries glm business 514 model error', () => {
    const err: any = new Error('HTTP 400: GLM business error (514): model error');
    err.statusCode = 400;
    err.providerFamily = 'glm';
    err.response = { data: { error: { code: '514', message: 'model error' } } };
    expect(shouldRetryProviderError(err)).toBe(true);
  });

  it('does not retry on generic 400 errors', () => {
    const err: any = new Error('HTTP 400: {"error":{"message":"bad request"}}');
    err.statusCode = 400;
    expect(shouldRetryProviderError(err)).toBe(false);
  });

  it('does not retry deterministic invalid_request_error even if provider marks retryable', () => {
    const err: any = new Error('Invalid');
    err.statusCode = 400;
    err.retryable = true;
    err.response = {
      data: {
        error: {
          type: 'invalid_request_error',
          param: 'tools.33.type',
          code: 'invalid_string',
          message: 'Invalid'
        }
      }
    };
    expect(shouldRetryProviderError(err)).toBe(false);
  });

  it('does not retry bare HTTP 400 Invalid payload-shape errors', () => {
    const err: any = new Error('Invalid');
    err.statusCode = 400;
    err.code = 'HTTP_400';
    expect(shouldRetryProviderError(err)).toBe(false);
  });

  it('does not retry client disconnect abort errors', () => {
    const err: any = Object.assign(new Error('CLIENT_REQUEST_ABORTED'), {
      name: 'AbortError',
      code: 'CLIENT_DISCONNECTED'
    });
    expect(shouldRetryProviderError(err)).toBe(false);
  });
});
