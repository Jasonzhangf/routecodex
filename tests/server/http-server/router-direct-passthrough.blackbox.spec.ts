import { jest } from '@jest/globals';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import type { ServerConfigV2 } from '../../../src/server/runtime/http-server/types.js';

function setEnv(name: string, value: string | undefined): () => void {
  const original = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  };
}

function buildServerConfig(configPath: string): ServerConfigV2 {
  return {
    configPath,
    server: { host: '127.0.0.1', port: 0 },
    pipeline: {},
    logging: { level: 'error', enableConsole: false },
    providers: {}
  } as ServerConfigV2;
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

async function closeServer(server?: http.Server): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function routerEnv(tmp: string, options?: { snapshots?: boolean }): Array<() => void> {
  return [
    setEnv('NODE_ENV', 'test'),
    setEnv('RCC_HOME', path.join(tmp, '.rcc')),
    setEnv('RCC_PROVIDER_DIR', path.join(tmp, '.rcc', 'provider')),
    setEnv('ROUTECODEX_PROVIDER_DIR', path.join(tmp, '.rcc', 'provider')),
    setEnv('ROUTECODEX_SNAPSHOT', options?.snapshots ? '1' : undefined),
    setEnv('ROUTECODEX_SNAPSHOT_DIR', options?.snapshots ? path.join(tmp, '.rcc', 'codex-samples') : undefined),
    setEnv('ROUTECODEX_SNAPSHOT_STAGES', options?.snapshots ? 'provider-request,provider-response' : undefined),
    setEnv('ROUTECODEX_AUTH_DIR', path.join(tmp, 'auth')),
    setEnv('ROUTECODEX_STATS_LOG', path.join(tmp, 'stats.json')),
    setEnv('ROUTECODEX_LOGIN_FILE', path.join(tmp, 'login')),
    setEnv('ROUTECODEX_MAX_PROVIDER_ATTEMPTS', '1')
  ];
}

async function writeProviderToml(
  tmp: string,
  providerId: string,
  upstreamPort: number,
  directSemantics?: 'routing' | 'passthrough',
): Promise<void> {
  const dir = path.join(tmp, '.rcc', 'provider', providerId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'config.v2.toml'), [
    'version = "2.0.0"',
    `providerId = "${providerId}"`,
    '',
    '[provider]',
    `id = "${providerId}"`,
    'enabled = true',
    'type = "responses"',
    `baseURL = "http://127.0.0.1:${upstreamPort}/v1"`,
    'transportBackend = "openai-sdk"',
    'defaultModel = "gpt-5.5"',
    '',
    '[provider.auth]',
    'type = "apikey"',
    'keys = { key1 = "sk-test-router-direct-passthrough-1234567890" }',
    '',
    '[provider.responses]',
    'process = "chat"',
    'streaming = "always"',
    '',
    '[provider.models."gpt-5.5"]',
    'supportsStreaming = true',
    'supportsThinking = true',
    'capabilities = ["text", "reasoning", "thinking", "tools"]',
    ...(directSemantics ? [
      '',
      '[provider.models."gpt-5.5".direct]',
      `semantics = "${directSemantics}"`,
    ] : []),
    ''
  ].join('\n'), 'utf8');
}

function buildResponsesProvider(
  upstreamPort: number,
  directSemantics?: 'routing' | 'passthrough',
): Record<string, unknown> {
  return {
    id: 'direct',
    enabled: true,
    type: 'responses',
    baseURL: `http://127.0.0.1:${upstreamPort}/v1`,
    transportBackend: 'openai-sdk',
    defaultModel: 'gpt-5.5',
    auth: { type: 'apikey', entries: [{ alias: 'key1', apiKey: 'sk-test-router-direct-passthrough-1234567890' }] },
    responses: { process: 'chat', streaming: 'always' },
    models: {
      'gpt-5.5': {
        supportsStreaming: true,
        supportsThinking: true,
        capabilities: ['text', 'reasoning', 'thinking', 'tools'],
        ...(directSemantics ? { direct: { semantics: directSemantics } } : {}),
      }
    }
  };
}

