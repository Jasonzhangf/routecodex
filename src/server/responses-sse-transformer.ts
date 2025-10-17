/**
 * Responses SSE Transformer
 *
 * Converts OpenAI ChatCompletion streaming chunks into OpenAI Responses
 * SSE events (response.*) so clients receive incremental updates.
 */

export type ResponsesEvent = { event: string; data: Record<string, unknown> };

interface ToolAccumulator {
  id: string;
  name: string;
  buffer: string;
  started: boolean;
}

export class ResponsesSSETransformer {
  private responseId = '';
  private model = '';
  private created = 0;
  private sequence = 0;
  private textItemId: string | null = null;
  private finishReason: string | null = null;
  private usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null = null;
  private toolCalls: Map<number, ToolAccumulator> = new Map();

  constructor(private chunkSize: number = Math.max(32, Math.min(1024, Number(process.env.ROUTECODEX_RESPONSES_TOOLCALL_DELTA_CHUNK || 256)))) {}

  private nextSeq(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private ensureMeta(chunk: any): void {
    if (!this.responseId) {
      const id = typeof chunk?.id === 'string' ? chunk.id : (typeof chunk?.request_id === 'string' ? chunk.request_id : null);
      this.responseId = id || `resp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    }
    if (!this.model) {
      this.model = typeof chunk?.model === 'string' ? chunk.model : 'unknown';
    }
    if (!this.created) {
      const ts = Number(chunk?.created);
      this.created = Number.isFinite(ts) ? ts : Math.floor(Date.now() / 1000);
    }
  }

  public processOpenAIChunk(raw: any): ResponsesEvent[] {
    const events: ResponsesEvent[] = [];
    if (!raw) return events;

    this.ensureMeta(raw);

    if (this.sequence === 0) {
      events.push({ event: 'response.created', data: { type: 'response.created', response: { id: this.responseId, object: 'response', created: this.created, model: this.model }, sequence_number: this.nextSeq() } });
      events.push({ event: 'response.in_progress', data: { type: 'response.in_progress', response: { id: this.responseId }, sequence_number: this.nextSeq() } });
    }

    const choice = Array.isArray(raw?.choices) ? raw.choices[0] : undefined;
    const delta = choice?.delta || {};

    const textPieces = Array.isArray(delta?.content) ? delta.content.filter((c: any) => c && c.type === 'text' && typeof c.text === 'string') : [];
    for (const piece of textPieces) {
      if (!this.textItemId) {
        this.textItemId = `msg_${this.responseId}`;
        events.push({ event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: 0, item: { id: this.textItemId, type: 'message', status: 'in_progress', content: [], role: 'assistant' }, sequence_number: this.nextSeq() } });
        events.push({ event: 'response.content_part.added', data: { type: 'response.content_part.added', item_id: this.textItemId, output_index: 0, content_index: 0, part: { type: 'output_text', annotations: [], logprobs: [], text: '' }, sequence_number: this.nextSeq() } });
      }
      events.push({ event: 'response.output_text.delta', data: { type: 'response.output_text.delta', item_id: this.textItemId, output_index: 0, content_index: 0, delta: piece.text, logprobs: [], sequence_number: this.nextSeq() } });
    }

    const toolDeltas = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
    for (const tc of toolDeltas) {
      const index = Number(tc?.index ?? 0);
      let acc = this.toolCalls.get(index);
      if (!acc) {
        const id = typeof tc?.id === 'string' ? tc.id : `call_${Math.random().toString(36).slice(2, 8)}`;
        const name = typeof tc?.function?.name === 'string' ? tc.function.name : 'tool';
        acc = { id, name, buffer: '', started: false };
        this.toolCalls.set(index, acc);
        events.push({ event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: index + 1, item: { id, type: 'tool_call', name }, sequence_number: this.nextSeq() } });
      }
      const args = typeof tc?.function?.arguments === 'string' ? tc.function.arguments : '';
      if (args) {
        acc.buffer += args;
        for (const part of this.chunkString(args, this.chunkSize)) {
          events.push({ event: 'response.tool_call.delta', data: { type: 'response.tool_call.delta', item_id: acc.id, output_index: index + 1, delta: { arguments: part }, sequence_number: this.nextSeq() } });
        }
      }
    }

    const finish = choice?.finish_reason;
    if (typeof finish === 'string') {
      this.finishReason = finish;
    }

    const usage = raw?.usage;
    if (usage && typeof usage === 'object') {
      this.usage = {
        prompt_tokens: Number(usage?.prompt_tokens ?? usage?.input_tokens) || 0,
        completion_tokens: Number(usage?.completion_tokens ?? usage?.output_tokens) || 0,
        total_tokens: Number(usage?.total_tokens) || undefined,
      };
    }

    return events;
  }

  public finalize(): ResponsesEvent[] {
    const events: ResponsesEvent[] = [];

    for (const [, acc] of this.toolCalls.entries()) {
      events.push({ event: 'response.output_item.done', data: { type: 'response.output_item.done', output_index: 0, item: { id: acc.id, type: 'tool_call' }, sequence_number: this.nextSeq() } });
    }

    if (this.textItemId) {
      events.push({ event: 'response.output_item.done', data: { type: 'response.output_item.done', output_index: 0, item: { id: this.textItemId, type: 'message', status: 'completed' }, sequence_number: this.nextSeq() } });
    }

    events.push({ event: 'response.completed', data: { type: 'response.completed', response: { id: this.responseId, status: 'completed', stop_reason: this.finishReason ?? null }, usage: this.usage || undefined, sequence_number: this.nextSeq() } });
    events.push({ event: 'response.done', data: { type: 'response.done', sequence_number: this.nextSeq() } });
    return events;
  }

  private chunkString(input: string, size: number): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < input.length; i += size) {
      chunks.push(input.slice(i, i + size));
    }
    return chunks;
  }
}
