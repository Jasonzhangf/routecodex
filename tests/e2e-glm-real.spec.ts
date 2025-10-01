/**
 * GLM Real E2E (opt-in)
 * Runs only when RUN_REAL_E2E=1 and a real GLM key is available
 */

import { GLMHTTPProvider } from '../src/modules/pipeline/modules/provider/glm-http-provider.js';

const hasFlag = (name: string) => String(process.env[name] || '').trim() === '1';

async function getGlmKey(): Promise<string | null> {
  if (process.env.GLM_API_KEY && String(process.env.GLM_API_KEY).trim()) {
    return String(process.env.GLM_API_KEY).trim();
  }
  try {
    const { homedir } = await import('os');
    const { readFile } = await import('fs/promises');
    const { join } = await import('path');
    const raw = await readFile(join(homedir(), '.routecodex', 'config.json'), 'utf-8');
    const j = JSON.parse(raw);
    const key = j?.virtualrouter?.providers?.glm?.apiKey?.[0];
    if (typeof key === 'string' && key && key !== '***REDACTED***') {
      return key;
    }
  } catch {
    // ignore
  }
  return null;
}

describe('GLM real e2e (opt-in)', () => {
  const run = hasFlag('RUN_REAL_E2E');
  const maybe = run ? it : it.skip;

  maybe('sends a real request via GLMHTTPProvider', async () => {
    const key = await getGlmKey();
    if (!key) {
      console.warn('GLM key not found; skipping real e2e');
      return;
    }

    const providerConfig = {
      type: 'glm-http-provider',
      config: {
        type: 'glm',
        baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
        auth: { type: 'apikey', apiKey: key }
      }
    } as any;

    const noopLogger = {
      logError: () => {},
      logModule: () => {},
    } as any;

    const provider = new GLMHTTPProvider(providerConfig as any, { logger: noopLogger } as any);
    await provider.initialize();

    const res = await provider.sendRequest({
      model: 'glm-4.6',
      messages: [{ role: 'user', content: '说一句：E2E 测试通过' }],
      temperature: 0.2,
      max_tokens: 32
    } as any);

    expect(res.status).toBe(200);
    expect(typeof res.data).toBe('object');
  }, 20000);
});

