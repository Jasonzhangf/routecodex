/**
 * Responses SSE Simulator
 *
 * Converts a complete Responses payload into SSE events by simulating
 * incremental delivery when the pipeline returns non-stream data.
 */

export type ResponsesEvent = { event: string; data: Record<string, unknown> };

export class ResponsesSSESimulator {
  constructor(private chunkSize: number = Math.max(32, Math.min(1024, Number(process.env.ROUTECODEX_RESPONSES_TOOLCALL_DELTA_CHUNK || 256)))) {}

  public buildEvents(payload: any): ResponsesEvent[] {
    const events: ResponsesEvent[] = [];
    if (!payload || typeof payload !== 'object') {
      return events;
    }

    const responseId = typeof payload.id === 'string' ? payload.id : `resp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const created = typeof payload.created === 'number' ? payload.created : Math.floor(Date.now() / 1000);
    const model = typeof payload.model === 'string' ? payload.model : 'unknown';

    let seq = 1;
    const push = (event: string, data: Record<string, unknown>) => {
      events.push({ event, data: { ...data, sequence_number: seq++ } });
    };

    push('response.created', { type: 'response.created', response: { id: responseId, object: 'response', created, model } });
    push('response.in_progress', { type: 'response.in_progress', response: { id: responseId } });

    const output: any[] = Array.isArray(payload.output) ? payload.output : [];
    let outputIndex = 0;
    for (const item of output) {
      const type = item?.type;
      if (type === 'reasoning') {
        const reasonId = typeof item.id === 'string' ? item.id : `rs_${Math.random().toString(36).slice(2, 8)}`;
        push('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { id: reasonId, type: 'reasoning', summary: Array.isArray(item?.summary) ? item.summary : [], status: 'completed' } });
        push('response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item: { id: reasonId, type: 'reasoning' } });
        outputIndex += 1;
        continue;
      }
      if (type === 'message') {
        const message = item?.message || {};
        const messageId = typeof message.id === 'string' ? message.id : `msg_${Math.random().toString(36).slice(2, 8)}`;
        push('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { id: messageId, type: 'message', status: 'in_progress', content: [], role: message.role || 'assistant' } });
        const content = Array.isArray(message.content) ? message.content : [];
        let contentIndex = 0;
        for (const part of content) {
          const text = typeof part?.text === 'string' ? part.text : '';
          push('response.content_part.added', { type: 'response.content_part.added', item_id: messageId, output_index: outputIndex, content_index: contentIndex, part: { type: 'output_text', annotations: [], logprobs: [], text: '' } });
          if (text) {
            push('response.output_text.delta', { type: 'response.output_text.delta', item_id: messageId, output_index: outputIndex, content_index: contentIndex, delta: text, logprobs: [] });
          }
          contentIndex += 1;
        }
        push('response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item: { id: messageId, type: 'message', status: 'completed' } });
        outputIndex += 1;
        continue;
      }
      if (type === 'tool_call') {
        const id = typeof item?.tool_call?.id === 'string' ? item.tool_call.id : (typeof item?.id === 'string' ? item.id : `call_${Math.random().toString(36).slice(2, 8)}`);
        const name = item?.name || item?.tool_call?.name || 'tool';
        push('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { id, type: 'tool_call', name } });
        const args = typeof item?.arguments === 'string' ? item.arguments : (typeof item?.tool_call?.function?.arguments === 'string' ? item.tool_call.function.arguments : '');
        if (args) {
          for (const part of this.chunkString(args, this.chunkSize)) {
            push('response.tool_call.delta', { type: 'response.tool_call.delta', item_id: id, output_index: outputIndex, delta: { arguments: part } });
          }
        }
        push('response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item: { id, type: 'tool_call' } });
        outputIndex += 1;
        continue;
      }
    }

    push('response.completed', { type: 'response.completed', response: { id: responseId, status: payload.status || 'completed', stop_reason: payload.stop_reason ?? null }, usage: payload.usage || undefined });
    push('response.done', { type: 'response.done' });
    return events;
  }

  private chunkString(source: string, size: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < source.length; i += size) {
      out.push(source.slice(i, i + size));
    }
    return out;
  }
}
