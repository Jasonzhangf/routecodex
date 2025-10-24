import { Readable } from 'stream';
import { OpenAISSEParser } from './openai-sse-parser.js';

/**
 * Event shape for Anthropic SSE stream
 */
type AnthEvent = { event: string; data: Record<string, unknown> };

type ToolCallAccum = {
  id: string;
  name: string;
  buffer: string;
  started: boolean;
  stopped: boolean;
};

/**
 * Stateful transformer: OpenAI chat.completion.chunk → Anthropic SSE events
 * Implements text/tool blocks and finish/usage mapping. Includes optional
 * coalescing for text delta within a time window (ms).
 */
class AnthropicStreamCodec {
  private messageId = '';
  private model = '';
  private createdAt = 0;
  private started = false;
  private textStarted = false;
  private textStopped = false;
  private toolCalls: Map<number, ToolCallAccum> = new Map();
  private finishReason: string | null = null;
  private usage: { input_tokens?: number; output_tokens?: number } | null = null;
  private messageDeltaSent = false;

  private textBuffer = '';
  private lastFlushAt = 0;
  private readonly windowMs: number;

  constructor(windowMs: number) {
    this.windowMs = Math.max(0, windowMs | 0);
  }

  /** Map OpenAI finish_reason to Anthropic stop_reason */
  private mapFinish(reason: string | null | undefined): string | null {
    if (!reason) return null;
    switch (reason) {
      case 'stop': return 'end_turn';
      case 'length': return 'max_tokens';
      case 'tool_calls': return 'tool_use';
      default: return reason;
    }
  }

  public processOpenAIChunk(chunk: any, now: number): AnthEvent[] {
    const events: AnthEvent[] = [];
    const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : undefined;
    const delta = choice?.delta || {};

    // Init
    try {
      if (!this.messageId) this.messageId = String(chunk.id || `chatcmpl_${Date.now()}`);
      if (!this.model) this.model = String(chunk.model || 'unknown');
      if (!this.createdAt) this.createdAt = Number(chunk.created || Math.floor(Date.now() / 1000));
    } catch { /* ignore */ }

    // message_start
    if (!this.started && delta?.role === 'assistant') {
      events.push({ event: 'message_start', data: { type: 'message_start', message: { id: this.messageId, type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } } });
      this.started = true;
    }

    // Text delta (coalesce)
    if (typeof delta?.content === 'string' && delta.content.length > 0) {
      if (!this.textStarted) {
        events.push({ event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
        this.textStarted = true;
      }
      this.textBuffer += delta.content;
      if (now - this.lastFlushAt >= this.windowMs) {
        if (this.textBuffer.length > 0) {
          events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: this.textBuffer } } });
          this.textBuffer = '';
          this.lastFlushAt = now;
        }
      }
    }

    // Tool calls
    const toolCalls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
    for (const tc of toolCalls) {
      const index = Number(tc?.index ?? 0) + 1; // tools after text
      let acc = this.toolCalls.get(index);
      if (!acc) {
        acc = { id: String(tc?.id || `call_${Math.random().toString(36).slice(2, 10)}`), name: String(tc?.function?.name || 'tool'), buffer: '', started: false, stopped: false };
        this.toolCalls.set(index, acc);
      }
      if (!acc.started) {
        events.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'tool_use', id: acc.id, name: acc.name, input: {} } } });
        acc.started = true;
      }
      const argsPart = tc?.function?.arguments;
      if (typeof argsPart === 'string' && argsPart.length > 0) {
        acc.buffer += argsPart;
        events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: argsPart } } });
      }
    }

    // Finish reason on this chunk
    const fr = choice?.finish_reason;
    if (typeof fr === 'string' && fr.length > 0) {
      this.finishReason = fr;
      // Flush any pending text before stopping
      if (this.textStarted && !this.textStopped && this.textBuffer.length > 0) {
        events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: this.textBuffer } } });
        this.textBuffer = '';
      }
      if (this.textStarted && !this.textStopped) {
        events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } });
        this.textStopped = true;
      }
      for (const [index, acc] of this.toolCalls.entries()) {
        if (acc.started && !acc.stopped) {
          events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
          acc.stopped = true;
        }
      }
    }

    // Usage may arrive on separate chunk
    const usage = chunk?.usage;
    if (usage && typeof usage === 'object') {
      const inTok = Number(usage?.prompt_tokens || 0);
      const outTok = Number(usage?.completion_tokens || 0);
      this.usage = { input_tokens: inTok, output_tokens: outTok };
      const stop = this.mapFinish(this.finishReason);
      events.push({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: stop ?? null, stop_sequence: null }, usage: { input_tokens: inTok, output_tokens: outTok } } });
      this.messageDeltaSent = true;
    }

    return events;
  }

  public finalize(): AnthEvent[] {
    const events: AnthEvent[] = [];
    // Ensure start
    if (!this.started) {
      events.push({ event: 'message_start', data: { type: 'message_start', message: { id: this.messageId || `msg_${Date.now()}`, type: 'message', role: 'assistant', model: this.model || 'unknown', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } } });
      this.started = true;
    }
    // Flush pending text
    if (this.textStarted && !this.textStopped && this.textBuffer.length > 0) {
      events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: this.textBuffer } } });
      this.textBuffer = '';
    }
    if (this.textStarted && !this.textStopped) {
      events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } });
      this.textStopped = true;
    }
    for (const [index, acc] of this.toolCalls.entries()) {
      if (acc.started && !acc.stopped) {
        events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
        acc.stopped = true;
      }
    }
    if (!this.messageDeltaSent) {
      const stop = this.mapFinish(this.finishReason);
      events.push({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: stop ?? null, stop_sequence: null } } });
      this.messageDeltaSent = true;
    }
    events.push({ event: 'message_stop', data: { type: 'message_stop' } });
    return events;
  }
}

