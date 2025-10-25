import { type Response } from 'express';
import { stripThinkingTags } from './text-filters.js';

type ChatChoice = {
  index?: number;
  message?: {
    role?: string;
    content?: string;
    tool_calls?: Array<{ id?: string; type?: 'function'; function?: { name?: string; arguments?: string } }>;
  };
  finish_reason?: string | null;
};

type ChatResponse = {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices: ChatChoice[];
};

export async function emitOpenAIChatSSE(res: Response, payload: unknown, requestId: string, model: string): Promise<void> {
  const data = coerceChatResponse(payload);
  // Initial role delta to satisfy some clients
  await sendDelta(res, { role: 'assistant' }, model);

  const choice = data.choices?.[0] || {};
  const msg = (choice as any).message || {};
  const content = typeof msg.content === 'string' ? msg.content : '';
  const toolCalls = Array.isArray(msg.tool_calls) ? (msg.tool_calls as any[]) : [];

  if (content) {
    await sendDelta(res, { content: stripThinkingTags(content) }, model);
  }

  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i] || {};
    const fn = tc.function || {};
    const id = typeof tc.id === 'string' && tc.id.trim() ? tc.id : genId(requestId, i);
    const name = typeof fn.name === 'string' ? fn.name : undefined;
    const args = typeof fn.arguments === 'string' ? fn.arguments : (fn.arguments != null ? JSON.stringify(fn.arguments) : undefined);
    if (name) {
      await sendDelta(res, { tool_calls: [{ index: i, id, type: 'function', function: { name } }] }, model);
    }
    if (typeof args === 'string' && args.length > 0) {
      await sendDelta(res, { tool_calls: [{ index: i, id, type: 'function', function: { arguments: args } }] }, model);
    }
  }

  const finish = toolCalls.length > 0 ? 'tool_calls' : (choice.finish_reason || 'stop');
  sendFinal(res, model, finish || undefined);
}

function coerceChatResponse(payload: unknown): ChatResponse {
  if (payload && typeof payload === 'object' && 'choices' in (payload as any) && Array.isArray((payload as any).choices)) {
    return payload as ChatResponse;
  }
  return { choices: [] } as ChatResponse;
}

async function sendDelta(res: Response, delta: Record<string, unknown>, model: string): Promise<void> {
  const chunk = {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: null }]
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  await delay(10);
}

function sendFinal(res: Response, model: string, finish?: string): void {
  const finalChunk = {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: finish || 'stop' }]
  };
  res.write(`data: ${JSON.stringify(finalChunk)}\n\ndata: [DONE]\n\n`);
}

function genId(prefix: string, i: number): string { return `call_${prefix}_${i}_${Math.random().toString(36).slice(2,8)}`; }
function delay(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

