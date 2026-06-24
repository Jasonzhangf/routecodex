import { describe, expect, it, jest } from '@jest/globals';

import { persistPayloadContractProviderSnapshots } from '../../../../../src/server/runtime/http-server/executor/request-executor-response-contract.js';

describe('persistPayloadContractProviderSnapshots snapshot metadata contract', () => {
  it('forwards metadata to both contract snapshot writes', async () => {
    const writeProviderSnapshot = jest.fn(async () => undefined);
    const metadata = {
      entryPort: 5520,
      matchedPort: 5520,
      routecodexLocalPort: 5520
    };

    await persistPayloadContractProviderSnapshots({
      requestId: 'req-contract-meta',
      entryEndpoint: '/v1/responses',
      providerKey: 'mock.key1',
      providerId: 'mock',
      metadata,
      providerRequestPayload: { model: 'gpt-5.4', input: 'ping' },
      providerRequestHeaders: { 'content-type': 'application/json' },
      providerRequestUrl: 'https://example.test/v1/responses',
      normalizedResponse: { status: 200, body: { status: 'completed', output_text: '' } } as any,
      convertedResponse: { status: 200, body: { status: 'completed', output_text: '' } } as any,
      payloadContractSignal: {
        marker: 'responses_missing_required_tool_call',
        reason: 'responses status=completed but output text/tool_calls are empty'
      },
      writeProviderSnapshot
    });

    expect(writeProviderSnapshot).toHaveBeenCalledTimes(2);
    expect(writeProviderSnapshot).toHaveBeenNthCalledWith(1, expect.objectContaining({
      phase: 'provider-request-contract',
      metadata
    }));
    expect(writeProviderSnapshot).toHaveBeenNthCalledWith(2, expect.objectContaining({
      phase: 'provider-response-contract',
      metadata
    }));
  });
});