export interface OpenAIToAnthropicStreamOptions {
  requestId: string;
  model: string;
  windowMs?: number; // coalescing window for text
  useEventHeaders?: boolean; // emit event: lines, default true
}

/**
 * High-level transformer: Consumes an OpenAI SSE stream and writes Anthropic
 * SSE to the Express Response. Auto-detects payloads; if the first parsed
 * object does not look like an OpenAI chat chunk, falls back to raw piping.
 */
export async function transformOpenAIStreamToAnthropic(
  readable: Readable,
  res: { write: (s: string) => any; end: () => any; setHeader?: (k: string, v: string) => any },
  options: OpenAIToAnthropicStreamOptions
): Promise<void> {
  // Setup headers
  try {
    res.setHeader?.('Content-Type', 'text/event-stream');
    res.setHeader?.('Cache-Control', 'no-cache');
    res.setHeader?.('Connection', 'keep-alive');
    res.setHeader?.('x-request-id', options.requestId);
  } catch { /* ignore */ }

  const windowMs = typeof options.windowMs === 'number' ? options.windowMs : (Number(process.env.RCC_O2A_COALESCE_MS || 1000) || 1000);
  const codec = new AnthropicStreamCodec(windowMs);
  const useEventHeaders = options.useEventHeaders !== false;

  let sawOpenAI = false;
  let wroteAnything = false;

  const write = (ev: AnthEvent) => {
    const json = JSON.stringify(ev.data);
    if (useEventHeaders) {
      res.write(`event: ${ev.event}\n`);
      res.write(`data: ${json}\n\n`);
    } else {
      res.write(`data: ${json}\n\n`);
    }
    wroteAnything = true;
  };

  const parser = new OpenAISSEParser(
    readable,
    (obj) => {
      // detect OpenAI chunk shape
      const isOpenAI = !!(obj && (obj.object === 'chat.completion.chunk' || (Array.isArray(obj.choices) && obj.choices[0] && (obj.choices[0].delta || obj.choices[0].message))));
      if (!sawOpenAI && isOpenAI) sawOpenAI = true;
      if (!isOpenAI) {
        // passthrough unknown events as-is to avoid breaking other protocols
        try { res.write(`data: ${JSON.stringify(obj)}\n\n`); wroteAnything = true; } catch { /* ignore */ }
        return;
      }
      const now = Date.now();
      const events = codec.processOpenAIChunk(obj, now);
      for (const ev of events) write(ev);
    },
    () => {
      const tail = codec.finalize();
      for (const ev of tail) write(ev);
      if (!wroteAnything) {
        // emit a minimal stop to keep clients happy
        const stop = { event: 'message_stop', data: { type: 'message_stop' } } as AnthEvent;
        write(stop);
      }
      try { res.end(); } catch { /* ignore */ }
    }
  );

  // If the readable errors before any data, end politely
  readable.on('error', () => {
    if (!wroteAnything) {
      try {
        const err = { type: 'message_delta', delta: { stop_reason: 'error', stop_sequence: null } };
        res.write(`event: message_delta\n`);
        res.write(`data: ${JSON.stringify(err)}\n\n`);
      } catch { /* ignore */ }
    }
    try { res.end(); } catch { /* ignore */ }
  });

  parser.start();
}
