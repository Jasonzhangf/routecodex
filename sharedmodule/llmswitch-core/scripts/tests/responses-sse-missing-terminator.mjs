#!/usr/bin/env node
/**
 * Regression: SSE stream may end without any terminal events:
 * - no response.completed / response.done
 * - no output_item.done / content_part.done / output_text.done
 *
 * Conversion should still succeed when output items are already materialized.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

async function loadConverters() {
  const jsonToSse = await import(pathToFileURL(path.join(repoRoot, 'dist', 'sse', 'json-to-sse', 'index.js')).href);
  const sseToJson = await import(pathToFileURL(path.join(repoRoot, 'dist', 'sse', 'sse-to-json', 'index.js')).href);
  return {
    ResponsesJsonToSseConverter: jsonToSse.ResponsesJsonToSseConverter,
    ResponsesSseToJsonConverter: sseToJson.ResponsesSseToJsonConverter
  };
}

function createSseStream(chunks) {
  const passThrough = new PassThrough();
  setTimeout(() => {
    chunks.forEach((chunk, idx) => {
      setTimeout(() => {
        passThrough.write(chunk);
        if (idx === chunks.length - 1) {
          passThrough.end();
        }
      }, idx * 2);
    });
    if (chunks.length === 0) {
      passThrough.end();
    }
  }, 2);
  return passThrough;
}

function getEventType(chunk) {
  const line = String(chunk)
    .split('\n')
    .find((item) => item.startsWith('event:'));
  return line ? line.slice('event:'.length).trim() : '';
}

async function main() {
  const { ResponsesJsonToSseConverter, ResponsesSseToJsonConverter } = await loadConverters();
  const jsonToSse = new ResponsesJsonToSseConverter();
  const sseToJson = new ResponsesSseToJsonConverter();

  const response = {
    id: 'resp_missing_terminator_1',
    object: 'response',
    created: Date.now(),
    status: 'completed',
    model: 'gpt-4o-mini',
    output: [
      {
        type: 'message',
        id: 'msg_missing_terminator_1',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello, missing terminator!' }]
      }
    ]
  };

  const sseStream = await jsonToSse.convertResponseToJsonToSse(response, {
    requestId: 'test-missing-terminator',
    chunkSize: 5,
    enableHeartbeat: false
  });

  const allChunks = [];
  for await (const chunk of sseStream) {
    allChunks.push(String(chunk));
  }
  assert.ok(allChunks.length > 0, 'expected SSE chunks');

  const truncated = allChunks.filter((chunk) => {
    const type = getEventType(chunk);
    if (!type) return true;
    if (type === 'response.completed' || type === 'response.done') return false;
    if (type.endsWith('.done')) return false;
    return true;
  });

  assert.ok(
    truncated.some((chunk) => getEventType(chunk) === 'response.output_item.added'),
    'expected output_item.added event'
  );
  assert.ok(
    truncated.some((chunk) => getEventType(chunk) === 'response.output_text.delta'),
    'expected output_text.delta event'
  );

  const reconstructed = await sseToJson.convertSseToJson(createSseStream(truncated), {
    requestId: 'missing-terminator',
    model: 'gpt-4o-mini'
  });

  assert.equal(reconstructed.id, response.id, 'id must match');
  assert.equal(reconstructed.status, 'completed', 'should finalize as completed');
  const msg = reconstructed.output?.find((item) => item.type === 'message');
  assert.ok(msg, 'expected message output');
  const text = msg?.content?.[0]?.text;
  assert.ok(typeof text === 'string' && text.includes('Hello'), 'expected reconstructed text');

  console.log('✅ responses-sse-missing-terminator passed');
}

main().catch((err) => {
  console.error('❌ responses-sse-missing-terminator failed:', err);
  process.exit(1);
});
