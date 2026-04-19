import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { OpenAIStandardConfig } from '../../../../src/providers/core/api/provider-config.js';
import type { ModuleDependencies } from '../../../../src/modules/pipeline/interfaces/pipeline-interfaces.js';
import { OpenAIHttpProvider } from '../../../../src/providers/core/runtime/openai-http-provider.js';

const emptyDeps: ModuleDependencies = {} as ModuleDependencies;
const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('Qwen OAuth recovery routing', () => {
  it('routes openai-compatible qwen recovery through oauthProviderId=qwen', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-qwen-recovery-'));
    tempDirs.push(tempDir);
    const tokenFile = path.join(tempDir, 'qwen-oauth-1-default.json');
    await fs.writeFile(
      tokenFile,
      JSON.stringify(
        {
          access_token: 'expired-token',
          refresh_token: 'bad-refresh-token',
          noRefresh: true,
          norefresh: true
        },
        null,
        2
      ) + '\n',
      'utf8'
    );

    const provider = new OpenAIHttpProvider(
      {
        id: 'test-qwen-recovery',
        type: 'openai-http-provider',
        config: {
          providerType: 'openai',
          providerId: 'qwen',
          auth: {
            type: 'qwen-oauth',
            tokenFile
          },
          overrides: {
            baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
            endpoint: '/chat/completions'
          }
        }
      } as unknown as OpenAIStandardConfig,
      emptyDeps
    ) as any;

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const deps = provider.requestExecutor.deps;
      await deps.tryRecoverOAuthAndReplay(
        Object.assign(new Error('invalid access token or token expired'), {
          statusCode: 401,
          status: 401,
          code: 'invalid_api_key'
        }),
        {
          endpoint: '/chat/completions',
          headers: {},
          targetUrl: 'https://portal.qwen.ai/v1/chat/completions',
          body: { model: 'coder-model', messages: [{ role: 'user', content: 'hi' }] },
          wantsSse: false
        },
        { model: 'coder-model', messages: [{ role: 'user', content: 'hi' }] },
        false,
        {
          requestId: 'req-qwen-recovery',
          providerKey: 'qwen.1.coder-model',
          providerId: 'qwen',
          providerType: 'openai',
          metadata: {}
        }
      );

      const output = warnSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(output).toContain('qwen silent refresh permanently failed; standard re-auth required');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
