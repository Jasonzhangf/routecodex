/**
 * Anthropic SSE Simulator (non-stream → SSE)
 *
 * Emits Anthropic-compatible SSE events from a complete Anthropic message object
 * by simulating incremental delivery (input_json_delta for tool_use, text_delta for text).
 * This module is stable and independently maintained.
 */

export type AnthropicEvent = { event: string; data: Record<string, unknown> };

export class AnthropicSSESimulator {
  constructor(private jsonChunkBytes: number = Math.max(128, Math.min(4096, Number(process.env.RCC_SSE_JSON_CHUNK || 1024)))) {}

  /**
   * Build SSE events sequence from a complete Anthropic message object.
   * Expected shape: { type:'message', role:'assistant', model, content:[ {type:'text'| 'tool_use', ...} ], stop_reason?, usage? }
   */
  public buildEvents(message: any): AnthropicEvent[] {
    const events: AnthropicEvent[] = [];
    const id = (message && message.id) || `msg_${Date.now()}`;
    const model = (message && typeof message.model === 'string' ? message.model : 'unknown');
    const blocks: any[] = Array.isArray(message?.content) ? message.content : [];
    const stopReason: string | null = (message?.stop_reason ?? null);
    const usage: any = message?.usage ?? null;

    // Start message
    events.push({ event: 'message_start', data: { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null } } });

    let index = 0;
    for (const block of blocks) {
      const bType = block?.type;
      if (bType === 'tool_use') {
        const toolId = block?.id || `call_${Math.random().toString(36).slice(2, 10)}`;
        const name = block?.name || 'tool';
        const input = (block?.input && typeof block.input === 'object') ? block.input : {};
        // Start tool block with input:{} as per Anthropic protocol
        events.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'tool_use', id: toolId, name, input: {} } } });
        try {
          const json = JSON.stringify(input);
          for (let offset = 0; offset < json.length; offset += this.jsonChunkBytes) {
            const partial = json.slice(offset, Math.min(json.length, offset + this.jsonChunkBytes));
            events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: partial } } });
          }
        } catch {
          events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '{}' } } });
        }
        events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
        index++;
        continue;
      }
      if (bType === 'text') {
        const text = typeof block?.text === 'string' ? block.text : '';
        events.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } } });
        if (text) {
          events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } } });
        }
        events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
        index++;
        continue;
      }
      // Unknown block types -> stringify as text
      events.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } } });
      try { events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: JSON.stringify(block) } } }); } catch { /* ignore */ }
      events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
      index++;
    }

    // message_delta
    events.push({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: stopReason ?? null, stop_sequence: null }, ...(usage ? { usage } : {}) } });
    // message_stop
    events.push({ event: 'message_stop', data: { type: 'message_stop' } });
    return events;
  }
}

