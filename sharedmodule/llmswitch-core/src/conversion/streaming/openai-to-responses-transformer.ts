import { Readable } from 'stream';
import { OpenAISSEParser } from './openai-sse-parser.js';

type RespEvent = { event: string; data: Record<string, unknown> };

type ToolAccum = {
  id: string;
  name?: string;
  args: string;
  added: boolean;
  done: boolean;
};

interface Options {
  requestId: string;
  model: string;
  windowMs?: number; // default 1000ms
}

/**
 * Transform OpenAI Chat SSE → OpenAI Responses SSE (incremental).
 * Emits events compatible with OpenAI Responses stream semantics.
 */
export async function transformOpenAIStreamToResponses(
  readable: Readable,
  res: { write: (s: string) => any; end: () => any; setHeader?: (k: string, v: string) => any },
  opts: Options
): Promise<void> {
  const requestId = opts.requestId || `req_${Date.now()}`;
  const model = opts.model || 'unknown';
  const windowMs = typeof opts.windowMs === 'number' ? Math.max(0, opts.windowMs) : (Number(process.env.RCC_R2C_COALESCE_MS || 1000) || 1000);

  // Headers
  try {
    res.setHeader?.('Content-Type', 'text/event-stream');
    res.setHeader?.('Cache-Control', 'no-cache');
    res.setHeader?.('Connection', 'keep-alive');
    res.setHeader?.('x-request-id', requestId);
  } catch { /* ignore */ }

  let seq = 0;
  const writeEvt = (event: string, data: Record<string, unknown>) => {
    const payload = { ...data, sequence_number: seq++ } as Record<string, unknown>;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  // Response identity/state
  let responseId = `resp_${Date.now()}`;
  let createdAt = Math.floor(Date.now() / 1000);
  let createdEmitted = false;

  // Text coalescing
  let textBuffer = '';
  let lastFlush = 0;
  const flushText = (force = false) => {
    if (textBuffer.length === 0) return;
    const now = Date.now();
    if (!force && now - lastFlush < windowMs) return;
    const delta = textBuffer;
    textBuffer = '';
    lastFlush = now;
    writeEvt('response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta, logprobs: [] });
  };

  // Tool calls accumulators (indexed by delta.tool_calls[index])
  const tools = new Map<number, ToolAccum>();
  const ensureTool = (index: number, id?: string) => {
    let acc = tools.get(index);
    if (!acc) {
      acc = { id: id || `call_${Math.random().toString(36).slice(2, 10)}`, args: '', added: false, done: false };
      tools.set(index, acc);
    }
    return acc;
  };

  // Finish/use
  let finishReason: string | null = null;
  let usage: { input_tokens?: number; output_tokens?: number; total_tokens?: number } | null = null;

  const mapFinish = (fr?: string | null): string | null => {
    if (!fr) return null;
    switch (fr) {
      case 'length': return 'max_tokens';
      case 'tool_calls': return 'tool_calls';
      default: return fr;
    }
  };

  const parser = new OpenAISSEParser(
    readable,
    (chunk: any) => {
      try {
        if (!createdEmitted) {
          responseId = String(chunk?.id ? `resp_${chunk.id}` : responseId);
          createdAt = Number(chunk?.created || createdAt);
          writeEvt('response.created', { type: 'response.created', response: { id: responseId, object: 'response', created_at: createdAt, model, status: 'in_progress' } });
          createdEmitted = true;
        }

        const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : undefined;
        const delta = choice?.delta || {};

        // Text delta
        const content: string | undefined = typeof delta?.content === 'string' ? delta.content : undefined;
        if (typeof content === 'string' && content.length > 0) {
          textBuffer += content;
          flushText();
        }

        // Tool calls (new shape)
        const tcs = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
        for (const tc of tcs) {
          const idx = Number(tc?.index ?? 0);
          const id = typeof tc?.id === 'string' ? tc.id : undefined;
          const acc = ensureTool(idx, id);
          const name = typeof tc?.function?.name === 'string' ? tc.function.name : undefined;
          const argsPart = typeof tc?.function?.arguments === 'string' ? tc.function.arguments : undefined;
          if (name && !acc.added) {
            acc.name = name;
            writeEvt('response.output_item.added', { type: 'response.output_item.added', output_index: idx, item: { id: acc.id, type: 'function_call', status: 'in_progress', call_id: acc.id, name } });
            acc.added = true;
          }
          if (typeof argsPart === 'string' && argsPart.length > 0) {
            acc.args += argsPart;
            writeEvt('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: acc.id, output_index: idx, delta: argsPart });
          }
        }

        // Old function_call shape
        const fc = delta?.function_call;
        if (fc && typeof fc === 'object') {
          const acc = ensureTool(0);
          const name = typeof fc?.name === 'string' ? fc.name : undefined;
          const argsPart = typeof fc?.arguments === 'string' ? fc.arguments : undefined;
          if (name && !acc.added) {
            acc.name = name;
            writeEvt('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: acc.id, type: 'function_call', status: 'in_progress', call_id: acc.id, name } });
            acc.added = true;
          }
          if (typeof argsPart === 'string' && argsPart.length > 0) {
            acc.args += argsPart;
            writeEvt('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: acc.id, output_index: 0, delta: argsPart });
          }
        }

        // Finish and usage capture
        const fr = choice?.finish_reason;
        if (typeof fr === 'string' && fr.length > 0) {
          finishReason = fr;
        }
        if (chunk?.usage && typeof chunk.usage === 'object') {
          const u = chunk.usage as any;
          const input = Number(u?.prompt_tokens || 0);
          const output = Number(u?.completion_tokens || 0);
          const total = Number(u?.total_tokens || (input + output));
          usage = { input_tokens: input, output_tokens: output, total_tokens: total };
        }
      } catch { /* ignore */ }
    },
    () => {
      try {
        // Flush remaining text
        flushText(true);
        // Close all tool items
        for (const [idx, acc] of tools.entries()) {
          if (!acc.done) {
            if (acc.args.length > 0) {
              writeEvt('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: acc.id, output_index: idx, arguments: acc.args });
            }
            writeEvt('response.output_item.done', { type: 'response.output_item.done', output_index: idx, item: { id: acc.id, type: 'function_call', status: 'completed', call_id: acc.id, name: acc.name, arguments: acc.args } });
            acc.done = true;
          }
        }
        // Final output_text.done if we ever sent text deltas but not .done
        writeEvt('response.output_text.done', { type: 'response.output_text.done', output_index: 0, content_index: 0, logprobs: [] });

        // Completed
        const fr = mapFinish(finishReason);
        const base: any = { id: responseId, object: 'response', created_at: createdAt, model, status: 'completed' };
        if (usage) base.usage = usage;
        writeEvt('response.completed', { type: 'response.completed', response: base });
      } catch { /* ignore */ }
      try { res.end(); } catch { /* ignore */ }
    }
  );

  // Pipe errors end stream gracefully
  readable.on('error', () => {
    try {
      writeEvt('response.error', { type: 'response.error', error: { message: 'upstream stream error', type: 'streaming_error', code: 'STREAM_FAILED' }, requestId });
    } catch { /* ignore */ }
    try { res.end(); } catch { /* ignore */ }
  });

  parser.start();
}

