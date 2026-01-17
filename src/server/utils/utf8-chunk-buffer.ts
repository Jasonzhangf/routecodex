/**
 * UTF-8 Chunk Buffer
 * 
 * Handles proper buffering of UTF-8 text chunks to prevent splitting multibyte characters.
 * This ensures that Chinese and other multibyte characters are not split mid-character
 * during SSE streaming.
 */

export class Utf8ChunkBuffer {
    private buffer: Buffer = Buffer.alloc(0);
    private readonly minChunkSize: number;

    constructor(minChunkSize: number = 64) {
        this.minChunkSize = minChunkSize;
    }

    /**
     * Add data to the buffer and return complete UTF-8 sequences
     * @param chunk - Incoming data chunk (Buffer or string)
     * @returns Array of complete UTF-8 strings ready to be sent
     */
    push(chunk: Buffer | string): string[] {
        // Convert input to Buffer if it's a string
        const inputBuffer = typeof chunk === 'string'
            ? Buffer.from(chunk, 'utf8')
            : chunk;

        // Append new data to existing buffer
        this.buffer = Buffer.concat([this.buffer, inputBuffer]);

        const output: string[] = [];

        // Process buffer in chunks, ensuring we don't split multibyte characters
        while (this.buffer.length >= this.minChunkSize) {
            // Find safe chunk boundary (don't split multibyte chars)
            const chunkSize = this.findSafeChunkSize(this.minChunkSize);

            if (chunkSize === 0) {
                // No safe boundary found, wait for more data
                break;
            }

            // Extract the safe chunk
            const safeChunk = this.buffer.slice(0, chunkSize);
            this.buffer = this.buffer.slice(chunkSize);

            // Convert to string and add to output
            const text = safeChunk.toString('utf8');
            if (text) {
                output.push(text);
            }
        }

        return output;
    }

    /**
     * Flush any remaining buffered data
     * @returns Remaining buffered text
     */
    flush(): string {
        if (this.buffer.length === 0) {
            return '';
        }

        const text = this.buffer.toString('utf8');
        this.buffer = Buffer.alloc(0);
        return text;
    }

    /**
     * Find a safe chunk size that doesn't split multibyte UTF-8 characters
     * @param targetSize - Desired chunk size
     * @returns Safe chunk size
     */
    private findSafeChunkSize(targetSize: number): number {
        if (this.buffer.length < targetSize) {
            return 0;
        }

        let size = targetSize;

        // Walk backward from target size to find a safe boundary
        // A safe boundary is where we're not in the middle of a multibyte sequence
        while (size > 0) {
            if (this.isCharBoundary(size)) {
                return size;
            }
            size--;
        }

        return 0;
    }

    /**
     * Check if a position is a character boundary (not in the middle of a multibyte sequence)
     * @param pos - Position to check
     * @returns true if position is a character boundary
     */
    private isCharBoundary(pos: number): boolean {
        if (pos >= this.buffer.length) {
            return true;
        }

        const byte = this.buffer[pos];

        // If the byte is not a continuation byte (0x80-0xBF), it's a boundary
        // UTF-8 continuation bytes have the pattern 10xxxxxx (0x80-0xBF)
        return (byte & 0xC0) !== 0x80;
    }

    /**
     * Get current buffer size
     */
    get bufferSize(): number {
        return this.buffer.length;
    }
}

/**
 * Create a transform stream that properly chunks UTF-8 text
 */
export function createUtf8ChunkStream(minChunkSize: number = 64) {
    const buffer = new Utf8ChunkBuffer(minChunkSize);
    import { Transform } from 'stream';

    return new Transform({
        transform(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null, data?: unknown) => void) {
            try {
                const chunks = buffer.push(chunk);
                for (const text of chunks) {
                    this.push(text);
                }
                callback();
            } catch (error) {
                callback(error instanceof Error ? error : new Error(String(error)));
            }
        },
        flush(callback: (error?: Error | null, data?: unknown) => void) {
            try {
                const remaining = buffer.flush();
                if (remaining) {
                    this.push(remaining);
                }
                callback();
            } catch (error) {
                callback(error instanceof Error ? error : new Error(String(error)));
            }
        }
    });
}
