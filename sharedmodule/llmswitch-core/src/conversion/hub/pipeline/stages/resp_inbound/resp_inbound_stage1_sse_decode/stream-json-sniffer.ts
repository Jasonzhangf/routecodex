import { Readable } from 'node:stream';
import type { JsonObject } from '../../../../types/json.js';
import {
  looksLikeJsonStreamPrefixWithNative,
  parseJsonObjectCandidateWithNative
} from '../../../../../../router/virtual-router/engine-selection/native-hub-pipeline-resp-semantics.js';

const STREAM_JSON_MAX_BYTES = 1024 * 1024;

export async function tryDecodeJsonBodyFromStream(stream: Readable): Promise<JsonObject | null> {
  // Peek the first chunk; if it looks like JSON (starts with `{` or `[`), consume full body and parse.
  const iterator = stream[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done || first.value == null) {
    return null;
  }
  const consumedChunks: unknown[] = [first.value];
  const firstChunk = first.value;
  const looksLikeJson = looksLikeJsonStreamPrefixWithNative(chunkToUtf8(firstChunk));
  if (!looksLikeJson) {
    rewindStreamWithConsumedChunks(stream, consumedChunks, iterator);
    return null;
  }

  let body = chunkToUtf8(firstChunk);
  while (true) {
    const next = await iterator.next();
    if (next.done) break;
    consumedChunks.push(next.value);
    body += chunkToUtf8(next.value);
    // Guard: avoid unbounded buffering if the upstream is actually SSE but starts with whitespace.
    if (body.length > STREAM_JSON_MAX_BYTES) {
      rewindStreamWithConsumedChunks(stream, consumedChunks, iterator);
      return null;
    }
  }

  const parsed = parseJsonObjectCandidateWithNative(body, STREAM_JSON_MAX_BYTES);
  if (!parsed) {
    rewindStreamWithConsumedChunks(stream, consumedChunks, iterator);
    return null;
  }
  return parsed as JsonObject;
}

function chunkToUtf8(chunk: unknown): string {
  if (typeof chunk === 'string') {
    return chunk;
  }
  if (Buffer.isBuffer(chunk)) {
    return chunk.toString('utf8');
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk).toString('utf8');
  }
  if (chunk instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(chunk)).toString('utf8');
  }
  return String(chunk ?? '');
}

function rewindStreamWithConsumedChunks(
  stream: Readable,
  consumedChunks: unknown[],
  iterator: AsyncIterator<unknown>
): void {
  // Rewind by re-wrapping the iterator so downstream SSE decoder still sees everything consumed here.
  // eslint-disable-next-line no-param-reassign
  (stream as any)[Symbol.asyncIterator] = () => replayIterator(consumedChunks, iterator);
}

function replayIterator(consumedChunks: unknown[], iterator: AsyncIterator<unknown>): AsyncIterator<unknown> {
  let replayIndex = 0;
  return {
    async next() {
      if (replayIndex < consumedChunks.length) {
        const value = consumedChunks[replayIndex];
        replayIndex += 1;
        return { done: false, value };
      }
      return iterator.next();
    },
    async return(value?: unknown) {
      if (typeof iterator.return === 'function') {
        return iterator.return(value);
      }
      return { done: true, value };
    },
    async throw(err?: unknown) {
      if (typeof iterator.throw === 'function') {
        return iterator.throw(err);
      }
      throw err;
    }
  };
}
