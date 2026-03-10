// Streaming textual tool intent extractor (对齐)
// Detects <function=execute> blocks and structured apply_patch payloads
// and converts them into OpenAI tool_calls incrementally.

import {
  createStreamingToolExtractorStateWithNative,
  feedStreamingToolExtractorWithNative,
  resetStreamingToolExtractorStateWithNative
} from '../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

type NativeState = Record<string, unknown>;

function assertStreamingToolExtractorNativeAvailable(): void {
  if (
    typeof createStreamingToolExtractorStateWithNative !== 'function' ||
    typeof resetStreamingToolExtractorStateWithNative !== 'function' ||
    typeof feedStreamingToolExtractorWithNative !== 'function'
  ) {
    throw new Error('[streaming-text-extractor] native bindings unavailable');
  }
}

export interface StreamingToolCall {
  id?: string;
  type: 'function';
  function: { name?: string; arguments?: string };
}

export interface StreamingToolExtractorOptions {
  idPrefix?: string;
}

export class StreamingTextToolExtractor {
  private state: NativeState;

  constructor(private opts: StreamingToolExtractorOptions = {}) {
    assertStreamingToolExtractorNativeAvailable();
    this.state = createStreamingToolExtractorStateWithNative(this.opts.idPrefix || 'call');
  }

  reset(): void {
    assertStreamingToolExtractorNativeAvailable();
    this.state = resetStreamingToolExtractorStateWithNative(this.state);
  }

  feedText(text: string): StreamingToolCall[] {
    if (typeof text !== 'string' || !text) return [];
    assertStreamingToolExtractorNativeAvailable();
    const output = feedStreamingToolExtractorWithNative({
      state: this.state,
      text,
      nowMs: Date.now()
    });
    this.state = output.state;
    return output.toolCalls as unknown as StreamingToolCall[];
  }
}

export function createStreamingToolExtractor(opts?: StreamingToolExtractorOptions): StreamingTextToolExtractor {
  return new StreamingTextToolExtractor(opts);
}
