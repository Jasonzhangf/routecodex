import { beforeAll, describe, expect, test, jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

jest.mock('../../../../src/providers/core/config/camoufox-launcher.ts', () => ({
  getLastCamoufoxLaunchFailureReason: () => null,
  openAuthInCamoufox: async () => { throw new Error('camoufox disabled in windsurf provider tests'); },
}));

const deps: any = {
  logger: { logModule: () => {}, logProviderRequest: () => {} },
  errorHandlingCenter: { handleError: async () => {} },
};

let WindsurfChatProvider: any;

function createProvider(auth: Record<string, unknown> = { type: 'apikey', apiKey: 'devin-session-token$primary' }) {
  return new WindsurfChatProvider({
    type: 'openai-standard',
    config: {
      providerType: 'openai',
      baseUrl: 'http://localhost:3003',
      model: 'kimi-k2-6',
      auth,
    },
  } as any, deps);
}

describe('Windsurf single-account direct mode', () => {
  beforeAll(async () => {
    ({ WindsurfChatProvider } = await import('../../../../src/providers/core/runtime/windsurf-chat-provider.ts'));
  });

  test('managed auth must accept exactly one configured account', async () => {
    const provider = createProvider({
      type: 'apikey',
      rawType: 'windsurf-account',
      entries: [
        { alias: 'ws-pro-3', account: 'frost89409@gmail.com', apiKey: 'devin-session-token$frost' },
      ],
    });

    const managed = await (provider as any).readManagedWindsurfAuthConfigDetailed();

    expect(managed.entries.map((entry: any) => entry.alias)).toEqual(['ws-pro-3']);
  });

  test('managed auth must not scan old windsurf token files into the account pool', async () => {
    const previousHome = process.env.RCC_HOME;
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-windsurf-single-'));
    process.env.RCC_HOME = tmp;
    try {
      await fs.mkdir(path.join(tmp, 'auth'), { recursive: true });
      await fs.writeFile(path.join(tmp, 'auth', 'windsurf-ws-pro-4.json'), JSON.stringify({
        apiKey: 'devin-session-token$old-other-account',
      }), 'utf8');

      const provider = createProvider({
        type: 'apikey',
        rawType: 'windsurf-account',
        entries: [
          { alias: 'ws-pro-3', account: 'frost89409@gmail.com', apiKey: 'devin-session-token$frost' },
        ],
      });

      const managed = await (provider as any).readManagedWindsurfAuthConfigDetailed();

      expect(managed.entries.map((entry: any) => entry.alias)).toEqual(['ws-pro-3']);
    } finally {
      if (previousHome === undefined) delete process.env.RCC_HOME;
      else process.env.RCC_HOME = previousHome;
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test('managed auth must recover the single account from windsurf config tokenFile when runtime entries are absent', async () => {
    const previousHome = process.env.RCC_HOME;
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-windsurf-config-token-'));
    process.env.RCC_HOME = tmp;
    try {
      const tokenFile = path.join(tmp, 'auth', 'windsurf-ws-pro-3.json');
      await fs.mkdir(path.dirname(tokenFile), { recursive: true });
      await fs.mkdir(path.join(tmp, 'provider', 'windsurf'), { recursive: true });
      await fs.writeFile(tokenFile, JSON.stringify({
        apiKey: 'devin-session-token$frost-from-token-file',
      }), 'utf8');
      await fs.writeFile(path.join(tmp, 'provider', 'windsurf', 'config.v2.toml'), `
[provider.auth]
type = "windsurf-account"

[[provider.auth.entries]]
alias = "ws-pro-3"
account = "frost89409@gmail.com"
password = "secret"
tokenFile = "${tokenFile}"
`, 'utf8');
      const provider = createProvider({ type: 'apikey', rawType: 'windsurf-account' });

      const managed = await (provider as any).readManagedWindsurfAuthConfigDetailed();

      expect(managed.entries).toHaveLength(1);
      expect(managed.entries[0]).toEqual(expect.objectContaining({
        alias: 'ws-pro-3',
        apiKey: 'devin-session-token$frost-from-token-file',
      }));
    } finally {
      if (previousHome === undefined) delete process.env.RCC_HOME;
      else process.env.RCC_HOME = previousHome;
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test('selection must pick the single configured account without health probe or ranking', async () => {
    const provider = createProvider({
      type: 'apikey',
      rawType: 'windsurf-account',
      entries: [
        { alias: 'ws-pro-3', account: 'frost89409@gmail.com', apiKey: 'devin-session-token$frost' },
      ],
    });
    const fetchSpy = jest.spyOn(provider as any, 'fetchWindsurfUserStatusForHealth')
      .mockRejectedValue(new Error('health probe must not run'));
    const rankSpy = jest.spyOn(provider as any, 'rankManagedCredentialsByHealth');

    const managed = await (provider as any).readManagedWindsurfAuthConfigDetailed();
    const selected = await (provider as any).selectWindsurfAccount(managed, 'kimi-k2-6');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(rankSpy).not.toHaveBeenCalled();
    expect(selected).toEqual({ accountAlias: 'ws-pro-3', apiKey: 'devin-session-token$frost' });
  });

  test('checkHealth must not call upstream probes in direct mode', async () => {
    const provider = createProvider();
    const resolveSpy = jest.spyOn(provider as any, 'resolveCascadeApiKey');
    const modelConfigSpy = jest.spyOn(provider as any, 'fetchCascadeModelConfigsForSite');

    await expect((provider as any).checkHealth()).resolves.toBe(true);

    expect(resolveSpy).not.toHaveBeenCalled();
    expect(modelConfigSpy).not.toHaveBeenCalled();
  });

  test('quota errors must not write internal account cooldown state', async () => {
    const provider = createProvider();
    (provider as any).windsurfSessionCredential = {
      apiKey: 'devin-session-token$frost',
      sessionToken: 'devin-session-token$frost',
      auth1Token: '',
      accountAlias: 'ws-pro-3',
    };

    (provider as any).markCurrentAliasQuotaExhausted('sess-test');

    expect((provider as any).windsurfUnavailableAccounts.has('ws-pro-3')).toBe(false);
    expect((provider as any).windsurfQuotaCooldownUntilMs.has('ws-pro-3')).toBe(false);
  });
});
