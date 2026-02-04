import { jest } from '@jest/globals';

type ServerCtor = new (...args: any[]) => any;

async function createServer(): Promise<any> {
  const mod = await import('../../../src/server/runtime/http-server/index.js');
  const RouteCodexHttpServer = (mod as unknown as { RouteCodexHttpServer: ServerCtor }).RouteCodexHttpServer;
  return new RouteCodexHttpServer({
    server: { host: '127.0.0.1', port: 0 },
    pipeline: {},
    logging: { level: 'error', enableConsole: false },
    providers: {}
  });
}

describe('apikey secret resolution', () => {
  jest.setTimeout(10_000);

  it('resolves ${VAR} in auth.value for apikey', async () => {
    const server = await createServer();
    process.env.TEST_API_KEY = 'dummy-apikey';
    const runtime = { runtimeKey: 'test', providerId: 'test', auth: { type: 'apikey' } };
    const auth = { type: 'apikey', value: '${TEST_API_KEY}' };
    const resolved = await (server as any).resolveApiKeyValue(runtime, auth);
    expect(resolved).toBe('dummy-apikey');
    delete process.env.TEST_API_KEY;
  });

  it('keeps inline apikey as-is when not a reference', async () => {
    const server = await createServer();
    const runtime = { runtimeKey: 'test', providerId: 'test', auth: { type: 'apikey' } };
    const auth = { type: 'apikey', value: 'sk-plaintext' };
    const resolved = await (server as any).resolveApiKeyValue(runtime, auth);
    expect(resolved).toBe('sk-plaintext');
  });

  it('fails fast when env var is missing', async () => {
    const server = await createServer();
    delete process.env.MISSING_API_KEY;
    const runtime = { runtimeKey: 'test', providerId: 'test', auth: { type: 'apikey' } };
    const auth = { type: 'apikey', value: '${MISSING_API_KEY}' };
    await expect((server as any).resolveApiKeyValue(runtime, auth)).rejects.toThrow('MISSING_API_KEY');
  });

  it('allows empty apikey for local baseURL and ignores unsafe secretRef', async () => {
    const server = await createServer();
    const runtime = {
      runtimeKey: 'lmstudio.key1',
      providerId: 'lmstudio',
      baseURL: 'http://127.0.0.1:1234/v1',
      auth: { type: 'apikey' }
    };
    const auth = { type: 'apikey', value: '', secretRef: 'lmstudio.key1' };
    const resolved = await (server as any).resolveApiKeyValue(runtime, auth);
    expect(resolved).toBe('');
  });

  it('does not treat unsafe secretRef as a secret for remote providers', async () => {
    const server = await createServer();
    const runtime = {
      runtimeKey: 'openai.key1',
      providerId: 'openai',
      baseURL: 'https://api.example.invalid/v1',
      auth: { type: 'apikey' }
    };
    const auth = { type: 'apikey', value: '', secretRef: 'openai.key1' };
    await expect((server as any).resolveApiKeyValue(runtime, auth)).rejects.toThrow(/missing api key/i);
  });
});
