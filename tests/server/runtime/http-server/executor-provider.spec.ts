import {
  describeRetryReason,
  isPromptTooLongError
} from '../../../../src/server/runtime/http-server/executor-provider.js';

describe('executor-provider retry policy', () => {
  it('surface message from arbitrary error via describeRetryReason', () => {
    const error = Object.assign(new Error('something bad'), { statusCode: 500 });
    expect(describeRetryReason(error)).toContain('something bad');
  });

  it('treats request entity too large as payload-size overflow even when wrapped as HTTP 500', () => {
    const error = Object.assign(new Error('request entity too large'), {
      code: 'HTTP_500',
      statusCode: 500
    });

    expect(isPromptTooLongError(error)).toBe(true);
  });

});
