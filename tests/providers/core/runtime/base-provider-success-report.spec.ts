import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockEmitProviderSuccessAndWait = jest.fn(async () => undefined);
const mockEmitProviderErrorAndWait = jest.fn(async () => undefined);
const mockBuildRuntimeFromProviderContext = jest.fn((ctx: any) => ({
  requestId: ctx.requestId,
  providerKey: ctx.providerKey,
  runtimeKey: ctx.runtimeMetadata?.runtimeKey ?? ctx.target?.runtimeKey ?? ctx.providerKey
}));

jest.unstable_mockModule('../../../../src/providers/core/utils/provider-error-reporter.js', () => ({
  emitProviderErrorAndWait: mockEmitProviderErrorAndWait,
  emitProviderSuccessAndWait: mockEmitProviderSuccessAndWait,
  buildRuntimeFromProviderContext: mockBuildRuntimeFromProviderContext
}));

const { BaseProvider } = await import('../../../../src/providers/core/runtime/base-provider.js');

class TestProvider extends BaseProvider {
  readonly type = 'test-provider';
  readonly providerType = 'responses';

  protected getServiceProfile(): any {
    return { defaultBaseUrl: 'https://example.test' };
  }

  protected createAuthProvider(): any {
    return {};
  }

  protected preprocessRequest(request: Record<string, unknown>): Record<string, unknown> {
    return request;
  }

  protected async postprocessResponse(response: unknown): Promise<Record<string, unknown>> {
    return response as Record<string, unknown>;
  }

  protected async sendRequestInternal(): Promise<Record<string, unknown>> {
    return { id: 'resp_success', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  }
}

describe('BaseProvider success reporting', () => {
  beforeEach(() => {
    mockEmitProviderSuccessAndWait.mockClear();
    mockEmitProviderErrorAndWait.mockClear();
    mockBuildRuntimeFromProviderContext.mockClear();
  });

  it('reports provider success to router policy before returning a successful response', async () => {
    const provider = new TestProvider({
      type: 'responses-http-provider',
      config: {
        providerType: 'responses',
        providerId: 'asxs',
        auth: { type: 'apikey', apiKey: 'test' }
      }
    } as any, {} as any);
    provider.setRuntimeProfile({
      runtimeKey: 'asxs.crsa.gpt-5.5',
      providerId: 'asxs',
      providerKey: 'asxs.crsa.gpt-5.5',
      providerType: 'responses',
      providerProtocol: 'openai-responses',
      providerFamily: 'asxs',
      endpoint: 'https://api.asxs.top/v1/responses',
      auth: { type: 'apikey', value: 'test' }
    } as any);
    await provider.initialize();

    const result = await provider.sendRequest({
      model: 'gpt-5.5',
      input: 'ping',
      metadata: {
        __rt: {
          runtimeKey: 'asxs.crsa.gpt-5.5'
        }
      }
    });

    expect(result).toEqual(expect.objectContaining({ id: 'resp_success' }));
    expect(mockBuildRuntimeFromProviderContext).toHaveBeenCalledWith(expect.objectContaining({
      requestId: expect.any(String),
      providerKey: 'asxs.crsa.gpt-5.5'
    }));
    expect(mockEmitProviderSuccessAndWait).toHaveBeenCalledWith(expect.objectContaining({
      providerKey: 'asxs.crsa.gpt-5.5',
      runtimeKey: 'asxs.crsa.gpt-5.5'
    }));
    expect(mockEmitProviderErrorAndWait).not.toHaveBeenCalled();
  });
});
