import { describeRetryReason } from '../../../../src/server/runtime/http-server/executor-provider.js';

describe('executor-provider retry policy', () => {
  it('surface message from arbitrary error via describeRetryReason', () => {
    const error = Object.assign(new Error('something bad'), { statusCode: 500 });
    expect(describeRetryReason(error)).toContain('something bad');
  });

});
