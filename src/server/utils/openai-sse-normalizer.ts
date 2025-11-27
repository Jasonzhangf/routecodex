import { PassThrough, Readable } from 'node:stream';
import { TextDecoder } from 'node:util';

interface OpenAISseNormalizerOptions {
  requestId: string;
  logger?: Console;
}

interface SSEFrame {
  event?: string;
  data?: string[];
}

type StopReason = 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' | 'blocked';

export function normalizeOpenAIChatSseStream(
  source: Readable,
  options: OpenAISseNormalizerOptions
): Readable {
  const normalizer = new OpenAISseNormalizer(source, options);
  return normalizer.output;
}

class OpenAISseNormalizer {
  private readonly decoder = new TextDecoder();
  private readonly state: NormalizerState;
  readonly output: PassThrough;

  constructor(private readonly source: Readable, private readonly options: OpenAISseNormalizerOptions) {
    this.output = new PassThrough();
    this.state = createInitialState();
    this.start();
  }

  private start(): void {
    let buffer = '';
    this.source.on('data', (chunk) => {
      buffer += this.decoder.decode(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
      buffer = this.processBuffer(buffer);
    });
    this.source.on('end', () => {
      if (buffer.trim()) {
        this.processFrame(buffer.trim());
      }
      this.finish();
    });
    this.source.on('error', (error) => {
      this.options.logger?.error?.('[openai-sse-normalizer] source error', error);
      if (!this.output.destroyed) {
        this.output.destroy(error);
      }
    });
  }

  private processBuffer(buffer: string): string {
    const events = buffer.split('\n\n');
    if (events.length === 1) {
      return buffer;
    }
    const incomplete = events.pop() ?? '';
    for (const block of events) {
      const trimmed = block.trim();
      if (!trimmed) continue;
      this.processFrame(trimmed);
    }
    return incomplete;
  }

  private processFrame(frame: string): void {
    const parsed = parseFrame(frame);
    if (!parsed) {
      this.flushRaw(frame + '\n\n');
      return;
    }
    if (parsed.data?.some((line) => line.trim() === '[DONE]')) {
      this.emitMessageStop();
      this.emitDone();
      return;
    }
    const payload = parsed.data?.join('\n');
    if (!payload) {
      return;
    }
    try {
      const chunk = JSON.parse(payload);
      this.transformChunk(chunk);
    } catch (error) {
      this.flushRaw(frame + '\n\n');
    }
  }

  private transformChunk(chunk: any): void {
    const choice = chunk?.choices?.[0];
    if (!choice) {
      return;
    }
    this.ensureMessageStart(chunk?.model ?? '');
    const delta = choice.delta ?? {};

    if (typeof delta.content === 'string') {
      this.emitTextDelta(delta.content);
    }

    if (Array.isArray(delta.content)) {
      for (const part of delta.content) {
        if (typeof part === 'string') {
          this.emitTextDelta(part);
        } else if (part?.text) {
          this.emitTextDelta(part.text);
        }
      }
    }

    if (Array.isArray(delta.tool_calls)) {
      delta.tool_calls.forEach((toolCall: any) => {
        this.emitToolDelta(toolCall);
      });
    }

    if (choice.finish_reason) {
      this.closeActiveBlocks();
      this.emitMessageDelta(choice.finish_reason, chunk?.usage);
      this.emitMessageStop();
      this.emitDone();
    }
  }

  private ensureMessageStart(model: string): void {
    if (this.state.messageStarted) return;
    this.state.messageStarted = true;
    const event = {
      type: 'message_start',
      message: {
        id: this.state.messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: model || 'unknown',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    };
    this.writeEvent('message_start', event);
  }

  private emitTextDelta(text: string): void {
    if (!text) return;
    if (!this.state.activeTextBlock) {
      const index = this.state.nextBlockIndex++;
      this.state.activeTextBlock = index;
      this.writeEvent('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' }
      });
    }
    this.writeEvent('content_block_delta', {
      type: 'content_block_delta',
      index: this.state.activeTextBlock,
      delta: { type: 'text_delta', text }
    });
  }

