import { runHubPipeline } from '../../../src/server/runtime/http-server/executor-pipeline.js';

describe('http-server runHubPipeline semantics forwarding', () => {
  it('preserves standardizedRequest/processedRequest for response conversion', async () => {
    const hubPipeline = {
      execute: async () => ({
        providerPayload: { model: 'x', messages: [] },
        standardizedRequest: { semantics: { tools: { toolNameAliasMap: { glob: 'Glob' } } } },
        processedRequest: { semantics: { tools: { toolNameAliasMap: { bash: 'Bash' } } } },
        target: { providerKey: 'p1', providerType: 'openai', outboundProfile: 'openai-chat' },
        metadata: { processMode: 'chat' }
      })
    } as any;

    const result = await runHubPipeline(
      hubPipeline,
      {
        entryEndpoint: '/v1/messages',
        method: 'POST',
        requestId: 'req_test',
        headers: {},
        query: {},
        body: { model: 'x', messages: [] },
        metadata: {}
      } as any,
      {}
    );

    expect(result.standardizedRequest).toBeTruthy();
    expect(result.processedRequest).toBeTruthy();
    expect((result.standardizedRequest as any).semantics.tools.toolNameAliasMap.glob).toBe('Glob');
    expect((result.processedRequest as any).semantics.tools.toolNameAliasMap.bash).toBe('Bash');
  });
});

