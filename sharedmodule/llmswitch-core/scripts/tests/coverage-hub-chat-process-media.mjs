#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'conversion', 'hub', 'process', 'chat-process-media.js')
).href;

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

function setEnvVar(name, value) {
  if (value === undefined || value === null || value === '') {
    delete process.env[name];
    return;
  }
  process.env[name] = String(value);
}

async function withTempModule(content, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llms-chat-media-native-'));
  const file = path.join(dir, 'mock-native.cjs');
  await fs.writeFile(file, content, 'utf8');
  try {
    await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function userText(text) {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function userImage(url, kind = 'image_url') {
  return { role: 'user', content: [{ type: kind, image_url: url }] };
}

async function main() {
  const prevNativeDisable = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE;
  const prevNativePath = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  // Keep analyzer in pure TS fallback for baseline cases, so the binding cache remains unset.
  setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE', '1');
  delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;

  const mod = await importFresh('chat-process-media');
  const stripHistoricalImageAttachments = mod.stripHistoricalImageAttachments;
  const containsImageAttachment = mod.containsImageAttachment;

  assert.equal(typeof stripHistoricalImageAttachments, 'function');
  assert.equal(typeof containsImageAttachment, 'function');

  {
    const original = [];
    const out = stripHistoricalImageAttachments(original);
    assert.equal(out, original);
  }

  {
    const original = [
      userImage('https://img.old/a.png'),
      { role: 'assistant', content: 'tool hint' },
      { role: 'tool', content: 'result' }
    ];
    const out = stripHistoricalImageAttachments(original);
    assert.notEqual(out, original);
    assert.deepEqual(out[0].content, [{ type: 'text', text: '[Image omitted]' }]);
  }

  {
    const original = [
      userImage('https://img.old/1.png'),
      userText('history text'),
      userImage('https://img.latest/2.png'),
      userText('latest user text')
    ];
    const out = stripHistoricalImageAttachments(original);
    assert.notEqual(out, original);
    assert.deepEqual(out[0].content, [{ type: 'text', text: '[Image omitted]' }]);
    assert.deepEqual(out[2].content, [{ type: 'text', text: '[Image omitted]' }]);
    assert.deepEqual(out[3], original[3]);
  }

  {
    const original = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'IMAGE_URL', image_url: { url: 'https://x' } }, { type: 'text', text: 'x' }] },
      { role: 'user', content: [{ type: 'text', text: 'latest user turn' }] }
    ];
    const out = stripHistoricalImageAttachments(original);
    assert.deepEqual(out[1].content, [{ type: 'text', text: '[Image omitted]' }, { type: 'text', text: 'x' }]);
    assert.deepEqual(out[2], original[2]);
  }

  {
    const original = [
      null,
      { role: 'user', content: [] },
      { role: 'user', content: 'text-only-non-array' },
      { role: 'assistant', content: [] }
    ];
    const out = stripHistoricalImageAttachments(original);
    assert.equal(out, original);
  }

  {
    const original = [
      { role: 'user', content: [{ type: 'text', text: 'no image' }] },
      { role: 'assistant', content: [] }
    ];
    const out = stripHistoricalImageAttachments(original);
    assert.equal(out, original);
  }

  {
    // Getter-based edge case: first read is "user", later reads are "assistant",
    // forcing the `latestUserIndex < 0` guard branch.
    let roleRead = 0;
    const trickyMessage = {};
    Object.defineProperty(trickyMessage, 'role', {
      enumerable: true,
      get() {
        roleRead += 1;
        return roleRead <= 2 ? 'user' : 'assistant';
      }
    });
    Object.defineProperty(trickyMessage, 'content', {
      enumerable: true,
      value: [{ type: 'image_url', image_url: 'https://edge/role-toggle.png' }]
    });
    const original = [trickyMessage];
    const out = stripHistoricalImageAttachments(original);
    assert.equal(out, original);
  }

  {
    assert.equal(containsImageAttachment([]), false);
    assert.equal(containsImageAttachment([userImage('https://a'), { role: 'assistant', content: [] }]), false);
    assert.equal(containsImageAttachment([{ role: 'user', content: 'not-array' }]), false);
    assert.equal(
      containsImageAttachment([{ role: 'user', content: [{ type: 'image_url', image_url: '' }] }]),
      false
    );
    assert.equal(
      containsImageAttachment([{ role: 'user', content: [{ type: 'image_url', image_url: { url: '' } }] }]),
      false
    );
    assert.equal(
      containsImageAttachment([{ role: 'user', content: [{ type: 'image_url', url: '  ' }] }]),
      false
    );
    assert.equal(
      containsImageAttachment([{ role: 'user', content: [{ type: 'image_url', uri: '\n' }] }]),
      false
    );
    assert.equal(
      containsImageAttachment([{ role: 'user', content: [{ type: 'image_url', data: '' }] }]),
      false
    );
    assert.equal(
      containsImageAttachment([{ role: 'user', content: [{ type: 'video_url', url: 'https://video' }] }]),
      false
    );
    assert.equal(
      containsImageAttachment([{ role: 'user', content: [{ type: 'image_url', image_url: 'https://ok' }] }]),
      true
    );
    assert.equal(
      containsImageAttachment([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://ok2' } }] }]),
      true
    );
    assert.equal(
      containsImageAttachment([{ role: 'user', content: [{ type: 'image_url', url: 'https://ok3' }] }]),
      true
    );
    assert.equal(
      containsImageAttachment([{ role: 'user', content: [{ type: 'image_url', uri: 'https://ok4' }] }]),
      true
    );
    assert.equal(
      containsImageAttachment([{ role: 'user', content: [{ type: 'image_url', data: 'base64:abc' }] }]),
      true
    );
    assert.equal(
      containsImageAttachment([{ role: 'user', content: [{ type: 'text', text: 'no' }, 123, null] }]),
      false
    );
    assert.equal(
      containsImageAttachment([{ role: 'user', content: [{ type: 123, url: 'https://ignored' }] }]),
      false
    );
  }

  await withTempModule(
    `exports.stripChatProcessHistoricalImagesJson = () => {
      global.__chatProcessMediaStripCalls = (global.__chatProcessMediaStripCalls || 0) + 1;
      return JSON.stringify({
        changed: false,
        messages: [{ role: 'assistant', content: 'should-not-be-used' }]
      });
    };`,
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE', undefined);
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      global.__chatProcessMediaStripCalls = 0;
      const modNative = await importFresh('chat-process-media-native-changed-false');
      const input = [
        userImage('https://img.old/invalid-index.png'),
        null,
        { role: 'user', content: 'not-array' }
      ];
      const out = modNative.stripHistoricalImageAttachments(input);
      assert.equal(out, input);
      assert.equal(global.__chatProcessMediaStripCalls, 1);
    }
  );

  if (prevNativeDisable === undefined) {
    delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE;
  } else {
    process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE = prevNativeDisable;
  }
  if (prevNativePath === undefined) {
    delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  } else {
    process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH = prevNativePath;
  }

  console.log('✅ coverage-hub-chat-process-media passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-chat-process-media failed:', error);
  process.exit(1);
});
