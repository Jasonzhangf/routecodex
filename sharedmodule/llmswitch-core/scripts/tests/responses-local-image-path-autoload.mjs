#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

async function loadBridge() {
  return import(pathToFileURL(path.join(repoRoot, 'dist', 'conversion', 'responses', 'responses-openai-bridge.js')).href);
}

function createTempPng() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmswitch-local-image-'));
  const file = path.join(dir, 'sample.png');
  // Minimal PNG file bytes.
  const pngBytes = Buffer.from(
    '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000A49444154789C6360000002000154A2B0C50000000049454E44AE426082',
    'hex'
  );
  fs.writeFileSync(file, pngBytes);
  return file;
}

function findLatestUserMessage(messages) {
  if (!Array.isArray(messages)) return undefined;
  for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
    const msg = messages[idx];
    if (msg && typeof msg === 'object' && String(msg.role || '').toLowerCase() === 'user') {
      return msg;
    }
  }
  return undefined;
}

function hasImagePart(message) {
  if (!message || typeof message !== 'object') return false;
  const content = message.content;
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (!part || typeof part !== 'object') return false;
    const type = String(part.type || '').toLowerCase();
    if (type !== 'image_url') return false;
    const imageUrl = part.image_url;
    return Boolean(imageUrl && typeof imageUrl === 'object' && typeof imageUrl.url === 'string');
  });
}

async function main() {
  const { captureResponsesContext, buildChatRequestFromResponses } = await loadBridge();
  const imagePath = createTempPng();

  const payload = {
    model: 'gpt-test',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `"${imagePath}" 根据图片 review 架构`
          }
        ]
      }
    ]
  };

  const context = captureResponsesContext(payload, { route: { requestId: 'req_local_image_autoload' } });
  const { request } = buildChatRequestFromResponses(payload, context);
  const userMessage = findLatestUserMessage(request?.messages);
  assert.ok(userMessage, 'expected latest user message');
  assert.ok(Array.isArray(userMessage.content), 'expected multimodal user content array');

  const imagePart = userMessage.content.find((part) => {
    if (!part || typeof part !== 'object') return false;
    const type = String(part.type || '').toLowerCase();
    if (type !== 'image_url') return false;
    const imageUrl = part.image_url;
    return Boolean(imageUrl && typeof imageUrl === 'object' && typeof imageUrl.url === 'string');
  });
  assert.ok(imagePart, 'expected auto-loaded image_url content block');
  assert.ok(
    String(imagePart.image_url.url).startsWith('data:image/png;base64,'),
    'expected image_url to be data:image/png;base64'
  );

  const textPart = userMessage.content.find((part) => {
    if (!part || typeof part !== 'object') return false;
    return String(part.type || '').toLowerCase() === 'text' && typeof part.text === 'string';
  });
  assert.ok(textPart, 'expected original user text preserved');

  // unreadable local path candidates should be ignored (best-effort), not fail the entire request
  const missingPath = path.join(os.tmpdir(), 'llmswitch-local-image-missing', `missing-${Date.now()}.png`);
  const payloadWithMissingPath = {
    model: 'gpt-test',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `请执行命令 --output=\"${missingPath}\" 然后继续`
          }
        ]
      }
    ]
  };

  const contextWithMissingPath = captureResponsesContext(payloadWithMissingPath, {
    route: { requestId: 'req_local_image_autoload_missing_path' }
  });
  const { request: requestWithMissingPath } = buildChatRequestFromResponses(payloadWithMissingPath, contextWithMissingPath);
  const userMessageWithMissingPath = findLatestUserMessage(requestWithMissingPath?.messages);
  assert.ok(userMessageWithMissingPath, 'expected latest user message for missing path case');
  assert.equal(
    hasImagePart(userMessageWithMissingPath),
    false,
    'expected no image_url content block when local path is unreadable'
  );
  const unreadableNoticePart = Array.isArray(userMessageWithMissingPath.content)
    ? userMessageWithMissingPath.content.find((part) =>
      part &&
      typeof part === 'object' &&
      String(part.type || '').toLowerCase() === 'text' &&
      typeof part.text === 'string' &&
      String(part.text).includes('文件不可读')
    )
    : undefined;
  assert.ok(unreadableNoticePart, 'expected unreadable local image placeholder notice in user content');

  console.log('✅ responses local image path autoload regression passed');
}

main().catch((error) => {
  console.error('❌ responses local image path autoload regression failed:', error);
  process.exit(1);
});
