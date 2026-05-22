import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { WindsurfChatProvider } from '../src/providers/core/runtime/windsurf-chat-provider.ts';
import { loadProviderConfigsV2 } from '../src/config/provider-v2-loader.ts';

type ProbeMode = 'account' | 'token' | 'config';

const deps: any = {
  logger: { logModule: () => {}, logProviderRequest: () => {} },
  errorHandlingCenter: { handleError: async () => {} },
};

function parseMode(value: string | undefined): ProbeMode {
  const normalized = String(value || 'config').trim().toLowerCase();
  if (normalized === 'account' || normalized === 'token' || normalized === 'config') {
    return normalized;
  }
  throw new Error(`unsupported probe mode: ${value}`);
}

function buildTokenConfig(alias: string) {
  return {
    type: 'openai-standard',
    config: {
      providerType: 'openai',
      baseUrl: '',
      model: process.env.WINDSURF_MODEL || 'gpt-5.3-codex',
      auth: {
        type: 'apikey',
        apiKey: process.env.WINDSURF_DEVIN_TOKEN || '',
        rawType: 'windsurf-devin-token',
        tokenFile: process.env.WINDSURF_TOKEN_FILE || undefined,
        accountAlias: alias,
      },
    },
  } as any;
}

function buildAccountConfig(alias: string) {
  const account = process.env.WINDSURF_ACCOUNT || '';
  const password = process.env.WINDSURF_PASSWORD || '';
  return {
    type: 'openai-standard',
    config: {
      providerType: 'openai',
      baseUrl: '',
      model: process.env.WINDSURF_MODEL || 'gpt-5.3-codex',
      auth: {
        type: 'apikey',
        apiKey: '',
        rawType: 'windsurf-account',
        account,
        password,
        tokenFile: process.env.WINDSURF_TOKEN_FILE || undefined,
        accountAlias: alias,
      },
    },
  } as any;
}

async function buildConfigModeProvider(alias: string): Promise<any> {
  const configs = await loadProviderConfigsV2();
  const providerConfig = configs.windsurf?.provider;
  if (!providerConfig || typeof providerConfig !== 'object') {
    throw new Error('windsurf provider config not found in ~/.rcc/provider/windsurf/config.v2.toml');
  }
  const providerAuth = (providerConfig as any).auth;
  const entries = Array.isArray(providerAuth?.entries) ? providerAuth.entries : [];
  const entry = entries.find((row: any) => row && typeof row === 'object' && String(row.alias || '').trim() === alias);
  if (!entry) {
    throw new Error(`windsurf auth entry not found for alias=${alias}`);
  }

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), `windsurf-auth-probe-${alias}-`));
  const tokenFile = path.join(tmpRoot, `${alias}.json`);
  return {
    type: 'openai-standard',
    config: {
      providerType: 'openai',
      baseUrl: '',
      model: process.env.WINDSURF_MODEL || 'gpt-5.3-codex',
      auth: {
        type: 'apikey',
        apiKey: '',
        rawType: 'windsurf-account',
        account: String(entry.account || ''),
        password: String(entry.password || ''),
        tokenFile,
        accountAlias: alias,
      },
    },
  } as any;
}

async function buildProviderConfig(mode: ProbeMode, alias: string): Promise<any> {
  if (mode === 'token') return buildTokenConfig(alias);
  if (mode === 'account') return buildAccountConfig(alias);
  return buildConfigModeProvider(alias);
}

async function main() {
  const mode = parseMode(process.argv[2]);
  const alias = process.argv[3] || 'ws-pro-2';
  const provider = new WindsurfChatProvider(await buildProviderConfig(mode, alias), deps);
  const credential = await (provider as any).ensureWindsurfSessionCredential();
  const health = await provider.checkHealth();
  console.log(JSON.stringify({
    ok: true,
    mode,
    alias,
    credential: credential ? {
      hasCredential: true,
      apiKeyPrefix: typeof credential.apiKey === 'string' ? credential.apiKey.slice(0, 24) : null,
      accountId: credential.accountId || null,
      primaryOrgId: credential.primaryOrgId || null,
      auth1TokenPresent: !!credential.auth1Token,
    } : null,
    health,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    mode: process.argv[2] || 'config',
    alias: process.argv[3] || 'ws-pro-2',
    error: error instanceof Error ? error.message : String(error),
    code: (error as any)?.code,
    status: (error as any)?.status,
    retryable: (error as any)?.retryable,
  }, null, 2));
  process.exit(1);
});
