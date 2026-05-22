import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { WindsurfChatProvider } from '../src/providers/core/runtime/windsurf-chat-provider.ts';
import { loadProviderConfigsV2 } from '../src/config/provider-v2-loader.ts';

const deps: any = {
  logger: { logModule: () => {}, logProviderRequest: () => {} },
  errorHandlingCenter: { handleError: async () => {} },
};

async function buildConfigModeProvider(alias: string, model: string): Promise<any> {
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

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), `windsurf-chat-smoke-${alias}-`));
  const tokenFile = path.join(tmpRoot, `${alias}.json`);
  return {
    type: 'openai-standard',
    config: {
      providerType: 'openai',
      baseUrl: '',
      model,
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

async function main() {
  const alias = process.argv[2] || 'ws-pro-4';
  const model = process.argv[3] || 'gpt-5.3-codex';
  const prompt = process.argv[4] || 'say hi';
  const provider = new WindsurfChatProvider(await buildConfigModeProvider(alias, model), deps);

  const credential = await (provider as any).ensureWindsurfSessionCredential();
  const apiKey = credential.apiKey;
  const body = (provider as any).buildGetChatCompletionsRequest({
    apiKey,
    semanticConversation: [{ type: 'user', text: prompt }],
    model,
  });
  const headers = (provider as any).buildChatMessageHeaders(apiKey);
  const url = 'https://server.self-serve.windsurf.com/exa.api_server_pb.ApiServerService/GetChatCompletions';
  const response = await (provider as any).fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
    20000,
  );
  const raw = typeof response.text === 'function'
    ? await response.text()
    : Buffer.from(await response.arrayBuffer()).toString('utf8');
  console.log(JSON.stringify({
    ok: true,
    alias,
    model,
    status: response.status,
    headers,
    body,
    rawSnippet: String(raw || '').slice(0, 600),
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    alias: process.argv[2] || 'ws-pro-4',
    model: process.argv[3] || 'gpt-5.3-codex',
    error: error instanceof Error ? error.message : String(error),
    code: (error as any)?.code,
    status: (error as any)?.status,
    retryable: (error as any)?.retryable,
  }, null, 2));
  process.exit(1);
});
