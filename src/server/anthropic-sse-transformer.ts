/**
 * Anthropic SSE Transformer (encapsulated, stable)
 *
 * Converts OpenAI ChatCompletion streaming chunks (JSON objects from `data: {...}`)
 * into Anthropic-compatible SSE events, emitting incremental input_json_delta for
 * tool_use blocks and text_delta for text. It maintains minimal per-stream state
 * to ensure correct content_block_start/stop and message_stop sequencing.
 *
 * This module is intended to be stable and independently maintained.
 */

export type AnthropicEvent = { event: string; data: Record<string, unknown> };

type ToolCallAccum = {
  id: string;
  name: string;
  buffer: string;
  started: boolean;
  stopped: boolean;
};

export class AnthropicSSETransformer {
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

  constructor() {}

  /**
   * Map OpenAI finish_reason to Anthropic stop_reason
   */
  private mapFinish(reason: string | null | undefined): string | null {
    if (!reason) return null;
    switch (reason) {
      case 'stop':
        return 'end_turn';
      case 'length':
        return 'max_tokens';
      case 'tool_calls':
        return 'tool_use';
      default:
        return reason;
    }
  }

  /**
   * Process a single OpenAI streaming chunk (already parsed JSON object)
   * and return Anthropic SSE events to emit for this chunk.
   */
  public processOpenAIChunk(chunk: any): AnthropicEvent[] {
    const events: AnthropicEvent[] = [];

    // Initialize IDs/model/created
    try {
      if (!this.messageId) this.messageId = String(chunk.id || `chatcmpl_${Date.now()}`);
      if (!this.model) this.model = String(chunk.model || 'unknown');
      if (!this.createdAt) this.createdAt = Number(chunk.created || Math.floor(Date.now() / 1000));
    } catch {}

    const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : undefined;
    const delta = choice?.delta || {};

    // message_start on first assistant role
    if (!this.started && delta?.role === 'assistant') {
      events.push({
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: this.messageId,
            type: 'message',
            role: 'assistant',
            model: this.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 }
          }
        }
      });
      this.started = true;
    }

    // Text delta
    const contentText: string | undefined = typeof delta?.content === 'string' ? delta.content : undefined;
    if (typeof contentText === 'string' && contentText.length > 0) {
      if (!this.textStarted) {
        events.push({
          event: 'content_block_start',
          data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
        });
        this.textStarted = true;
      }
      events.push({
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: contentText } }
      });
    }

    // Tool calls delta (array of deltas)
    const toolCalls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
    for (const tc of toolCalls) {
      const index = Number(tc?.index ?? 0) + 1; // text is at index 0, tools start from 1
      let acc = this.toolCalls.get(index);
      if (!acc) {
        acc = {
          id: String(tc?.id || `call_${Math.random().toString(36).slice(2, 10)}`),
          name: String(tc?.function?.name || 'tool'),
          buffer: '',
          started: false,
          stopped: false
        };
        this.toolCalls.set(index, acc);
      }

      // Start tool_use block if not started
      if (!acc.started) {
        events.push({
          event: 'content_block_start',
          data: { type: 'content_block_start', index, content_block: { type: 'tool_use', id: acc.id, name: acc.name, input: {} } }
        });
        acc.started = true;
      }

      // Accumulate arguments string and emit input_json_delta
      const argsPartRaw = tc?.function?.arguments;
      if (typeof argsPartRaw === 'string' && argsPartRaw.length > 0) {
        acc.buffer += argsPartRaw;
        events.push({
          event: 'content_block_delta',
          data: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: argsPartRaw } }
        });
      }
    }

    // Finish reason on this chunk
    const fr = choice?.finish_reason;
    if (typeof fr === 'string' && fr.length > 0) {
      this.finishReason = fr;
      // Stop text block
      if (this.textStarted && !this.textStopped) {
        events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } });
        this.textStopped = true;
      }
      // Stop all tool blocks
      for (const [index, acc] of this.toolCalls.entries()) {
        if (acc.started && !acc.stopped) {
          events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
          acc.stopped = true;
        }
      }
      // Do not send message_delta yet; wait for usage if it will arrive in a later chunk
    }

    // Usage may arrive on separate chunk
    const usage = chunk?.usage;
    if (usage && typeof usage === 'object') {
      const inTok = Number(usage?.prompt_tokens || 0);
      const outTok = Number(usage?.completion_tokens || 0);
      this.usage = { input_tokens: inTok, output_tokens: outTok };
      // Send message_delta with final stop_reason and usage
      const stop = this.mapFinish(this.finishReason);
      events.push({
        event: 'message_delta',
        data: { type: 'message_delta', delta: { stop_reason: stop ?? null, stop_sequence: null }, usage: { input_tokens: inTok, output_tokens: outTok } }
      });
      this.messageDeltaSent = true;
    }

    return events;
  }

  /**
   * Finalize stream (called when [DONE] is received) and return any trailing events
   */
  public finalize(): AnthropicEvent[] {
    const events: AnthropicEvent[] = [];

    // If we never sent message_start (no chunks), still emit minimal message
    if (!this.started) {
      events.push({
        event: 'message_start',
        data: {
          type: 'message_start',
          message: { id: this.messageId || `msg_${Date.now()}`, type: 'message', role: 'assistant', model: this.model || 'unknown', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }
        }
      });
      this.started = true;
    }

    // Ensure blocks are stopped if finish_reason was set but stops not sent
    if (this.finishReason) {
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

    // Send message_delta if not sent yet
    if (!this.messageDeltaSent) {
      const stop = this.mapFinish(this.finishReason);
      events.push({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: stop ?? null, stop_sequence: null } } });
      this.messageDeltaSent = true;
    }

    // Final stop
    events.push({ event: 'message_stop', data: { type: 'message_stop' } });
    return events;
  }
}

