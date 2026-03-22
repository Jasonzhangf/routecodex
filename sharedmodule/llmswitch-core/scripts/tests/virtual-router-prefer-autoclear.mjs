#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

async function main() {
  const engineModule = await import(path.resolve(repoRoot, 'dist', 'router', 'virtual-router', 'engine.js'));
  const { VirtualRouterEngine } = engineModule;

  const sessionId = `test-${Date.now()}`;
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-prefer-autoclear-'));
  const sessionStatePath = path.join(sessionDir, `session-${sessionId}.json`);

  const preferredKey = 'antigravity.key1.claude-sonnet-4-5-thinking';

  const engine = new VirtualRouterEngine({
    quotaView: (providerKey) => {
      if (providerKey === preferredKey) {
        return { providerKey, inPool: false, reason: 'no_quota' };
      }
      return { providerKey, inPool: true };
    }
  });

  engine.initialize({
    classifier: {},
    routing: {
      thinking: [
        {
          id: 'thinking-primary',
          priority: 0,
          targets: [
            preferredKey,
            'antigravity.key1.gemini-3-pro-high',
            'other.key1.some-model'
          ]
        }
      ],
      default: [
        {
          id: 'default-primary',
          priority: 0,
          targets: ['other.key1.some-model']
        }
      ]
    },
    providers: {
      [preferredKey]: {
        providerKey: preferredKey,
        providerType: 'openai',
        endpoint: 'https://example.invalid/v1/chat/completions',
        auth: { type: 'apiKey', secretRef: 'TEST' },
        outboundProfile: 'openai-chat',
        compatibilityProfile: 'compat:passthrough',
        defaultModel: 'claude-sonnet-4-5-thinking'
      },
      'antigravity.key1.gemini-3-pro-high': {
        providerKey: 'antigravity.key1.gemini-3-pro-high',
        providerType: 'openai',
        endpoint: 'https://example.invalid/v1/chat/completions',
        auth: { type: 'apiKey', secretRef: 'TEST' },
        outboundProfile: 'openai-chat',
        compatibilityProfile: 'compat:passthrough',
        defaultModel: 'gemini-3-pro-high'
      },
      'other.key1.some-model': {
        providerKey: 'other.key1.some-model',
        providerType: 'openai',
        endpoint: 'https://example.invalid/v1/chat/completions',
        auth: { type: 'apiKey', secretRef: 'TEST' },
        outboundProfile: 'openai-chat',
        compatibilityProfile: 'compat:passthrough',
        defaultModel: 'some-model'
      }
    }
  });

  fs.writeFileSync(
    sessionStatePath,
    JSON.stringify({
      version: 1,
      state: {
        preferTarget: {
          provider: 'antigravity',
          model: 'claude-sonnet-4-5-thinking',
          pathLength: 2
        }
      }
    })
  );

  const request = {
    model: 'unknown',
    messages: [{ role: 'user', content: 'hello' }],
    parameters: {},
    metadata: { originalEndpoint: '/v1/chat/completions', requestId: 'req_test' }
  };
  const metadata = {
    requestId: 'req_test',
    sessionId,
    sessionDir,
    routeHint: 'thinking',
    entryEndpoint: '/v1/chat/completions'
  };

  try {
    const first = engine.route(request, metadata);
    assert.equal(first.decision.routeName, 'thinking');
    assert.equal(first.target.providerKey, 'antigravity.key1.gemini-3-pro-high');

    if (!fs.existsSync(sessionStatePath)) {
      console.log('[virtual-router] prefer auto-clear: OK');
      return;
    }
    const persisted = JSON.parse(fs.readFileSync(sessionStatePath, 'utf8'));
    const persistedState = persisted && typeof persisted === 'object' ? persisted.state ?? persisted : null;
    assert.equal(
      persistedState?.preferTarget,
      undefined,
      'preferTarget should auto-clear when preferred model is not eligible'
    );
  } finally {
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  }

  console.log('[virtual-router] prefer auto-clear: OK');
}

main().catch((error) => {
  console.error('[virtual-router] prefer auto-clear: FAILED');
  console.error(error);
  process.exitCode = 1;
});