  private emitToolDelta(toolCall: any): void {
    if (!toolCall) return;
    const toolIndex = toolCall.index ?? 0;
    let session = this.state.toolBlocks.get(toolIndex);
    if (!session) {
      const blockIndex = this.state.nextBlockIndex++;
      const id = toolCall.id || `call_${Date.now()}_${toolIndex}`;
      const name = toolCall.function?.name || `tool_${toolIndex}`;
      session = { blockIndex, id, name };
      this.state.toolBlocks.set(toolIndex, session);
      this.writeEvent('content_block_start', {
        type: 'content_block_start',
        index: blockIndex,
        content_block: {
          type: 'tool_use',
          id,
          name,
          input: {}
        }
      });
    }
    if (toolCall.function?.arguments) {
      this.writeEvent('content_block_delta', {
        type: 'content_block_delta',
        index: session.blockIndex,
        delta: {
          type: 'input_json_delta',
          partial_json: toolCall.function.arguments
        }
      });
    }
  }

  private emitMessageDelta(finishReason: string, usage?: any): void {
    const mapped: StopReason = mapFinishReason(finishReason);
    const delta = {
      type: 'message_delta',
      delta: {
        stop_reason: mapped,
        stop_sequence: null
      },
      usage: normalizeUsage(usage)
    };
    this.writeEvent('message_delta', delta);
  }

  private emitMessageStop(): void {
    if (this.state.messageStopped) return;
    this.state.messageStopped = true;
    this.closeActiveBlocks();
    this.writeEvent('message_stop', { type: 'message_stop' });
  }

  private emitDone(): void {
    if (this.state.sentDone) return;
    this.state.sentDone = true;
    this.writeRaw('data: [DONE]\n\n');
  }

  private closeActiveBlocks(): void {
    if (this.state.activeTextBlock !== null) {
      this.writeEvent('content_block_stop', {
        type: 'content_block_stop',
        index: this.state.activeTextBlock
      });
      this.state.activeTextBlock = null;
    }
    for (const session of this.state.toolBlocks.values()) {
      this.writeEvent('content_block_stop', {
        type: 'content_block_stop',
        index: session.blockIndex
      });
    }
    this.state.toolBlocks.clear();
  }

  private writeEvent(eventName: string, payload: unknown): void {
    this.writeRaw(`event: ${eventName}\n`);
    this.writeRaw(`data: ${JSON.stringify(payload)}\n\n`);
  }

  private writeRaw(data: string): void {
    if (!this.output.destroyed) {
      this.output.write(data);
    }
  }

  private flushRaw(chunk: string): void {
    this.writeRaw(chunk);
  }

  private finish(): void {
    if (!this.state.sentDone) {
      this.emitMessageStop();
      this.emitDone();
    }
    this.output.end();
  }
}

interface NormalizerState {
  messageId: string;
  messageStarted: boolean;
  messageStopped: boolean;
  sentDone: boolean;
  nextBlockIndex: number;
  activeTextBlock: number | null;
  toolBlocks: Map<number, { blockIndex: number; id: string; name: string }>;
}

function createInitialState(): NormalizerState {
  return {
    messageId: `msg_${Date.now()}`,
    messageStarted: false,
    messageStopped: false,
    sentDone: false,
    nextBlockIndex: 0,
    activeTextBlock: null,
    toolBlocks: new Map()
  };
}

function parseFrame(frame: string): SSEFrame | null {
  const lines = frame.split('\n');
  const result: SSEFrame = {};
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('event:')) {
      result.event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      if (!result.data) {
        result.data = [];
      }
      result.data.push(line.slice(5).trim());
      continue;
    }
  }
  if (!result.event && !result.data?.length) {
    return null;
  }
  return result;
}

function mapFinishReason(reason: string): StopReason {
  switch (reason) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    case 'content_filter':
      return 'blocked';
    default:
      return 'end_turn';
  }
}

function normalizeUsage(usage?: any) {
  if (!usage) {
    return { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  }
  return {
    input_tokens: usage.prompt_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0
  };
}
