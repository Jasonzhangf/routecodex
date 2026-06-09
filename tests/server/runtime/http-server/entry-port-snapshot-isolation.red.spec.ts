import { afterEach, describe, expect, it } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import http, { type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { FileSnapshotStore } from '../../../../src/debug/snapshot-store.js';
import { buildHttpHandlerContext } from '../../../../src/server/runtime/http-server/http-server-lifecycle.js';
import {
  closePortLogConsoleRouterFiles,
  installPortLogConsoleRouter,
  runWithPortRequestContext
} from '../../../../src/server/runtime/http-server/port-log-context.js';
import { registerHttpRoutes } from '../../../../src/server/runtime/http-server/routes.js';

function listen(app: express.Application): Promise<{ server: Server; port: number }> {
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('missing-listen-address'));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

describe('http entry port snapshot isolation red tests', () => {
  const originalPortLogRoot = process.env.ROUTECODEX_PORT_LOG_ROOT;
  const openedServers: Server[] = [];

  afterEach(async () => {
    process.env.ROUTECODEX_PORT_LOG_ROOT = originalPortLogRoot;
    closePortLogConsoleRouterFiles();
    while (openedServers.length > 0) {
      await close(openedServers.pop() as Server);
    }
  });

  it('routes chat, anthropic messages, and responses snapshots by entry protocol and listener port', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-entry-port-'));
    const logRoot = path.join(root, 'logs');
    const snapshotRoot = path.join(root, 'snapshots');
    process.env.ROUTECODEX_PORT_LOG_ROOT = logRoot;
    installPortLogConsoleRouter();

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    const snapshotStore = new FileSnapshotStore(snapshotRoot);
    const captures: Array<{ endpoint: string; protocol: string; port: number; group: string }> = [];
    const portGroups = new Map<number, string>();
    const serverRuntime = {
      errorHandling: null,
      getPortConfigForLocalPort: (port: number) => {
        const group = portGroups.get(port);
        return group ? { port, mode: 'router', routingPolicyGroup: group } : undefined;
      },
      getPortConfigs: () => Array.from(portGroups.entries()).map(([port, routingPolicyGroup]) => ({
        port,
        mode: 'router',
        routingPolicyGroup
      })),
      executePortAwarePipeline: async (_localPort: number, input: any) => {
        const metadata = input.metadata ?? {};
        const protocol = String(metadata.providerProtocol);
        const port = Number(metadata.matchedPort);
        const group = String(metadata.routingPolicyGroup);
        captures.push({ endpoint: input.entryEndpoint, protocol, port, group });
        console.log(`[entry-port-test] protocol=${protocol} port=${port} group=${group}`);
        await snapshotStore.save({
          sessionId: `${protocol}-${port}`,
          nodeId: 'client-request',
          stage: 'client-request',
          direction: 'request',
          payload: { endpoint: input.entryEndpoint, providerKey: 'mimo.key1.mimo-v2.5' },
          timestamp: 1,
          metadata: {
            entryProtocol: protocol,
            matchedPort: port,
            routingPolicyGroup: group,
            providerKey: 'mimo.key1.mimo-v2.5'
          }
        });
        return { status: 204, body: null };
      }
    };
    registerHttpRoutes({
      app,
      config: { server: { host: '127.0.0.1', port: 0 } } as any,
      buildHandlerContext: (req) => buildHttpHandlerContext(serverRuntime, req),
      getPipelineReady: () => true,
      handleError: async () => undefined
    });

    const first = await listen(app);
    const second = await listen(app);
    openedServers.push(first.server, second.server);
    portGroups.set(first.port, 'gateway_priority_first');
    portGroups.set(second.port, 'gateway_priority_second');

    for (const port of [first.port, second.port]) {
      await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'test', messages: [] })
      });
      await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'test', messages: [], max_tokens: 1 })
      });
      await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'test', input: 'hi' })
      });
    }

    expect(captures).toEqual(expect.arrayContaining([
      { endpoint: '/v1/chat/completions', protocol: 'openai-chat', port: first.port, group: 'gateway_priority_first' },
      { endpoint: '/v1/messages', protocol: 'anthropic-messages', port: first.port, group: 'gateway_priority_first' },
      { endpoint: '/v1/responses', protocol: 'openai-responses', port: first.port, group: 'gateway_priority_first' },
      { endpoint: '/v1/chat/completions', protocol: 'openai-chat', port: second.port, group: 'gateway_priority_second' },
      { endpoint: '/v1/messages', protocol: 'anthropic-messages', port: second.port, group: 'gateway_priority_second' },
      { endpoint: '/v1/responses', protocol: 'openai-responses', port: second.port, group: 'gateway_priority_second' }
    ]));
    for (const { protocol, port } of captures) {
      expect(fs.existsSync(path.join(snapshotRoot, protocol, 'ports', String(port), `${protocol}-${port}.jsonl`))).toBe(true);
      expect(fs.existsSync(path.join(snapshotRoot, 'mimo.key1.mimo-v2.5'))).toBe(false);
      const portLog = fs.readFileSync(path.join(logRoot, String(port), `server-${port}.log`), 'utf8');
      expect(portLog).toContain(`port=${port}`);
    }
  });

  it('prints each routed request log with its matched port and policy group', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-entry-port-log-'));
    const logRoot = path.join(root, 'logs');
    process.env.ROUTECODEX_PORT_LOG_ROOT = logRoot;
    installPortLogConsoleRouter();

    runWithPortRequestContext({
      localPort: 5520,
      matchedPort: 5520,
      routingPolicyGroup: 'gateway_priority_5520'
    }, () => {
      console.log('[entry-port-test] first-port-line');
    });
    runWithPortRequestContext({
      localPort: 5555,
      matchedPort: 5555,
      routingPolicyGroup: 'gateway_priority_5555'
    }, () => {
      console.log('[entry-port-test] second-port-line');
    });
    closePortLogConsoleRouterFiles();

    const firstPortLog = fs.readFileSync(path.join(logRoot, '5520', 'server-5520.log'), 'utf8');
    const secondPortLog = fs.readFileSync(path.join(logRoot, '5555', 'server-5555.log'), 'utf8');

    expect(firstPortLog).toContain('[port:5520 group:gateway_priority_5520] [entry-port-test] first-port-line');
    expect(firstPortLog).not.toContain('second-port-line');
    expect(secondPortLog).toContain('[port:5555 group:gateway_priority_5555] [entry-port-test] second-port-line');
    expect(secondPortLog).not.toContain('first-port-line');
  });
});
