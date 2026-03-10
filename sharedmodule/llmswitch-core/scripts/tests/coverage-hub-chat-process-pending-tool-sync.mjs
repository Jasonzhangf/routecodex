#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'conversion', 'hub', 'process', 'chat-process-pending-tool-sync.js')
).href;

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

function buildRequest(messages, sessionId) {
  return {
    messages,
    metadata: sessionId ? { sessionId } : undefined
  };
}

async function main() {
  const mod = await importFresh('hub-chat-process-pending-tool-sync');
  const maybeInjectPendingServerToolResultsAfterClientTools = mod.maybeInjectPendingServerToolResultsAfterClientTools;
  assert.equal(typeof maybeInjectPendingServerToolResultsAfterClientTools, 'function');

  {
    const req = buildRequest([{ role: 'user', content: 'hello' }]);
    const out = await maybeInjectPendingServerToolResultsAfterClientTools(req, {}, {});
    assert.equal(out, req);
  }

  {
    const req = buildRequest([{ role: 'user', content: 'hello' }], 's-none');
    const out = await maybeInjectPendingServerToolResultsAfterClientTools(req, { sessionId: 's-none' }, {
      loadPendingServerToolInjectionFn: async () => null
    });
    assert.equal(out, req);
  }

  {
    const req = buildRequest([{ role: 'tool', tool_call_id: 'call-1' }], 's-empty-after');
    const out = await maybeInjectPendingServerToolResultsAfterClientTools(req, { sessionId: 's-empty-after' }, {
      loadPendingServerToolInjectionFn: async () => ({
        afterToolCallIds: [],
        messages: [{ role: 'assistant', content: 'x' }]
      })
    });
    assert.equal(out, req);
  }

  {
    const req = buildRequest([{ role: 'tool', tool_call_id: 'call-1' }], 's-bad-after-shape');
    const out = await maybeInjectPendingServerToolResultsAfterClientTools(req, { sessionId: 's-bad-after-shape' }, {
      loadPendingServerToolInjectionFn: async () => ({
        afterToolCallIds: 'call-1',
        messages: [{ role: 'assistant', content: 'x' }]
      })
    });
    assert.equal(out, req);
  }

  {
    const req = buildRequest([{ role: 'tool', tool_call_id: 'call-1' }], 's-not-ready');
    const out = await maybeInjectPendingServerToolResultsAfterClientTools(req, { sessionId: 's-not-ready' }, {
      loadPendingServerToolInjectionFn: async () => ({
        afterToolCallIds: ['call-1'],
        messages: [{ role: 'assistant', content: 'x' }]
      }),
      analyzePendingToolSyncFn: () => ({ ready: false, insertAt: 0 })
    });
    assert.equal(out, req);
  }

  {
    const req = buildRequest([{ role: 'tool', tool_call_id: 'call-1' }], 's-insert-neg');
    const out = await maybeInjectPendingServerToolResultsAfterClientTools(req, { sessionId: 's-insert-neg' }, {
      loadPendingServerToolInjectionFn: async () => ({
        afterToolCallIds: ['call-1'],
        messages: [{ role: 'assistant', content: 'x' }]
      }),
      analyzePendingToolSyncFn: () => ({ ready: true, insertAt: -1 })
    });
    assert.equal(out, req);
  }

  {
    const req = buildRequest([{ role: 'tool', tool_call_id: 'call-1' }], 's-empty-inject');
    const out = await maybeInjectPendingServerToolResultsAfterClientTools(req, { sessionId: 's-empty-inject' }, {
      loadPendingServerToolInjectionFn: async () => ({
        afterToolCallIds: ['call-1'],
        messages: []
      }),
      analyzePendingToolSyncFn: () => ({ ready: true, insertAt: 0 })
    });
    assert.equal(out, req);
  }

  {
    const req = {
      metadata: { sessionId: 's-no-messages' }
    };
    const out = await maybeInjectPendingServerToolResultsAfterClientTools(req, { sessionId: 's-no-messages' }, {
      loadPendingServerToolInjectionFn: async () => ({
        afterToolCallIds: ['call-1'],
        messages: [{ role: 'assistant', content: 'x' }]
      }),
      analyzePendingToolSyncFn: () => ({ ready: true, insertAt: 0 }),
      clearPendingServerToolInjectionFn: async () => {}
    });
    assert.equal(Array.isArray(out.messages), true);
    assert.equal(out.messages.length, 1);
  }

  {
    const req = buildRequest([{ role: 'tool', tool_call_id: 'call-1' }], 's-bad-messages-shape');
    const out = await maybeInjectPendingServerToolResultsAfterClientTools(req, { sessionId: 's-bad-messages-shape' }, {
      loadPendingServerToolInjectionFn: async () => ({
        afterToolCallIds: ['call-1'],
        messages: { role: 'assistant', content: 'x' }
      }),
      analyzePendingToolSyncFn: () => ({ ready: true, insertAt: 0 })
    });
    assert.equal(out, req);
  }

  {
    const req = buildRequest(
      [
        { role: 'user', content: 'before' },
        { role: 'tool', tool_call_id: 'call-1' },
        { role: 'assistant', content: 'after' }
      ],
      's-inject'
    );
    let clearedSessionId = '';
    const out = await maybeInjectPendingServerToolResultsAfterClientTools(req, { sessionId: 's-inject' }, {
      loadPendingServerToolInjectionFn: async () => ({
        afterToolCallIds: [' call-1 '],
        messages: [{ role: 'tool', tool_call_id: 'server-1', content: 'ok' }]
      }),
      analyzePendingToolSyncFn: () => ({ ready: true, insertAt: 1 }),
      clearPendingServerToolInjectionFn: async (sessionId) => {
        clearedSessionId = sessionId;
      }
    });
    assert.equal(clearedSessionId, 's-inject');
    assert.equal(out.messages.length, 4);
    assert.equal(out.messages[2].tool_call_id, 'server-1');
  }

  {
    const req = buildRequest([{ role: 'tool', tool_call_id: 'call-1' }], 's-clear-throws');
    const out = await maybeInjectPendingServerToolResultsAfterClientTools(req, { sessionId: 's-clear-throws' }, {
      loadPendingServerToolInjectionFn: async () => ({
        afterToolCallIds: ['call-1'],
        messages: [{ role: 'assistant', content: 'from-server' }]
      }),
      analyzePendingToolSyncFn: () => ({ ready: true, insertAt: 0 }),
      clearPendingServerToolInjectionFn: async () => {
        throw new Error('boom');
      }
    });
    assert.equal(out.messages.length, 2);
    assert.equal(out.messages[1].content, 'from-server');
  }

  {
    const req = buildRequest([{ role: 'tool', tool_call_id: 'call-meta' }], 's-meta');
    const out = await maybeInjectPendingServerToolResultsAfterClientTools(req, {}, {
      loadPendingServerToolInjectionFn: async () => ({
        afterToolCallIds: ['call-meta'],
        messages: [{ role: 'assistant', content: 'meta-inject' }]
      }),
      analyzePendingToolSyncFn: () => ({ ready: true, insertAt: 0 }),
      clearPendingServerToolInjectionFn: async () => {}
    });
    assert.equal(out.messages.length, 2);
    assert.equal(out.messages[1].content, 'meta-inject');
  }

  console.log('✅ coverage-hub-chat-process-pending-tool-sync passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-chat-process-pending-tool-sync failed:', error);
  process.exit(1);
});