function buildNamedResponsesProvider(
  providerId: string,
  upstreamPort: number,
  directSemantics?: 'routing' | 'passthrough',
): Record<string, unknown> {
  return {
    ...buildResponsesProvider(upstreamPort, directSemantics),
    id: providerId,
    auth: { type: 'apikey', entries: [{ alias: 'key1', apiKey: `sk-test-${providerId}-router-direct-1234567890` }] }
  };
}

async function writeRouterConfig(
  configPath: string,
  upstreamPort: number,
  options?: {
    directSemantics?: 'routing' | 'passthrough';
    routeThinking?: 'xhigh' | 'high' | 'medium' | 'low';
  },
): Promise<Record<string, unknown>> {
  const thinkingRoute = {
    id: 'blackbox-thinking',
    mode: 'priority',
    targets: ['direct.key1.gpt-5.5'],
    ...(options?.routeThinking ? { thinking: options.routeThinking } : {}),
  };
  const userConfig = {
    version: '2.0.0',
    virtualrouterMode: 'v2',
    httpserver: {
      ports: [{ port: 0, host: '127.0.0.1', mode: 'router', routingPolicyGroup: 'blackbox', sameProtocolBehavior: 'direct' }]
    },
    virtualrouter: {
      providers: { direct: buildResponsesProvider(upstreamPort, options?.directSemantics) },
      routing: {
        thinking: [thinkingRoute],
        default: [{ id: 'blackbox-default', mode: 'priority', targets: ['direct.key1.gpt-5.5'] }]
      },
      routingPolicyGroups: {
        blackbox: {
          routing: {
            thinking: [thinkingRoute],
            default: [{ id: 'blackbox-default', mode: 'priority', targets: ['direct.key1.gpt-5.5'] }]
          }
        }
      }
    }
  };
  await fs.writeFile(configPath, JSON.stringify(userConfig, null, 2), 'utf8');
  return userConfig;
}

async function writeRouterFailoverConfig(
  configPath: string,
  primaryPort: number,
  backupPort: number,
  options?: {
    primaryDirectSemantics?: 'routing' | 'passthrough';
    backupDirectSemantics?: 'routing' | 'passthrough';
    routeThinking?: 'xhigh' | 'high' | 'medium' | 'low';
  },
): Promise<Record<string, unknown>> {
  const thinkingRoute = {
    id: 'blackbox-thinking',
    mode: 'priority',
    targets: ['primary.key1.gpt-5.5', 'backup.key1.gpt-5.5'],
    ...(options?.routeThinking ? { thinking: options.routeThinking } : {}),
  };
  const userConfig = {
    version: '2.0.0',
    virtualrouterMode: 'v2',
    httpserver: {
      ports: [{ port: 0, host: '127.0.0.1', mode: 'router', routingPolicyGroup: 'blackbox', sameProtocolBehavior: 'direct' }]
    },
    virtualrouter: {
      providers: {
        primary: buildNamedResponsesProvider('primary', primaryPort, options?.primaryDirectSemantics),
        backup: buildNamedResponsesProvider('backup', backupPort, options?.backupDirectSemantics)
      },
      routing: {
        thinking: [thinkingRoute],
        default: [{ id: 'blackbox-default', mode: 'priority', targets: ['primary.key1.gpt-5.5', 'backup.key1.gpt-5.5'] }]
      },
      routingPolicyGroups: {
        blackbox: {
          routing: {
            thinking: [thinkingRoute],
            default: [{ id: 'blackbox-default', mode: 'priority', targets: ['primary.key1.gpt-5.5', 'backup.key1.gpt-5.5'] }]
          }
        }
      }
    }
  };
  await fs.writeFile(configPath, JSON.stringify(userConfig, null, 2), 'utf8');
  return userConfig;
}

async function startRouteCodex(configPath: string, userConfig: Record<string, unknown>): Promise<{ server: { stop: () => Promise<void> }; port: number }> {
  jest.resetModules();
  const { RouteCodexHttpServer } = await import('../../../src/server/runtime/http-server/index.js');
  const server = new RouteCodexHttpServer(buildServerConfig(configPath));
  await server.initializeWithUserConfig(userConfig as any);
  await server.start();
  const raw = (server as unknown as { server?: http.Server }).server;
  const address = raw?.address() as AddressInfo | null;
  if (!address || typeof address.port !== 'number') throw new Error('test server did not bind');
  return { server, port: address.port };
}

