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
  });
});
