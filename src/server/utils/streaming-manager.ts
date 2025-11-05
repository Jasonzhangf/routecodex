/**
 * Streaming Manager Utility (simplified)
 * Only forwards upstream readable streams or uses llmswitch-core bridges.
 * No local protocol conversion or tool argument aggregation.
 */

import { type Response } from 'express';
import type { ProtocolHandlerConfig } from '../handlers/base-handler.js';
import { EnhancedRouteCodexError } from './error-context.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { getAppVersion, getCoreVersion } from './version.js';
// streaming functions are loaded via dynamic import to avoid tight coupling to tgz export surface

export class StreamingManager {
  private config: ProtocolHandlerConfig;
  private sseLogWriters: Map<string, fs.WriteStream> = new Map();

  constructor(config: ProtocolHandlerConfig) {
    this.config = config;
  }

  async streamResponse(response: any, requestId: string, res: Response, _model: string): Promise<void> {
    // Headers
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('x-request-id', requestId);
    (res as any).flushHeaders?.();

    if (!this.shouldStreamFromPipeline()) {
      throw new Error('Streaming pipeline is disabled for this endpoint');
    }

    // Minimal SSE logging
    try {
      const base = path.join(os.homedir(), '.routecodex', 'codex-samples', 'openai-chat');
      fs.mkdirSync(base, { recursive: true });
      const file = path.join(base, `${requestId}_sse-events.log`);
      const ws = fs.createWriteStream(file, { flags: 'a' });
      this.sseLogWriters.set(requestId, ws);
      this.writeSSELog(requestId, 'stream.start', { requestId, appVersion: getAppVersion(), coreVersion: getCoreVersion() });
    } catch { /* ignore */ }

    try {
      // If response is a readable stream, passthrough; otherwise synthesize from JSON
      const core = await import('rcc-llmswitch-core/api');
      const passthrough = (core as any).streamOpenAIReadablePassthrough;
      const readable = this.isStreamable(response);
      if (readable) {
        if (typeof passthrough !== 'function') throw new Error('core.streamOpenAIReadablePassthrough unavailable');
        await passthrough(response, res as any, { requestId });
        try { this.writeSSELog(requestId, 'stream.done', { requestId }); } catch { /* ignore */ }
        return;
      }

      // Synthesize SSE from JSON payload
      const payload = (response && typeof response === 'object' && 'data' in (response as any))
        ? (response as any).data
        : response;
      await this.synthesizeOpenAIChatSSE(payload, requestId, res);
      try { this.writeSSELog(requestId, 'stream.done', { requestId, synthesized: true }); } catch { /* ignore */ }
    } catch (err) {
      this.sendErrorChunk(res, err, requestId);
    } finally {
      try { this.closeSSELog(requestId); } catch { /* ignore */ }
    }
  }

  async streamAnthropicResponse(response: any, requestId: string, res: Response, model: string): Promise<void> {
    // Headers
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('x-request-id', requestId);
    (res as any).flushHeaders?.();

    const windowMs = Number(process.env.RCC_O2A_COALESCE_MS || 1000) || 1000;
    try {
      const top = response && typeof (response as any).pipe === 'function' ? (response as any) : null;
      const nested = (!top && response && typeof (response as any).data?.pipe === 'function') ? (response as any).data : null;
      const readable = top || nested;
      if (readable) {
        const core = await import('rcc-llmswitch-core/api');
        const fn = (core as any).streamOpenAIToAnthropic;
        if (typeof fn === 'function') {
          await fn(response, res as any, { requestId, model, windowMs });
          return;
        }
        // Legacy entry
        const legacy = await import('rcc-llmswitch-core');
        const t = (legacy as any).transformOpenAIStreamToAnthropic;
        if (typeof t !== 'function') throw new Error('Anthropic streaming transformer unavailable');
        await t(readable, res as any, { requestId, model, windowMs, useEventHeaders: true });
        return;
      }
      // Synthesize Anthropic SSE from non-stream JSON
      const payload = (response && typeof response === 'object' && 'data' in (response as any))
        ? (response as any).data
        : response;
      await this.synthesizeAnthropicSSE(payload, requestId, model, res);
    } catch (e) {
      this.sendErrorChunk(res, e, requestId);
    }
  }

  private shouldStreamFromPipeline(): boolean {
    return this.config.enablePipeline ?? false;
  }

