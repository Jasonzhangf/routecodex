import express from 'express';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function withServer<T>(app: express.Express, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = await new Promise<ReturnType<express.Express['listen']>>((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const address = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

/** Assert canonical { error: { message, code } } shape */
function assertErrorShape(body: unknown, expectedCode: string): void {
  const obj = body as Record<string, unknown>;
  expect(obj).toBeDefined();
  expect(obj.error).toBeDefined();
  const error = obj.error as Record<string, unknown>;
  expect(typeof error.message).toBe('string');
  expect((error.message as string).length).toBeGreaterThan(0);
  expect(error.code).toBe(expectedCode);
  // Old shapes must not leak
  expect(obj.ok).toBeUndefined();
  expect(obj.reason).toBeUndefined();
}

// ═══════════════════════════════════════════════════════════════════
// Shape B: { error: { message, code } } — handler not_ready paths
// ═══════════════════════════════════════════════════════════════════
describe('Shape B: handler 503 not_ready when pipeline is null', () => {
  const cases: Array<[string, string, () => Promise<(req: any, res: any, ctx: any) => Promise<void>>]> = [
    [
      'chat-handler',
      '/v1/chat/completions',
      async () => (await import('../../../src/server/handlers/chat-handler.js')).handleChatCompletions,
    ],
    [
      'messages-handler',
      '/v1/messages',
      async () => (await import('../../../src/server/handlers/messages-handler.js')).handleMessages,
    ],
    [
      'images-handler',
      '/v1/images/generations',
      async () => (await import('../../../src/server/handlers/images-handler.js')).handleImageGenerations,
    ],
    [
      'responses-handler',
      '/v1/responses',
      async () => (await import('../../../src/server/handlers/responses-handler.js')).handleResponses,
    ],
  ];

  for (const [name, route, loadHandler] of cases) {
    it(`${name}: 503 returns { error: { message, code: "not_ready" } }`, async () => {
      const handler = await loadHandler();
      const app = express();
      app.use(express.json());
      app.post(route, (req, res) => handler(req, res, { executePipeline: null, errorHandling: null }));

      await withServer(app, async (baseUrl) => {
        const response = await fetch(`${baseUrl}${route}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'test', messages: [], prompt: 'test', input: 'test' }),
        });
        expect(response.status).toBe(503);
        const body = await response.json();
        assertErrorShape(body, 'not_ready');
        expect(body.error.message).toContain('Hub pipeline runtime not initialized');
      });
    });
  }
});

// ═══════════════════════════════════════════════════════════════════
// Shape C: { error: { message, type, code } } — OpenAI-compat errors
// ═══════════════════════════════════════════════════════════════════
describe('Shape C: OpenAI-compat errors with type + code', () => {
  it('images-handler generations: missing prompt → 400 with type + code', async () => {
    const { handleImageGenerations } = await import('../../../src/server/handlers/images-handler.js');
    const app = express();
    app.use(express.json());
    app.post('/v1/images/generations', (req, res) =>
      handleImageGenerations(req, res, { executePipeline: async () => ({ status: 200, body: {} }), errorHandling: null }),
    );

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/images/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'test' }),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      const error = (body as any).error;
      expect(error).toBeDefined();
      expect(error.message).toBe('prompt is required');
      expect(error.type).toBe('invalid_request_error');
      expect(error.code).toBe('bad_request');
    });
  });

  it('images-handler edits: missing image → 400 with type + code', async () => {
    const { handleImageEdits } = await import('../../../src/server/handlers/images-handler.js');
    const app = express();
    app.use(express.json());
    app.post('/v1/images/edits', (req, res) =>
      handleImageEdits(req, res, { executePipeline: async () => ({ status: 200, body: {} }), errorHandling: null }),
    );

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/images/edits`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'test', prompt: 'hello' }),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      const error = (body as any).error;
      expect(error).toBeDefined();
      expect(error.message).toBe('image is required for /v1/images/edits');
      expect(error.type).toBe('invalid_request_error');
      expect(error.code).toBe('bad_request');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Shape D: session-client-routes register → 400 { error: { message, code } }
// ═══════════════════════════════════════════════════════════════════
describe('Shape D: session-client-routes unified error shape', () => {
  it('/daemon/session-client/register without required fields → 400 { error } not { ok, reason }', async () => {
    const { registerSessionClientRoutes } = await import(
      '../../../src/server/runtime/http-server/session-client-routes.js'
    );

    const app = express();
    app.use(express.json());
    registerSessionClientRoutes(app);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/daemon/session-client/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      assertErrorShape(body, 'bad_request');
      expect(body.error.message).toContain('daemonId and callbackUrl are required');
    });
  });

  it('/daemon/session-client/inject without tmuxSessionId → 400 { error }', async () => {
    const { registerSessionClientRoutes } = await import(
      '../../../src/server/runtime/http-server/session-client-routes.js'
    );

    const app = express();
    app.use(express.json());
    registerSessionClientRoutes(app);

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/daemon/session-client/inject`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      assertErrorShape(body, 'bad_request');
      expect(body.error.message).toContain('tmuxSessionId is required');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Shape E: { error: { message, code }, errors[] } — config-admin
// ═══════════════════════════════════════════════════════════════════
describe('Shape E: config-admin-handler error shapes', () => {
  it('handleValidateUserConfig: empty config → 400 { error, errors }', async () => {
    const { handleValidateUserConfig } = await import('../../../src/server/handlers/config-admin-handler.js');
    const app = express();
    app.use(express.json());
    app.post('/v1/config/validate', (req, res) => handleValidateUserConfig(req, res));

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/config/validate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      assertErrorShape(body, 'bad_request');
      expect(body.error.message).toBe('validation failed');
      expect(body.errors).toBeDefined();
      expect(Array.isArray(body.errors)).toBe(true);
      expect((body.errors as any[]).length).toBeGreaterThan(0);
    });
  });

  it('handleGetUserConfig: non-object config file → 500 { error: { message, type, code } }', async () => {
    const original = process.env.RCC4_CONFIG_PATH;
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-test-'));
    const tmpConfig = path.join(tmpDir, 'config.json');
    try {
      await fs.writeFile(tmpConfig, JSON.stringify([1, 2, 3]));
      process.env.RCC4_CONFIG_PATH = tmpConfig;

      const { handleGetUserConfig } = await import('../../../src/server/handlers/config-admin-handler.js');
      const app = express();
      app.use(express.json());
      app.get('/v1/config', (req, res) => handleGetUserConfig(req, res));

      await withServer(app, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/v1/config`);
        expect(response.status).toBe(500);
        const body = await response.json();
        const error = (body as any).error;
        expect(error).toBeDefined();
        expect(typeof error.message).toBe('string');
        expect(error.type).toBe('config_read_error');
        expect(error.code).toBe('internal_error');
      });
    } finally {
      if (original === undefined) delete process.env.RCC4_CONFIG_PATH;
      else process.env.RCC4_CONFIG_PATH = original;
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('handleSaveUserConfig: validation failure → 400 { error, errors }', async () => {
    const { handleSaveUserConfig } = await import('../../../src/server/handlers/config-admin-handler.js');
    const app = express();
    app.use(express.json());
    app.post('/v1/config/save', (req, res) => handleSaveUserConfig(req, res));

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/config/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      assertErrorShape(body, 'bad_request');
      expect(body.error.message).toBe('validation failed');
      expect(body.errors).toBeDefined();
      expect(Array.isArray(body.errors)).toBe(true);
    });
  });
});

// routes.ts Shape B error paths (500/400/403/503) are covered by:
// - routes.invalid-json.spec.ts (malformed JSON → 400)
// - daemon-admin.e2e.spec.ts (admin auth/restart paths)
// - grep audit: all res.status().json({ error:... }) have `code` field
