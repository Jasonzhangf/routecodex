import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FileSnapshotStore } from '../../src/debug/snapshot-store.js';

describe('snapshot store port isolation red tests', () => {
  it('writes request snapshots under the matched port namespace', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-snapshot-port-'));
    const store = new FileSnapshotStore(dir);

    await store.save({
      sessionId: 'rcc-fin',
      nodeId: 'provider-request',
      direction: 'request',
      payload: { model: 'gpt-5.5' },
      timestamp: 1,
      metadata: { matchedPort: 5555, routingPolicyGroup: 'gateway_priority_5555' }
    });

    expect(fs.existsSync(path.join(dir, 'ports', '5555', 'rcc-fin.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'rcc-fin.jsonl'))).toBe(false);

    const snapshots = await store.fetch('rcc-fin');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.nodeId).toBe('provider-request');
  });

  it('keeps provider-request snapshot metadata at root and out of wire payload', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-snapshot-metadata-boundary-'));
    const store = new FileSnapshotStore(dir);

    await store.save({
      sessionId: 'rcc-metadata-boundary',
      nodeId: 'provider-request',
      direction: 'request',
      payload: {
        data: {
          model: 'gpt-5.5',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }]
        }
      },
      timestamp: 1,
      metadata: {
        session_id: 'snapshot-root-only',
        matchedPort: 5555,
        routingPolicyGroup: 'gateway_priority_5555'
      }
    });

    const file = path.join(dir, 'ports', '5555', 'rcc-metadata-boundary.jsonl');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').trim()) as Record<string, any>;
    expect(parsed.metadata.session_id).toBe('snapshot-root-only');
    expect(parsed.payload.data.metadata).toBeUndefined();
    expect(JSON.stringify(parsed.payload)).not.toContain('snapshot-root-only');
  });

  it('writes pipeline stage snapshots by entry protocol and port instead of provider', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-snapshot-entry-'));
    const store = new FileSnapshotStore(dir);
    for (const stage of ['provider-request', 'provider-response', 'chat_process.resp.stage8.finalize']) {
      await store.save({
        sessionId: 'client-req-1',
        nodeId: stage,
        stage,
        direction: stage === 'provider-response' ? 'response' : 'request',
        payload: { stage, providerKey: 'mimo.key1.mimo-v2.5-pro' },
        timestamp: 1,
        metadata: {
          entryProtocol: 'openai-responses',
          matchedPort: 5555,
          providerKey: 'mimo.key1.mimo-v2.5-pro'
        }
      });
    }

    const entryFile = path.join(dir, 'openai-responses', 'ports', '5555', 'client-req-1.jsonl');
    expect(fs.existsSync(entryFile)).toBe(true);
    expect(fs.readFileSync(entryFile, 'utf8')).toContain('chat_process.resp.stage8.finalize');
    expect(fs.existsSync(path.join(dir, 'mimo.key1.mimo-v2.5-pro'))).toBe(false);

    const responseSnapshots = await store.fetch('client-req-1', { direction: 'response' });
    expect(responseSnapshots).toHaveLength(1);
    expect(responseSnapshots[0]?.nodeId).toBe('provider-response');
  });

  it('lists and clears sessions across protocol/port subdirectories', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-snapshot-list-'));
    const store = new FileSnapshotStore(dir);

    await store.save({
      sessionId: 'root-session',
      nodeId: 'root-node',
      direction: 'request',
      payload: { ok: true },
      timestamp: 1,
    });
    await store.save({
      sessionId: 'namespaced-session',
      nodeId: 'namespaced-node',
      direction: 'request',
      payload: { ok: true },
      timestamp: 2,
      metadata: {
        entryProtocol: 'openai-responses',
        matchedPort: 5555,
      }
    });

    const listed = await store.listSessions();
    expect(new Set(listed)).toEqual(new Set(['root-session', 'namespaced-session']));

    await store.clear('namespaced-session');
    expect(await store.fetch('namespaced-session')).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'openai-responses', 'ports', '5555', 'namespaced-session.jsonl'))).toBe(false);
  });
});
