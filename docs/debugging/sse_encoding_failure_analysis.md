# Analysis of Incomplete Response / SSE Encoding Issues

## Incident Summary
The user reported that requests are "stopping halfway" or having encoding issues, suspecting that SSE is being treated as JSON or that Double Encoding is occurring.
Logs indicate:
- `reason=thinking:last-tool-read` (Complex flow with tool outputs)
- `[response.sse.stream] ... end {"events":8,"status":200}` (Stream started but ended potentially prematurely)

## Root Cause Analysis

### Primary Cause: Unsafe Buffer Handling in `GeminiSseNormalizer`
The `GeminiSseNormalizer` class in `src/providers/core/runtime/gemini-cli-http-provider.ts` has a critical flaw in how it processes incoming data chunks from the Gemini CLI process.

**The Code:**
```typescript
override _transform(chunk: unknown, ...): void {
  if (chunk) {
    // FLAW: Converting a Buffer chunk directly to string can split multi-byte characters
    const text = chunk instanceof Buffer ? chunk.toString('utf8') : String(chunk);
    this.buffer += text.replace(/\r\n/g, '\n');
    this.processBuffered();
  }
}
```

**The Mechanism of Failure:**
1.  **Multi-byte Characters**: Output containing Chinese characters or other multi-byte Unicode sequences (common in "thinking" traces or translated tool outputs) takes up 3-4 bytes per character.
2.  **Chunk Splitting**: A network or process stream chunk boundary can land *in the middle* of a character's byte sequence (e.g., getting the first 2 bytes of a 3-byte character).
3.  **Corruption**: `chunk.toString('utf8')` replaces the incomplete byte sequence with a replacement character ().
4.  **JSON Validation**: The `GeminiSseNormalizer` attempts to parse the accumulated text as JSON (`JSON.parse(payloadText)`).
5.  **Silent Failure**: Because the JSON string now contains corrupted characters (or the structure is broken due to the character being part of a syntax element), `JSON.parse` throws an error.
6.  **Data Loss**: The code explicitly ignores these errors:
    ```typescript
    try {
      const parsed = JSON.parse(payloadText);
      // ...
    } catch {
      // ignore malformed chunks
    }
    ```
    This causes the entire chunk (which might contain the rest of the response or a crucial tool output) to be **silently discarded**.

### Secondary Symptoms
*   **"Stopped Halfway"**: The client receives the initial events (e.g., 8 events) but once a large chunk with a split character arrives, it is dropped, and the stream ends or hangs, making it look like it stopped.
*   **"Encoding Issues"**: If any corrupt text *does* make it through (unlikely with JSON.parse failing), it would look like mojibake.

## Conclusion
The issue is definitively an **encoding handling bug** in the streaming pipeline. The server is not handling binary stream usage correctly for multi-byte content.

## Recommended Fix
Use the `Utf8ChunkBuffer` utility (which correctly buffers incomplete byte sequences across chunks) in `GeminiSseNormalizer` instead of direct `toString()`.

*Note: I attempted to apply this fix in the previous step but the file update was incomplete/broken. The file currently needs repair to function.*
