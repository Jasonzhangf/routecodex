import { shouldRetryProviderError } from '../../../src/server/runtime/http-server/executor-provider.js';

describe('shouldRetryProviderError', () => {
  it('retries on upstream prompt-too-long 400 errors', () => {
    const err: any = new Error(
      'HTTP 400: {"error":{"code":400,"message":"{\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"Prompt is too long\\"}}","status":"FAILED_PRECONDITION"}}'
    );
    err.statusCode = 400;
    err.upstreamMessage = err.message;
    expect(shouldRetryProviderError(err)).toBe(true);
  });

  it('retries when status is nested but message is a strong match', () => {
    const err: any = new Error('Prompt is too long');
    err.response = { data: { error: { status: 400, message: 'Prompt is too long' } } };
    expect(shouldRetryProviderError(err)).toBe(true);
  });

  it('retries iflow business 514 model error', () => {
    const err: any = new Error('HTTP 400: iFlow business error (514): model error');
    err.statusCode = 400;
    err.providerFamily = 'iflow';
    err.response = { data: { error: { code: '514', message: 'model error' } } };
    expect(shouldRetryProviderError(err)).toBe(true);
  });

  it('does not retry on generic 400 errors', () => {
    const err: any = new Error('HTTP 400: {"error":{"message":"bad request"}}');
    err.statusCode = 400;
    expect(shouldRetryProviderError(err)).toBe(false);
  });
});
