import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

jest.mock('../../../../src/providers/core/config/camoufox-launcher.ts', () => ({
  getLastCamoufoxLaunchFailureReason: () => null,
  openAuthInCamoufox: async () => { throw new Error('camoufox disabled in windsurf request-shape sample tests'); },
}));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const deps: any = {
  logger: { logModule: () => {}, logProviderRequest: () => {} },
  errorHandlingCenter: { handleError: async () => {} },
};

let WindsurfChatProvider: any;

function loadFixture(name: string): any {
  const fixturePath = path.resolve(__dirname, '../../../fixtures/windsurf-samples/request-shape', name);
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
}

function createProvider() {
  return new WindsurfChatProvider({
    type: 'openai-standard',
    config: {
      providerType: 'openai',
      baseUrl: 'http://localhost:3003',
      model: 'gpt-5.5-low',
      auth: { type: 'apikey', apiKey: 'devin-session-token$shape', rawType: 'windsurf-devin-token' },
    },
  } as any, deps);
}

describe('Windsurf request shape samples against WindsurfAPI reference rules', () => {
  beforeAll(async () => {
    ({ WindsurfChatProvider } = await import('../../../../src/providers/core/runtime/windsurf-chat-provider.ts'));
  });

  test('RED: replayed failed live sample must satisfy WindsurfAPI Cascade identity-neutralized prompt shape', async () => {
    const { compactSystemPromptForCascade } = await import('/Volumes/extension/code/WindsurfAPI/src/client.js');
    const sample = loadFixture('provider-request-20260528T221543389.json');
    const failedText = String(sample.body?.text || '');
    const observedSystemLine = failedText.split('\n\n')[0] || '';
    const rawSystemLine = observedSystemLine.replace(/^The assistant is /, 'You are ');
    const reference = compactSystemPromptForCascade(rawSystemLine);

    const provider = createProvider();
    const replayed = (provider as any).buildCascadePromptText(
      [
        { role: 'system', content: rawSystemLine },
        { role: 'user', content: 'shape replay ping' },
      ],
      [{ type: 'user', text: 'shape replay ping' }],
      'gpt-5-5-low',
    );

    expect(reference).toContain('The assistant is a coding tool');
    expect(reference).not.toContain('Codex');
    expect(replayed).not.toContain('The assistant is Codex');
    expect(replayed).toContain(reference);
  });

  test('RED: replayed no-output live sample must cold-stall like WindsurfAPI instead of occupying provider concurrency until max wait', async () => {
    const sample = loadFixture('provider-request-20260528T221543389.json');
    const provider = createProvider();
    (provider as any).windsurfRuntime.pollMaxWaitMs = 2_000;
    (provider as any).windsurfRuntime.coldStallBaseMs = 1;
    jest.spyOn(provider as any, 'grpcUnaryLocal').mockImplementation(async (pathName: string) => {
      if (String(pathName).includes('GetCascadeTrajectorySteps')) return Buffer.alloc(0);
      if (String(pathName).includes('GetCascadeTrajectory')) return Buffer.from([0x10, 0x02]);
      throw new Error(`unexpected grpc path ${pathName}`);
    });

    await expect((provider as any).pollCascadeTrajectorySteps({
      cascadeId: 'sample-stall-cascade',
      model: 'gpt-5.5-low',
      promptChars: 0,
    })).rejects.toMatchObject({ code: 'WINDSURF_CASCADE_STALLED' });
  });
});
