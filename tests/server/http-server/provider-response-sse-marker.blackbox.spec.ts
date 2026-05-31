import { jest } from '@jest/globals';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { RouteCodexHttpServer } from '../../../src/server/runtime/http-server/index.js';
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

async function closeServer(server?: http.Server): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function anthropicProvider(id: string, port: number, alias = 'key1'): Record<string, unknown> {
  return {
    id,
    enabled: true,
    type: 'anthropic',
    baseURL: `http://127.0.0.1:${port}`,
    auth: { type: 'apikey', entries: [{ alias, type: 'apikey', value: `test-${id}-${alias}` }] },
    models: { 'mimo-v2.5': { supportsStreaming: true, capabilities: ['text', 'tools'] } },
    extensions: { transportBackend: 'vercel-ai-sdk' }
  };
}

async function writeProviderConfig(root: string, providerId: string, provider: Record<string, unknown>): Promise<void> {
  const dir = path.join(root, '.rcc', 'provider', providerId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'config.v2.json'), JSON.stringify({ version: '2.0.0', provider }, null, 2), 'utf8');
}

async function writeRouterConfig(args: {
  tmp: string;
  configPath: string;
  routingPolicyGroup: string;
  providers: Record<string, Record<string, unknown>>;
  targets: string[];
}): Promise<Record<string, unknown>> {
  const userConfig = {
    version: '2.0.0',
    virtualrouterMode: 'v2',
    httpserver: {
      ports: [{ port: 0, host: '127.0.0.1', mode: 'router', routingPolicyGroup: args.routingPolicyGroup, sameProtocolBehavior: 'relay', stopMessage: { enabled: false } }]
    },
    virtualrouter: {
      providers: args.providers,
      routingPolicyGroups: {
        [args.routingPolicyGroup]: {
          routing: {
            thinking: [{ id: `${args.routingPolicyGroup}-thinking`, mode: 'priority', targets: args.targets }],
            default: [{ id: `${args.routingPolicyGroup}-default`, mode: 'priority', targets: args.targets }]
          }
        }
      }
    }
  };
  await fs.writeFile(args.configPath, JSON.stringify(userConfig, null, 2), 'utf8');
  for (const [providerId, provider] of Object.entries(args.providers)) {
    await writeProviderConfig(args.tmp, providerId, provider);
  }
  return userConfig;
}

function routerEnv(tmp: string, maxAttempts: string): Array<() => void> {
  return [
    setEnv('NODE_ENV', 'test'),
    setEnv('RCC_HOME', path.join(tmp, '.rcc')),
    setEnv('ROUTECODEX_SNAPSHOT', '0'),
    setEnv('ROUTECODEX_AUTH_DIR', path.join(tmp, 'auth')),
    setEnv('ROUTECODEX_STATS_LOG', path.join(tmp, 'stats.json')),
    setEnv('ROUTECODEX_LOGIN_FILE', path.join(tmp, 'login')),
    setEnv('ROUTECODEX_MAX_PROVIDER_ATTEMPTS', maxAttempts)
  ];
}

async function startRouteCodex(configPath: string, userConfig: Record<string, unknown>): Promise<{ server: RouteCodexHttpServer; port: number }> {
  const server = new RouteCodexHttpServer(buildServerConfig(configPath));
  await server.initializeWithUserConfig(userConfig as any);
  await server.start();
  const raw = (server as unknown as { server?: http.Server }).server;
  const address = raw?.address() as AddressInfo | null;
  if (!address || typeof address.port !== 'number') throw new Error('test server did not bind');
  return { server, port: address.port };
}

function responseRequestBody(sessionId: string): Record<string, unknown> {
  return {
    model: 'gpt-5.5',
    input: 'hello',
    stream: true,
    metadata: { routeHint: 'thinking', sessionId }
  };
}

function postAndDestroy(url: URL, body: Record<string, unknown>, delayMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { accept: 'text/event-stream', 'content-type': 'application/json' }
    }, (response) => {
      response.resume();
      response.on('end', resolve);
    });
    request.on('error', () => resolve());
    const timer = setTimeout(() => {
      request.destroy();
      resolve();
    }, delayMs);
    timer.unref?.();
    request.on('close', () => clearTimeout(timer));
    request.end(JSON.stringify(body));
  });
}

function malformedAnthropicMessage(id: string): Record<string, unknown> {
  return {
    id,
    type: 'message',
    role: 'assistant',
    model: 'mimo-v2.5',
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 }
  };
}

function validAnthropicMessage(id: string, text: string): Record<string, unknown> {
  return {
    id,
    type: 'message',
    role: 'assistant',
    model: 'mimo-v2.5',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 }
  };
}

