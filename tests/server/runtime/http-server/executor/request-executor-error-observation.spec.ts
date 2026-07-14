import { attachProviderObservationToError } from '../../../../../src/server/runtime/http-server/executor/request-executor-error-shared.js';

describe('request executor provider error observation', () => {
  it('attaches the selected provider and wire model to the original error', () => {
    const error = new Error('API Key 所属分组已删除') as Error & Record<string, unknown>;

    attachProviderObservationToError(error, {
      providerKey: 'cc-sol[key1]',
      providerModel: 'gpt-5.6-sol'
    });

    expect(error).toMatchObject({
      message: 'API Key 所属分组已删除',
      providerKey: 'cc-sol[key1]',
      providerModel: 'gpt-5.6-sol'
    });
  });

  it('does not invent or overwrite provider observation truth', () => {
    const error = Object.assign(new Error('provider failed'), {
      providerKey: 'existing-provider',
      providerModel: 'existing-model'
    });

    attachProviderObservationToError(error, {
      providerKey: 'replacement-provider',
      providerModel: 'replacement-model'
    });
    attachProviderObservationToError(new Error('target unavailable'), {
      providerKey: '   ',
      providerModel: ''
    });

    expect(error).toMatchObject({
      providerKey: 'existing-provider',
      providerModel: 'existing-model'
    });
  });
});
