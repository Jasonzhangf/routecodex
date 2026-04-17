import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockResolveImplForSubpath = jest.fn();
const mockImportCoreDist = jest.fn();

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge/module-loader.js', () => ({
  resolveImplForSubpath: mockResolveImplForSubpath,
  importCoreDist: mockImportCoreDist
}));

const { getHubPipelineCtor, getHubPipelineCtorForImpl } = await import(
  '../../../../src/modules/llmswitch/bridge/routing-integrations.ts'
);

describe('llmswitch bridge routing-integrations', () => {
  beforeEach(() => {
    mockResolveImplForSubpath.mockReset();
    mockImportCoreDist.mockReset();
  });

  it('returns ts HubPipeline ctor directly without host-side runtime hook wrapping', async () => {
    mockResolveImplForSubpath.mockReturnValue('ts');

    class BaseHubPipelineMock {
      constructor(_config: Record<string, unknown>) {}
    }

    mockImportCoreDist.mockImplementation(async (subpath: string) => {
      if (subpath === 'conversion/hub/pipeline/hub-pipeline') {
        return { HubPipeline: BaseHubPipelineMock };
      }
      throw new Error(`unexpected subpath: ${subpath}`);
    });

    const HubPipelineCtor = await getHubPipelineCtor();
    expect(HubPipelineCtor).toBe(BaseHubPipelineMock);
    expect(mockImportCoreDist).toHaveBeenCalledTimes(1);
  });

  it('does not wrap engine HubPipeline ctor with ts runtime router hooks', async () => {
    class EngineHubPipelineMock {
      constructor(_config: Record<string, unknown>) {}
    }

    mockImportCoreDist.mockImplementation(async (subpath: string, impl: string) => {
      if (subpath === 'conversion/hub/pipeline/hub-pipeline' && impl === 'engine') {
        return { HubPipeline: EngineHubPipelineMock };
      }
      throw new Error(`unexpected subpath=${subpath} impl=${impl}`);
    });

    const HubPipelineCtor = await getHubPipelineCtorForImpl('engine');

    expect(HubPipelineCtor).toBe(EngineHubPipelineMock);
    expect(mockImportCoreDist).toHaveBeenCalledTimes(1);
  });
});