describe('provider response SSE marker HTTP blackbox', () => {
  jest.setTimeout(30000);

  it('HTTP BLACKBOX: Anthropic provider SSE response enters inbound remap before Responses output', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-anthropic-inbound-blackbox-'));
    const configPath = path.join(tmp, 'config.json');
    let providerRequestHits = 0;
    const upstream = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/messages') {
        providerRequestHits += 1;
        req.resume();
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: message_start\n');
        res.write('data: {"type":"message_start","message":{"id":"msg_anthropic_inbound_sse","type":"message","role":"assistant","model":"mimo-v2.5","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n');
        res.write('event: content_block_start\n');
        res.write('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
        res.write('event: content_block_delta\n');
        res.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"anthropic inbound ok"}}\n\n');
        res.write('event: content_block_stop\n');
        res.write('data: {"type":"content_block_stop","index":0}\n\n');
        res.write('event: message_delta\n');
        res.write('data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}\n\n');
        res.write('event: message_stop\n');
        res.write('data: {"type":"message_stop"}\n\n');
        res.end();
        return;
      }
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    });
    const upstreamPort = await listen(upstream);
    const userConfig = await writeRouterConfig({
      tmp,
      configPath,
      routingPolicyGroup: 'anthropicinbound',
      providers: { mimo: anthropicProvider('mimo', upstreamPort, 'key2') },
      targets: ['mimo.key2.mimo-v2.5']
    });
    const restores = routerEnv(tmp, '1');
    let server: RouteCodexHttpServer | undefined;
    try {
      const started = await startRouteCodex(configPath, userConfig);
      server = started.server;
      const response = await fetch(`http://127.0.0.1:${started.port}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(responseRequestBody('anthropic-inbound-blackbox'))
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).toContain('anthropic inbound ok');
      expect(text).not.toContain('Anthropic response must contain content array');
      expect(text).not.toContain('missing choices');
      expect(providerRequestHits).toBe(1);
    } finally {
      await server?.stop().catch(() => undefined);
      await closeServer(upstream);
      for (const restore of restores.reverse()) restore();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('HTTP BLACKBOX: empty Anthropic upstream SSE fails in Rust inbound canonicalization', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-sse-marker-blackbox-'));
    const configPath = path.join(tmp, 'config.json');
    let providerRequestHits = 0;
    let healthCheckHits = 0;
    const upstream = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/messages') providerRequestHits += 1;
      if (req.method === 'GET' && req.url === '/models') healthCheckHits += 1;
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end();
    });
    const upstreamPort = await listen(upstream);
    const userConfig = await writeRouterConfig({
      tmp,
      configPath,
      routingPolicyGroup: 'blackbox',
      providers: { mimo: anthropicProvider('mimo', upstreamPort, 'key2') },
      targets: ['mimo.key2.mimo-v2.5']
    });
    const restores = routerEnv(tmp, '1');
    let server: RouteCodexHttpServer | undefined;
    try {
      const started = await startRouteCodex(configPath, userConfig);
      server = started.server;
      const response = await fetch(`http://127.0.0.1:${started.port}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(responseRequestBody('sse-marker-blackbox'))
      });
      const text = await response.text();

      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(text).toContain('hub_pipeline_resp_anthropic_chat_canonicalize_failed');
      expect(text).toContain('Anthropic response must contain content array');
      expect(providerRequestHits).toBe(1);
      expect(healthCheckHits).toBeGreaterThanOrEqual(0);
    } finally {
      await server?.stop().catch(() => undefined);
      await closeServer(upstream);
      for (const restore of restores.reverse()) restore();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('HTTP BLACKBOX: client disconnect stops provider retry and reroute after upstream 503', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-client-abort-blackbox-'));
    const configPath = path.join(tmp, 'config.json');
    let primaryPosts = 0;
    let backupPosts = 0;
    const timers = new Set<NodeJS.Timeout>();
    const primary = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/messages') {
        primaryPosts += 1;
        req.resume();
        const timer = setTimeout(() => {
          timers.delete(timer);
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'upstream unavailable' } }));
        }, 250);
        timers.add(timer);
        return;
      }
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    });
    const backup = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/messages') backupPosts += 1;
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(validAnthropicMessage('msg_backup_should_not_run', 'backup should not run after client abort')));
    });
    const primaryPort = await listen(primary);
    const backupPort = await listen(backup);
    const userConfig = await writeRouterConfig({
      tmp,
      configPath,
      routingPolicyGroup: 'abortbox',
      providers: { primary: anthropicProvider('primary', primaryPort), backup: anthropicProvider('backup', backupPort) },
      targets: ['primary.key1.mimo-v2.5', 'backup.key1.mimo-v2.5']
    });
    const restores = routerEnv(tmp, '3');
    let server: RouteCodexHttpServer | undefined;
    try {
      const started = await startRouteCodex(configPath, userConfig);
      server = started.server;
      await postAndDestroy(new URL(`http://127.0.0.1:${started.port}/v1/responses`), responseRequestBody('client-abort-blackbox'), 40);
      await new Promise((resolve) => setTimeout(resolve, 700));

      expect(primaryPosts).toBe(1);
      expect(backupPosts).toBe(0);
    } finally {
      for (const timer of timers) clearTimeout(timer);
      await server?.stop().catch(() => undefined);
      await closeServer(primary);
      await closeServer(backup);
      for (const restore of restores.reverse()) restore();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('HTTP BLACKBOX: client disconnect stops reroute after provider response conversion failure', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-client-abort-convert-blackbox-'));
    const configPath = path.join(tmp, 'config.json');
    let primaryPosts = 0;
    let backupPosts = 0;
    const timers = new Set<NodeJS.Timeout>();
    const primary = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/messages') {
        primaryPosts += 1;
        req.resume();
        const timer = setTimeout(() => {
          timers.delete(timer);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(malformedAnthropicMessage('msg_malformed_after_client_abort')));
        }, 250);
        timers.add(timer);
        return;
      }
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    });
    const backup = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/messages') backupPosts += 1;
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(validAnthropicMessage('msg_backup_should_not_run_after_convert_abort', 'backup should not run after conversion abort')));
    });
    const primaryPort = await listen(primary);
    const backupPort = await listen(backup);
    const userConfig = await writeRouterConfig({
      tmp,
      configPath,
      routingPolicyGroup: 'abortconvert',
      providers: { primary: anthropicProvider('primary', primaryPort), backup: anthropicProvider('backup', backupPort) },
      targets: ['primary.key1.mimo-v2.5', 'backup.key1.mimo-v2.5']
    });
    const restores = routerEnv(tmp, '3');
    let server: RouteCodexHttpServer | undefined;
    try {
      const started = await startRouteCodex(configPath, userConfig);
      server = started.server;
      await postAndDestroy(new URL(`http://127.0.0.1:${started.port}/v1/responses`), responseRequestBody('client-abort-convert-blackbox'), 40);
      await new Promise((resolve) => setTimeout(resolve, 900));

      expect(primaryPosts).toBe(1);
      expect(backupPosts).toBe(0);
    } finally {
      for (const timer of timers) clearTimeout(timer);
      await server?.stop().catch(() => undefined);
      await closeServer(primary);
      await closeServer(backup);
      for (const restore of restores.reverse()) restore();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('HTTP BLACKBOX: provider response conversion failure is not provider failover input', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rcc-convert-failfast-blackbox-'));
    const configPath = path.join(tmp, 'config.json');
    let primaryPosts = 0;
    let backupPosts = 0;
    const primary = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/messages') {
        primaryPosts += 1;
        req.resume();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(malformedAnthropicMessage('msg_malformed_no_failover')));
        return;
      }
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    });
    const backup = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/messages') backupPosts += 1;
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(validAnthropicMessage('msg_backup_must_not_hide_conversion_error', 'backup must not hide conversion error')));
    });
    const primaryPort = await listen(primary);
    const backupPort = await listen(backup);
    const userConfig = await writeRouterConfig({
      tmp,
      configPath,
      routingPolicyGroup: 'convertfailfast',
      providers: { primary: anthropicProvider('primary', primaryPort), backup: anthropicProvider('backup', backupPort) },
      targets: ['primary.key1.mimo-v2.5', 'backup.key1.mimo-v2.5']
    });
    const restores = routerEnv(tmp, '3');
    let server: RouteCodexHttpServer | undefined;
    try {
      const started = await startRouteCodex(configPath, userConfig);
      server = started.server;
      const response = await fetch(`http://127.0.0.1:${started.port}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(responseRequestBody('convert-failfast-blackbox'))
      });
      const text = await response.text();

      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(text).toContain('hub_pipeline_resp_anthropic_chat_canonicalize_failed');
      expect(text).not.toContain('backup must not hide conversion error');
      expect(primaryPosts).toBe(1);
      expect(backupPosts).toBe(0);
    } finally {
      await server?.stop().catch(() => undefined);
      await closeServer(primary);
      await closeServer(backup);
      for (const restore of restores.reverse()) restore();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