describe('router-direct passthrough HTTP blackbox', () => {
  jest.setTimeout(30000);

  it.each([
    {
      label: 'default routing',
      directSemantics: undefined,
      expectedUpstreamModel: 'gpt-5.5',
      expectedUpstreamThinking: 'high',
      expectedUpstreamLegacyThinking: undefined,
      expectedClientModel: 'client-visible-model',
    },
    {
      label: 'explicit passthrough',
      directSemantics: 'passthrough' as const,
      expectedUpstreamModel: 'client-visible-model',
      expectedUpstreamThinking: 'low',
      expectedUpstreamLegacyThinking: 'low',
      expectedClientModel: 'provider-response-model',
    },
  ])('HTTP BLACKBOX: $label applies paired request/response semantic projection', async ({
    directSemantics,
    expectedUpstreamModel,
    expectedUpstreamThinking,
    expectedUpstreamLegacyThinking,
    expectedClientModel,
  }) => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-router-direct-semantic-'));
    const configPath = path.join(tmp, 'config.json');
    let upstreamBody = '';
    const upstream = http.createServer((req, res) => {
      if (req.method === 'POST') {
        req.on('data', (chunk) => { upstreamBody += Buffer.from(chunk).toString('utf8'); });
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            id: 'resp_direct_semantic',
            object: 'response',
            model: 'provider-response-model',
            reasoning_effort: 'xhigh',
            status: 'completed',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
            output_text: 'ok',
          }));
        });
        return;
      }
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    });
    const upstreamPort = await listen(upstream);
    await writeProviderToml(tmp, 'direct', upstreamPort, directSemantics);
    const userConfig = await writeRouterConfig(configPath, upstreamPort, {
      directSemantics,
      routeThinking: 'high',
    });
    const restores = routerEnv(tmp);
    let server: RouteCodexHttpServer | undefined;
    try {
      const started = await startRouteCodex(configPath, userConfig);
      server = started.server;
      const response = await fetch(`http://127.0.0.1:${started.port}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-route-hint': 'thinking',
        },
        body: JSON.stringify({
          model: 'client-visible-model',
          reasoning_effort: 'low',
          reasoning: { effort: 'low', summary: 'auto' },
          input: 'direct semantic projection probe',
          stream: false,
        }),
      });
      const body = await response.json() as Record<string, unknown>;
      const forwarded = JSON.parse(upstreamBody) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(forwarded.model).toBe(expectedUpstreamModel);
      if (expectedUpstreamLegacyThinking === undefined) {
        expect(forwarded).not.toHaveProperty('reasoning_effort');
      } else {
        expect(forwarded.reasoning_effort).toBe(expectedUpstreamLegacyThinking);
      }
      expect((forwarded.reasoning as Record<string, unknown>).effort).toBe(expectedUpstreamThinking);
      expect(body.model).toBe(expectedClientModel);
      expect(body.reasoning_effort).toBe('xhigh');
      expect(JSON.stringify(forwarded)).not.toContain('direct.semantic_policy');
      expect(JSON.stringify(body)).not.toContain('direct.semantic_policy');
    } finally {
      await server?.stop().catch(() => undefined);
      await closeServer(upstream);
      for (const restore of restores.reverse()) restore();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('HTTP BLACKBOX: router-direct responses SSE is passthrough and does not enter response conversion', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-router-direct-passthrough-'));
    const configPath = path.join(tmp, 'config.json');
    const upstreamChunks = [
      'event: routecodex-direct-probe\n',
      'data: {"probe":"must-pass-through-without-hub-response-conversion"}\n\n',
      'data: [DONE]\n\n'
    ];
    let upstreamPostCount = 0;
    let upstreamPath = '';
    let upstreamBody = '';
    const upstream = http.createServer((req, res) => {
      if (req.method === 'POST') {
        upstreamPostCount += 1;
        upstreamPath = req.url || '';
        req.on('data', (chunk) => { upstreamBody += Buffer.from(chunk).toString('utf8'); });
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          for (const chunk of upstreamChunks) res.write(chunk);
          res.end();
        });
        return;
      }
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    });
    const upstreamPort = await listen(upstream);
    await writeProviderToml(tmp, 'direct', upstreamPort);
    const userConfig = await writeRouterConfig(configPath, upstreamPort);
    const restores = routerEnv(tmp);
    let server: RouteCodexHttpServer | undefined;
    try {
      const started = await startRouteCodex(configPath, userConfig);
      server = started.server;
      const response = await fetch(`http://127.0.0.1:${started.port}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'x-route-hint': 'thinking'
        },
        body: JSON.stringify({
          model: 'gpt-5.5',
          input: 'direct passthrough probe',
          stream: true,
          metadata: { sessionId: 'router-direct-passthrough-blackbox' }
        })
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).toContain('event: routecodex-direct-probe');
      expect(text).toContain('must-pass-through-without-hub-response-conversion');
      expect(text).toContain('data: [DONE]');
      expect(text).not.toContain('missing choices');
      expect(text).not.toContain('hub_pipeline_resp_client_remap_failed');
      expect(upstreamPostCount).toBe(1);
      expect(upstreamPath).toBe('/v1/responses');
      expect(JSON.parse(upstreamBody).model).toBe('gpt-5.5');
    } finally {
      await server?.stop().catch(() => undefined);
      await closeServer(upstream);
      for (const restore of restores.reverse()) restore();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('HTTP BLACKBOX: router-direct JSON does not remap as chat choices', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-router-direct-json-passthrough-'));
    const configPath = path.join(tmp, 'config.json');
    const upstreamBodyObject = {
      id: 'resp_direct_json_passthrough',
      object: 'response',
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'direct-json-ok' }] }],
      output_text: 'direct-json-ok'
    };
    let upstreamPostCount = 0;
    let upstreamPath = '';
    const upstream = http.createServer((req, res) => {
      if (req.method === 'POST') {
        upstreamPostCount += 1;
        upstreamPath = req.url || '';
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(upstreamBodyObject));
        });
        return;
      }
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    });
    const upstreamPort = await listen(upstream);
    await writeProviderToml(tmp, 'direct', upstreamPort);
    const userConfig = await writeRouterConfig(configPath, upstreamPort);
    const restores = routerEnv(tmp);
    let server: RouteCodexHttpServer | undefined;
    try {
      const started = await startRouteCodex(configPath, userConfig);
      server = started.server;
      const response = await fetch(`http://127.0.0.1:${started.port}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-route-hint': 'thinking'
        },
        body: JSON.stringify({
          model: 'gpt-5.5',
          input: 'direct json passthrough probe',
          stream: false,
          metadata: { sessionId: 'router-direct-json-passthrough-blackbox' }
        })
      });
      const text = await response.text();
      const body = JSON.parse(text) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body).toEqual(upstreamBodyObject);
      expect(text).not.toContain('missing choices');
      expect(text).not.toContain('hub_pipeline_resp_client_remap_failed');
      expect(upstreamPostCount).toBe(1);
      expect(upstreamPath).toBe('/v1/responses');
    } finally {
      await server?.stop().catch(() => undefined);
      await closeServer(upstream);
      for (const restore of restores.reverse()) restore();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('HTTP BLACKBOX: router-direct accepts repeated sequential Responses call_id history', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-router-direct-repeated-callid-'));
    const configPath = path.join(tmp, 'config.json');
    let upstreamPostCount = 0;
    let upstreamBody = '';
    const upstream = http.createServer((req, res) => {
      if (req.method === 'POST') {
        upstreamPostCount += 1;
        req.on('data', (chunk) => { upstreamBody += Buffer.from(chunk).toString('utf8'); });
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            id: 'resp_repeated_callid_ok',
            object: 'response',
            status: 'completed',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
            output_text: 'ok'
          }));
        });
        return;
      }
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    });
    const upstreamPort = await listen(upstream);
    await writeProviderToml(tmp, 'direct', upstreamPort);
    const userConfig = await writeRouterConfig(configPath, upstreamPort);
    const restores = routerEnv(tmp);
    let server: RouteCodexHttpServer | undefined;
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(' '));
      originalWarn(...args);
    };
    try {
      const started = await startRouteCodex(configPath, userConfig);
      server = started.server;
      const response = await fetch(`http://127.0.0.1:${started.port}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-route-hint': 'thinking'
        },
        body: JSON.stringify({
          model: 'gpt-5.5',
          stream: false,
          input: [
            { role: 'user', content: 'run first command' },
            { type: 'function_call', call_id: 'call_1', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
            { type: 'function_call_output', call_id: 'call_1', output: 'first output' },
            { role: 'user', content: 'run second command' },
            { type: 'function_call', call_id: 'call_1', name: 'exec_command', arguments: '{"cmd":"ls"}' },
            { type: 'function_call_output', call_id: 'call_1', output: 'second output' },
            { role: 'user', content: 'continue' }
          ],
          tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } }],
          metadata: { sessionId: 'router-direct-repeated-callid-blackbox' }
        })
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).not.toContain('orphan_tool_result');
      expect(upstreamPostCount).toBe(1);
      const forwarded = JSON.parse(upstreamBody) as { input?: unknown[] };
      expect(Array.isArray(forwarded.input)).toBe(true);
      expect(warnings.join('\n')).not.toContain('clearUnresolvedResponsesConversationRequests not available');
    } finally {
      console.warn = originalWarn;
      await server?.stop().catch(() => undefined);
      await closeServer(upstream);
      for (const restore of restores.reverse()) restore();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('HTTP BLACKBOX: router-direct failure forces provider request/response snapshots', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-router-direct-failure-snapshots-'));
    const configPath = path.join(tmp, 'config.json');
    let upstreamPostCount = 0;
    const upstream = http.createServer((req, res) => {
      if (req.method === 'POST') {
        upstreamPostCount += 1;
        req.resume();
        req.on('end', () => {
          res.writeHead(520, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            error: {
              message: 'upstream exploded',
              type: 'upstream_error',
              code: 'HTTP_520'
            }
          }));
        });
        return;
      }
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    });
    const upstreamPort = await listen(upstream);
    await writeProviderToml(tmp, 'direct', upstreamPort);
    const userConfig = await writeRouterConfig(configPath, upstreamPort);
    const restores = routerEnv(tmp, { snapshots: true });
    let server: RouteCodexHttpServer | undefined;
    try {
      const started = await startRouteCodex(configPath, userConfig);
      server = started.server;
      const response = await fetch(`http://127.0.0.1:${started.port}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-route-hint': 'thinking'
        },
        body: JSON.stringify({
          model: 'gpt-5.5',
          input: 'direct failure sample capture probe',
          stream: false,
          metadata: { sessionId: 'router-direct-failure-snapshot-blackbox' }
        })
      });
      const bodyText = await response.text();

      expect(response.status).toBe(502);
      expect(bodyText).toContain('HTTP_520');
      expect(upstreamPostCount).toBe(1);

      const sampleRoot = path.join(tmp, '.rcc', 'codex-samples', 'openai-responses');
      const requestFile = await findSnapshotFile(sampleRoot, 'provider-request.json');
      const responseFile = await findSnapshotFile(sampleRoot, 'provider-response.json');
      expect(requestFile).toBeTruthy();
      expect(responseFile).toBeTruthy();

      const requestSample = JSON.parse(await fs.readFile(requestFile!, 'utf8')) as Record<string, unknown>;
      const responseSample = JSON.parse(await fs.readFile(responseFile!, 'utf8')) as Record<string, unknown>;
      expect(JSON.stringify(requestSample)).toContain('direct failure sample capture probe');
      expect(JSON.stringify(responseSample)).toContain('HTTP_520');
    } finally {
      await server?.stop().catch(() => undefined);
      await closeServer(upstream);
      for (const restore of restores.reverse()) restore();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('HTTP BLACKBOX: router-direct upstream error switches to backup provider', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-router-direct-failover-'));
    const configPath = path.join(tmp, 'config.json');
    let primaryPostCount = 0;
    let backupPostCount = 0;
    const primary = http.createServer((req, res) => {
      if (req.method === 'POST') {
        primaryPostCount += 1;
        req.resume();
        req.on('end', () => {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'primary upstream failed', code: 'HTTP_502' } }));
        });
        return;
      }
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    });
    const backup = http.createServer((req, res) => {
      if (req.method === 'POST') {
        backupPostCount += 1;
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            id: 'resp_router_direct_failover_ok',
            object: 'response',
            status: 'completed',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'backup-ok' }] }],
            output_text: 'backup-ok'
          }));
        });
        return;
      }
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    });
    const primaryPort = await listen(primary);
    const backupPort = await listen(backup);
    await writeProviderToml(tmp, 'primary', primaryPort);
    await writeProviderToml(tmp, 'backup', backupPort);
    const userConfig = await writeRouterFailoverConfig(configPath, primaryPort, backupPort);
    const restores = routerEnv(tmp);
    let server: RouteCodexHttpServer | undefined;
    try {
      const started = await startRouteCodex(configPath, userConfig);
      server = started.server;
      const response = await fetch(`http://127.0.0.1:${started.port}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-route-hint': 'thinking'
        },
        body: JSON.stringify({
          model: 'gpt-5.5',
          input: 'router direct failover probe',
          stream: false,
          metadata: { sessionId: 'router-direct-failover-blackbox' }
        })
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).toContain('backup-ok');
      expect(text).not.toContain('primary upstream failed');
      expect(text).not.toContain('Upstream provider error');
      expect(primaryPostCount).toBe(1);
      expect(backupPostCount).toBe(1);
    } finally {
      await server?.stop().catch(() => undefined);
      await closeServer(primary);
      await closeServer(backup);
      for (const restore of restores.reverse()) restore();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('HTTP BLACKBOX: retry resolves the new real target direct semantic policy', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-router-direct-semantic-retry-'));
    const configPath = path.join(tmp, 'config.json');
    let primaryBody = '';
    let backupBody = '';
    const primary = http.createServer((req, res) => {
      if (req.method === 'POST') {
        req.on('data', (chunk) => { primaryBody += Buffer.from(chunk).toString('utf8'); });
        req.on('end', () => {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'primary failed', code: 'HTTP_502' } }));
        });
        return;
      }
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    });
    const backup = http.createServer((req, res) => {
      if (req.method === 'POST') {
        req.on('data', (chunk) => { backupBody += Buffer.from(chunk).toString('utf8'); });
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            id: 'resp_semantic_retry',
            object: 'response',
            model: 'backup-provider-model',
            reasoning_effort: 'xhigh',
            status: 'completed',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'backup-ok' }] }],
            output_text: 'backup-ok',
          }));
        });
        return;
      }
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    });
    const primaryPort = await listen(primary);
    const backupPort = await listen(backup);
    await writeProviderToml(tmp, 'primary', primaryPort, 'passthrough');
    await writeProviderToml(tmp, 'backup', backupPort, 'routing');
    const userConfig = await writeRouterFailoverConfig(configPath, primaryPort, backupPort, {
      primaryDirectSemantics: 'passthrough',
      backupDirectSemantics: 'routing',
      routeThinking: 'high',
    });
    const restores = routerEnv(tmp);
    let server: RouteCodexHttpServer | undefined;
    try {
      const started = await startRouteCodex(configPath, userConfig);
      server = started.server;
      const response = await fetch(`http://127.0.0.1:${started.port}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-route-hint': 'thinking',
        },
        body: JSON.stringify({
          model: 'client-visible-model',
          reasoning_effort: 'low',
          reasoning: { effort: 'low' },
          input: 'semantic retry probe',
          stream: false,
        }),
      });
      const body = await response.json() as Record<string, unknown>;
      const primaryForwarded = JSON.parse(primaryBody) as Record<string, unknown>;
      const backupForwarded = JSON.parse(backupBody) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(primaryForwarded.model).toBe('client-visible-model');
      expect(primaryForwarded.reasoning_effort).toBe('low');
      expect(backupForwarded.model).toBe('gpt-5.5');
      expect(backupForwarded).not.toHaveProperty('reasoning_effort');
      expect((backupForwarded.reasoning as Record<string, unknown>).effort).toBe('high');
      expect(body.model).toBe('client-visible-model');
      expect(body.reasoning_effort).toBe('xhigh');
    } finally {
      await server?.stop().catch(() => undefined);
      await closeServer(primary);
      await closeServer(backup);
      for (const restore of restores.reverse()) restore();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('HTTP BLACKBOX: stopMessage includeDirect keeps /v1/responses same-protocol requests on direct passthrough', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-router-direct-stopless-relay-'));
    const configPath = path.join(tmp, 'config.json');
    let upstreamPostCount = 0;
    const upstream = http.createServer((req, res) => {
      if (req.method === 'POST') {
        upstreamPostCount += 1;
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('event: response.created\n');
          res.write('data: {"type":"response.created","response":{"id":"resp_direct_stopless_relay","object":"response","status":"in_progress","output":[]}}\n\n');
          res.write('event: response.output_item.added\n');
          res.write('data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_direct_stopless_relay","type":"message","role":"assistant","status":"in_progress","content":[]}}\n\n');
          res.write('event: response.output_text.delta\n');
          res.write('data: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_direct_stopless_relay","content_index":0,"delta":"阶段完成，但还需要继续执行。"}\n\n');
          res.write('event: response.output_text.done\n');
          res.write('data: {"type":"response.output_text.done","output_index":0,"item_id":"msg_direct_stopless_relay","content_index":0,"text":"阶段完成，但还需要继续执行。"}\n\n');
          res.write('event: response.output_item.done\n');
          res.write('data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_direct_stopless_relay","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"阶段完成，但还需要继续执行。"}]}}\n\n');
          res.write('event: response.completed\n');
          res.write('data: {"type":"response.completed","response":{"id":"resp_direct_stopless_relay","object":"response","status":"completed","output":[{"id":"msg_direct_stopless_relay","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"阶段完成，但还需要继续执行。"}]}],"output_text":"阶段完成，但还需要继续执行。"}}\n\n');
          res.write('event: response.done\n');
          res.write('data: {"type":"response.done","response":{"id":"resp_direct_stopless_relay","object":"response","status":"completed","output":[{"id":"msg_direct_stopless_relay","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"阶段完成，但还需要继续执行。"}]}],"output_text":"阶段完成，但还需要继续执行。"}}\n\n');
          res.end();
        });
        return;
      }
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    });
    const upstreamPort = await listen(upstream);
    await writeProviderToml(tmp, 'direct', upstreamPort);
    const userConfig = await writeRouterConfig(configPath, upstreamPort);
    (userConfig as any).httpserver.ports[0].stopMessage = { enabled: true, includeDirect: true };
    const restores = routerEnv(tmp);
    let server: RouteCodexHttpServer | undefined;
    try {
      const started = await startRouteCodex(configPath, userConfig);
      server = started.server;
      const response = await fetch(`http://127.0.0.1:${started.port}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-route-hint': 'thinking'
        },
        body: JSON.stringify({
          model: 'gpt-5.5',
          input: [{ role: 'user', content: [{ type: 'input_text', text: '继续执行当前任务' }] }],
          stream: true,
          metadata: { sessionId: 'router-direct-stopless-relay-blackbox' }
        })
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(upstreamPostCount).toBe(1);
      expect(text).toContain('resp_direct_stopless_relay');
      expect(text).toContain('阶段完成，但还需要继续执行。');
      expect(text).not.toContain('exec_command');
      expect(text).not.toContain('routecodex hook run reasoning_stop');
      expect(text).not.toContain('stop_message_flow');
      expect(text).not.toContain('requires_action');
    } finally {
      await server?.stop().catch(() => undefined);
      await closeServer(upstream);
      for (const restore of restores.reverse()) restore();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

async function findSnapshotFile(root: string, fileName: string): Promise<string | undefined> {
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name === fileName) {
        return fullPath;
      }
    }
  }
  return undefined;
}