  private sendErrorChunk(res: Response, error: any, requestId: string): void {
    try {
      const errorChunk = {
        id: `error_${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'unknown',
        choices: [],
        error: {
          message: (error instanceof Error ? error.message : String(error)) || 'stream error',
          type: 'streaming_error',
          code: 'STREAM_FAILED',
          requestId,
        }
      } as any;
      const errorData = `data: ${JSON.stringify(errorChunk)}\n\ndata: [DONE]\n\n`;
      res.write(errorData);
      this.writeSSELog(requestId, 'error', errorChunk);
      this.writeSSELog(requestId, 'done', { requestId });
    } catch { /* ignore */ }
  }

  private writeSSELog(requestId: string, event: string, data: any): void {
    try {
      const ws = this.sseLogWriters.get(requestId);
      if (!ws) return;
      ws.write(`${JSON.stringify({ ts: Date.now(), requestId, event, data })}\n`);
    } catch { /* ignore */ }
  }

  private closeSSELog(requestId: string): void {
    try {
      const ws = this.sseLogWriters.get(requestId);
      if (ws) {
        try { ws.end(); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    finally { this.sseLogWriters.delete(requestId); }
  }

  // Compatibility helpers (minimal)
  isStreamable(response: any): boolean {
    return (typeof response?.pipe === 'function') || (typeof response?.data?.pipe === 'function');
  }

  getStreamingStats(): { enabled: boolean; config: ProtocolHandlerConfig } {
    return { enabled: this.config.enableStreaming ?? false, config: this.config };
  }

  /**
   * Synthesize OpenAI Chat SSE from a non-stream JSON payload
   */
  private async synthesizeOpenAIChatSSE(payload: any, requestId: string, res: Response): Promise<void> {
    try {
      try { res.setHeader('x-rc-synth', '1'); } catch { /* ignore */ }
      const nowSec = Math.floor(Date.now() / 1000);
      const model = (payload?.model) || 'unknown';
      const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
      const msg = choice?.message || {};
      const content: string = typeof msg?.content === 'string' ? msg.content : '';
      const tc: any[] = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];

      const writeChunk = (obj: any) => {
        const line = `data: ${JSON.stringify(obj)}\n\n`;
        try { res.write(line); } catch { /* ignore */ }
        try { this.writeSSELog(requestId, 'chunk', obj); } catch { /* ignore */ }
      };

      // Emit content chunks if present
      if (content && content.length) {
        const step = 200; // simple segmentation
        for (let i = 0; i < content.length; i += step) {
          const slice = content.slice(i, i + step);
          const chunk = {
            id: `syn_${Date.now()}_${i}`,
            object: 'chat.completion.chunk',
            created: nowSec,
            model,
            choices: [ { index: 0, delta: { content: slice }, finish_reason: null } ]
          };
          writeChunk(chunk);
        }
      }

      // Emit tool_calls as a single delta chunk if present
      if (tc && tc.length) {
        const first = tc[0] || {};
        const fn = first.function || {};
        const name = typeof fn?.name === 'string' ? fn.name : undefined;
        let args = fn?.arguments;
        if (args && typeof args !== 'string') { try { args = JSON.stringify(args); } catch { args = String(args); } }
        const chunk = {
          id: `syn_tc_${Date.now()}`,
          object: 'chat.completion.chunk',
          created: nowSec,
          model,
          choices: [ { index: 0, delta: { tool_calls: [ { index: 0, id: first.id || `call_${Date.now()}`, type: 'function', function: { name, arguments: args || '{}' } } ] }, finish_reason: null } ]
        } as any;
        writeChunk(chunk);
      }

      // Final chunk
      const finish = Array.isArray(tc) && tc.length ? 'tool_calls' : (choice?.finish_reason || 'stop');
      const finalChunk = {
        id: `syn_end_${Date.now()}`,
        object: 'chat.completion.chunk',
        created: nowSec,
        model,
        choices: [ { index: 0, delta: {}, finish_reason: finish } ]
      };
      writeChunk(finalChunk);
      try { res.write('data: [DONE]\n\n'); } catch { /* ignore */ }
      try { res.end(); } catch { /* ignore */ }
    } catch (error) {
      this.sendErrorChunk(res, error, requestId);
    }
  }

  /**
   * Synthesize Anthropic Messages SSE from a non-stream OpenAI JSON payload
   */
  private async synthesizeAnthropicSSE(payload: any, requestId: string, model: string, res: Response): Promise<void> {
    try {
      try { res.setHeader('x-rc-synth', 'anthropic'); } catch { /* ignore */ }
      const nowSec = Math.floor(Date.now() / 1000);
      const ch = Array.isArray(payload?.choices) ? payload.choices[0] : null;
      const msg = ch?.message || {};
      const text: string = typeof msg?.content === 'string' ? msg.content : '';
      const toolCalls: any[] = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];

      const write = (event: string, data: any) => {
        try { res.write(`event: ${event}\n`); } catch { /* ignore */ }
        try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* ignore */ }
        try { this.writeSSELog(requestId, event, data); } catch { /* ignore */ }
      };

      // message_start
      write('message_start', { type: 'message', id: `msg_${Date.now()}`, model, role: 'assistant' });

      let blockIndex = 0;
      if (text && text.length) {
        write('content_block_start', { index: blockIndex, content_block: { type: 'text', text: '' } });
        const step = 200;
        for (let i = 0; i < text.length; i += step) {
          const slice = text.slice(i, i + step);
          write('content_block_delta', { index: blockIndex, delta: { type: 'text_delta', text: slice } });
        }
        write('content_block_stop', { index: blockIndex });
        blockIndex++;
      }

      for (const tc of toolCalls) {
        const fn = tc?.function || {};
        const name = typeof fn?.name === 'string' ? fn.name : 'tool';
        let input: any = {};
        if (typeof fn?.arguments === 'string') { try { input = JSON.parse(fn.arguments); } catch { input = {}; } }
        else if (fn?.arguments && typeof fn.arguments === 'object') { input = fn.arguments; }
        write('content_block_start', { index: blockIndex, content_block: { type: 'tool_use', id: tc?.id || `call_${Date.now()}`, name, input } });
        write('content_block_stop', { index: blockIndex });
        blockIndex++;
      }

      const stopReason = ch?.finish_reason === 'tool_calls' ? 'tool_use' : (ch?.finish_reason || 'stop');
      write('message_delta', { delta: { stop_reason: stopReason }, usage: payload?.usage || undefined });
      write('message_stop', { created: nowSec });
      try { res.end(); } catch { /* ignore */ }
    } catch (error) {
      this.sendErrorChunk(res, error, requestId);
    }
  }
}
