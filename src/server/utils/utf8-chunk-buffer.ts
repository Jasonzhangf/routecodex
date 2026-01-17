import { Transform } from 'stream';

/**
 * A buffer helper that handles splitting UTF-8 characters across chunks.
 *
 * It accumulates incoming chunks (Buffer or string) and pushes complete
 * UTF-8 strings downstream. If a chunk ends in the middle of a multi-byte
 * sequence, the bytes are buffered until the next chunk completes it.
 *
 * This uses the utf8-chunk-buffer package implementation logic but wrapped
 * in a stream.Transform for easy piping.
 */
export class Utf8ChunkBuffer {
  private buffer: Buffer | null = null;

  /**
   * Pushes a new chunk into the buffer.
   * Returns an array of complete UTF-8 strings found so far.
   */
  public push(chunk: Buffer | string): string[] {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!data.length) {
      return [];
    }

    // Combine with pending buffer if any
    const buffer = this.buffer ? Buffer.concat([this.buffer, data]) : data;
    this.buffer = null;

    // Check for incomplete UTF-8 sequence at the end
    // UTF-8 logic:
    // 1-byte: 0xxxxxxx
    // 2-byte: 110xxxxx 10xxxxxx
    // 3-byte: 1110xxxx 10xxxxxx 10xxxxxx
    // 4-byte: 11110xxx 10xxxxxx 10xxxxxx 10xxxxxx

    // We scan from the end to find the start byte of the last sequence
    let i = buffer.length - 1;
    let lookback = 0;
    // Look back at most 3 bytes (since max utf8 char is 4 bytes)
    while (i >= 0 && lookback < 4) {
      const byte = buffer[i];
      if ((byte & 0xc0) === 0x80) {
        // Continuation byte (10xxxxxx), keep looking back
        i--;
        lookback++;
        continue;
      }

      // Found a start byte or ASCII
      if ((byte & 0x80) === 0x00) {
        // ASCII (0xxxxxxx), complete char. No split at this byte.
        // If we looked back some bytes, those were continuation bytes without a start,
        // which is invalid UTF-8 but we treat it as complete to avoid stuck buffer.
        break;
      }

      // Multi-byte start
      let charLength = 0;
      if ((byte & 0xe0) === 0xc0) charLength = 2;
      else if ((byte & 0xf0) === 0xe0) charLength = 3;
      else if ((byte & 0xf8) === 0xf0) charLength = 4;

      if (charLength > 0) {
        // We found a start byte. Check if we have enough bytes.
        const available = buffer.length - i;
        if (available < charLength) {
          // Incomplete sequence
          this.buffer = buffer.subarray(i);
          return [buffer.subarray(0, i).toString('utf8')];
        }
      }
      break;
    }

    return [buffer.toString('utf8')];
  }

  /**
   * Flushes any remaining bytes in the buffer as a string.
   */
  public flush(): string[] {
    if (this.buffer && this.buffer.length > 0) {
      const str = this.buffer.toString('utf8');
      this.buffer = null;
      return [str];
    }
    return [];
  }
}

/**
 * Creates a Node.js Transform stream that ensures chunks emitted are complete UTF-8 strings.
 * This is useful for processing SSE streams where a chunk might split a multi-byte character.
 */
export function createUtf8TransformStream(): Transform {
  const buffer = new Utf8ChunkBuffer();

  return new Transform({
    objectMode: true, // We emit strings, not buffers
    transform(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null, data?: unknown) => void) {
      try {
        const chunks = buffer.push(chunk);
        for (const text of chunks) {
          if (text) {
            this.push(text);
          }
        }
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
    flush(callback: (error?: Error | null, data?: unknown) => void) {
      try {
        const chunks = buffer.flush();
        for (const text of chunks) {
          if (text) {
            this.push(text);
          }
        }
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
}
