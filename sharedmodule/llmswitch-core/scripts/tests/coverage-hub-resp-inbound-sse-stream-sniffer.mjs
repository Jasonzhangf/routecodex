#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(
    repoRoot,
    'dist',
    'conversion',
    'hub',
    'pipeline',
    'stages',
    'resp_inbound',
    'resp_inbound_stage1_sse_decode',
    'stream-json-sniffer.js'
  )
).href;

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

function chunkToText(chunk) {
  if (typeof chunk === 'string') return chunk;
  if (Buffer.isBuffer(chunk)) return chunk.toString('utf8');
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8');
  if (chunk instanceof ArrayBuffer) return Buffer.from(new Uint8Array(chunk)).toString('utf8');
  return String(chunk ?? '');
}

async function consumeAsText(stream) {
  let out = '';
  for await (const chunk of stream) {
    out += chunkToText(chunk);
  }
  return out;
}

function createMinimalAsyncIterable(chunks) {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (index < chunks.length) {
            const value = chunks[index];
            index += 1;
            return { done: false, value };
          }
          return { done: true, value: undefined };
        }
      };
    }
  };
}

async function main() {
  const mod = await importFresh('stream-sniffer');
  const decode = mod.tryDecodeJsonBodyFromStream;
  assert.equal(typeof decode, 'function');

  {
    const stream = Readable.from([]);
    const parsed = await decode(stream);
    assert.equal(parsed, null);
  }

  {
    const stream = Readable.from(['event:message\n', 'data:{"x":1}\n\n']);
    const parsed = await decode(stream);
    assert.equal(parsed, null);
    const replayed = await consumeAsText(stream);
    assert.equal(replayed, 'event:message\ndata:{"x":1}\n\n');
  }

  {
    const stream = Readable.from(['not-json-return']);
    const parsed = await decode(stream);
    assert.equal(parsed, null);
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.done, false);
    if (typeof iterator.return === 'function') {
      const ended = await iterator.return('done');
      assert.equal(ended.done, true);
    }
  }

  {
    const stream = Readable.from(['not-json-throw']);
    const parsed = await decode(stream);
    assert.equal(parsed, null);
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.done, false);
    if (typeof iterator.throw === 'function') {
      await assert.rejects(async () => {
        await iterator.throw(new Error('replay-throw'));
      });
    }
  }

  {
    const stream = createMinimalAsyncIterable(['minimal-no-return-throw']);
    const parsed = await decode(stream);
    assert.equal(parsed, null);
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.done, false);
    const ended = await iterator.return('done-minimal');
    assert.deepEqual(ended, { done: true, value: 'done-minimal' });
    await assert.rejects(async () => {
      await iterator.throw(new Error('minimal-replay-throw'));
    });
  }

  {
    const stream = Readable.from([' {"ok": true, "n": 1} ']);
    const parsed = await decode(stream);
    assert.deepEqual(parsed, { ok: true, n: 1 });
  }

  {
    const stream = Readable.from([Buffer.from('{"buffer":1}')]);
    const parsed = await decode(stream);
    assert.deepEqual(parsed, { buffer: 1 });
  }

  {
    const stream = Readable.from([new Uint8Array(Buffer.from('{"u8":2}'))]);
    const parsed = await decode(stream);
    assert.deepEqual(parsed, { u8: 2 });
  }

  {
    const ab = new Uint8Array(Buffer.from('{"ab":3}')).buffer;
    const stream = Readable.from([ab]);
    const parsed = await decode(stream);
    assert.deepEqual(parsed, { ab: 3 });
  }

  {
    const stream = Readable.from([
      {
        toString() {
          return '{"obj":4}';
        }
      }
    ]);
    const parsed = await decode(stream);
    assert.deepEqual(parsed, { obj: 4 });
  }

  {
    const stream = Readable.from(['[1,2,3]']);
    const parsed = await decode(stream);
    assert.equal(parsed, null);
    const replayed = await consumeAsText(stream);
    assert.equal(replayed, '[1,2,3]');
  }

  {
    const stream = Readable.from(['{"broken":']);
    const parsed = await decode(stream);
    assert.equal(parsed, null);
    const replayed = await consumeAsText(stream);
    assert.equal(replayed, '{"broken":');
  }

  {
    const first = `{"huge":"${'x'.repeat(700_000)}`;
    const second = `${'y'.repeat(700_000)}"}`;
    const stream = Readable.from([first, second]);
    const parsed = await decode(stream);
    assert.equal(parsed, null);
    const replayed = await consumeAsText(stream);
    assert.equal(replayed, first + second);
  }

  console.log('✅ coverage-hub-resp-inbound-sse-stream-sniffer passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-resp-inbound-sse-stream-sniffer failed:', error);
  process.exit(1);
});
