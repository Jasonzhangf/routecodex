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

  test('RED: Cascade request config must match WindsurfAPI false-bool elision for memory_config', async () => {
    const { buildSendCascadeMessageRequest } = await import('/Volumes/extension/code/WindsurfAPI/src/windsurf.js');
    const provider = createProvider();
    const args = {
      apiKey: 'devin-session-token$shape',
      cascadeId: 'cascade-shape',
      text: 'Reply with exactly RCC_WS_MIN_SHAPE.',
      sessionId: 'session-shape',
      modelEnum: 0,
      modelUid: 'gpt-5-5-low',
    };
    const referencePayload = buildSendCascadeMessageRequest(
      args.apiKey,
      args.cascadeId,
      args.text,
      args.modelEnum,
      args.modelUid,
      args.sessionId,
      { nativeMode: false, nativeAllowlist: [], additionalSteps: [] },
    );
    const referenceTopFields = (provider as any).parseProtoFields(referencePayload);
    const referenceCascadeConfig = (provider as any).getProtoField(referenceTopFields, 5, 2);
    const referenceConfigFields = (provider as any).parseProtoFields(referenceCascadeConfig.value);
    expect((provider as any).getProtoField(referenceConfigFields, 5, 2)).toBeNull();

    const payload = (provider as any).buildSendCascadeMessageRequest({
      ...args,
      nativeMode: false,
      nativeAllowlist: [],
      additionalSteps: [],
      mcpCompat: [],
    });
    const topFields = (provider as any).parseProtoFields(payload);
    const cascadeConfig = (provider as any).getProtoField(topFields, 5, 2);
    expect(cascadeConfig).toBeTruthy();
    const configFields = (provider as any).parseProtoFields(cascadeConfig.value);
    expect((provider as any).getProtoField(configFields, 5, 2)).toBeNull();
  });

  test('RED: Cascade warmup must hydrate panel user status before StartCascade like WindsurfAPI', async () => {
    const provider = createProvider();
    (provider as any).setPinnedGrpcRuntime({ lsPort: 40123, csrfToken: 'csrf-shape' });
    const calls: Array<{ pathName: string; payload: Buffer }> = [];
    jest.spyOn(provider as any, 'grpcUnaryLocal').mockImplementation(async (pathName: string, payload: Buffer) => {
      calls.push({ pathName, payload });
      if (pathName.includes('GetUserStatus')) {
        return Buffer.from([0x0a, 0x02, 0x08, 0x01]);
      }
      if (pathName.includes('StartCascade')) {
        return Buffer.concat([Buffer.from([0x0a, 0x0a]), Buffer.from('cascade-ok')]);
      }
      return Buffer.alloc(0);
    });

    const cascadeId = await (provider as any).sendStartCascade({
      apiKey: 'devin-session-token$shape',
      sessionId: 'session-shape',
    });

    expect(cascadeId).toBe('cascade-ok');
    expect(calls.map((call) => call.pathName.split('/').pop())).toEqual([
      'GetUserStatus',
      'UpdatePanelStateWithUserStatus',
      'InitializeCascadePanelState',
      'AddTrackedWorkspace',
      'UpdateWorkspaceTrust',
      'Heartbeat',
      'StartCascade',
    ]);
    const updatePanel = calls.find((call) => call.pathName.includes('UpdatePanelStateWithUserStatus'));
    expect(updatePanel).toBeTruthy();
    const updateFields = (provider as any).parseProtoFields(updatePanel!.payload);
    expect((provider as any).getProtoField(updateFields, 2, 2)?.value).toEqual(Buffer.from([0x08, 0x01]));
  });

  test('RED: managed Cascade workspace path must not live under hidden RCC home', () => {
    const provider = createProvider();
    const workspacePath = (provider as any).resolveManagedWorkspacePath('devin-session-token$shape');

    expect(workspacePath).not.toContain('/.rcc/');
    expect(path.basename(workspacePath)).toMatch(/^workspace-/);
  });

  test('RED: StartCascade must match Windsurf.app and omit trajectory_type', () => {
    const provider = createProvider();
    const payload = (provider as any).buildStartCascadeRequest('devin-session-token$shape', 'session-shape');
    const fields = (provider as any).parseProtoFields(payload);

    expect((provider as any).getProtoField(fields, 4, 0)?.value).toBe(1);
    expect((provider as any).getProtoField(fields, 5, 0)).toBeNull();
  });

  test('RED: basic SendUserCascadeMessage config must match Windsurf.app minimal planner shape', () => {
    const provider = createProvider();
    const payload = (provider as any).buildSendCascadeMessageRequest({
      apiKey: 'devin-session-token$shape',
      cascadeId: 'cascade-shape',
      text: 'Reply with exactly RCC_WS_APP_SHAPE.',
      sessionId: 'session-shape',
      modelEnum: 0,
      modelUid: 'gpt-5-4-medium',
      nativeMode: false,
      nativeAllowlist: [],
      additionalSteps: [],
      mcpCompat: [],
    });
    const topFields = (provider as any).parseProtoFields(payload);
    const cascadeConfig = (provider as any).getProtoField(topFields, 5, 2);
    const configFields = (provider as any).parseProtoFields(cascadeConfig.value);
    const planner = (provider as any).getProtoField(configFields, 1, 2);
    const plannerFields = (provider as any).parseProtoFields(planner.value);

    expect(configFields.map((field: any) => field.fieldNo)).toEqual([1]);
    expect((provider as any).getProtoField(plannerFields, 35, 2)?.value.toString()).toBe('gpt-5-4-medium');
    expect((provider as any).getProtoField(plannerFields, 34, 2)).toBeNull();
    expect((provider as any).getProtoField(plannerFields, 6, 0)).toBeNull();
    const conversational = (provider as any).getProtoField(plannerFields, 2, 2);
    if (conversational) {
      const conversationalFields = (provider as any).parseProtoFields(conversational.value);
      expect(conversationalFields).toEqual([]);
    }
  });

  test('RED: Windsurf Kimi K2.6 UID must resolve before account selection', async () => {
    const provider = createProvider();
    jest.spyOn(provider as any, 'resolveCascadeApiKey').mockRejectedValue(new Error('after-model-resolution'));

    await expect((provider as any).sendRequestInternal({
      body: {
        model: 'kimi-k2-6',
        messages: [{ role: 'user', content: 'shape only' }],
      },
    })).rejects.toThrow('after-model-resolution');
  });
});
