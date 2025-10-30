/**
 * Streaming Manager Utility
 * Handles streaming responses for different protocols
 */

import { type Response } from 'express';
import type { ProtocolHandlerConfig } from '../handlers/base-handler.js';
import { PipelineDebugLogger } from '../../modules/pipeline/utils/debug-logger.js';
import { stripThinkingTags } from './text-filters.js';
import { chunkString } from 'rcc-llmswitch-core/conversion';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Streaming chunk interface
 */
export interface StreamingChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      content?: string;
      role?: string;
      tool_calls?: any[];
    };
    finish_reason?: string | null;
  }>;
}

/**
 * Streaming Manager Class
 */
export class StreamingManager {
  private config: ProtocolHandlerConfig;
  private logger: PipelineDebugLogger;
  private heartbeatTimers: Map<string, NodeJS.Timeout> = new Map();
  // Track a short window of recent tool_call signatures per request to drop short-range duplicates across chunks
  private lastToolCallKeys: Map<string, { set: Set<string>; order: string[] }> = new Map();
  // Per-request SSE event logs
  private sseLogWriters: Map<string, fs.WriteStream> = new Map();

  constructor(config: ProtocolHandlerConfig) {
    this.config = config;
    this.logger = new PipelineDebugLogger(null, {
      enableConsoleLogging: config.enableMetrics ?? true,
      enableDebugCenter: false,
    });
  }

  /**
   * Stream response to client
   */
  async streamResponse(response: any, requestId: string, res: Response, model: string): Promise<void> {
    try {
      // Set appropriate headers for streaming
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      // Disable proxy buffering for Nginx/Cloudflare style proxies to avoid stuck streams
      try { res.setHeader('X-Accel-Buffering', 'no'); } catch { /* ignore */ }
      res.setHeader('x-request-id', requestId);
      // Flush headers to start the SSE stream immediately
      try { (res as any).flushHeaders?.(); } catch { /* ignore */ }

      // Start streaming
      if (!this.shouldStreamFromPipeline()) {
        throw new Error('Streaming pipeline is disabled for this endpoint');
      }

      // Start SSE heartbeats (pre-heartbeat + periodic)
      this.startHeartbeat(res, requestId, model);

      // Open SSE event log file for Chat
      try {
        const base = path.join(os.homedir(), '.routecodex', 'codex-samples', 'openai-chat');
        fs.mkdirSync(base, { recursive: true });
        const file = path.join(base, `${requestId}_sse-events.log`);
        const ws = fs.createWriteStream(file, { flags: 'a' });
        this.sseLogWriters.set(requestId, ws);
        this.writeSSELog(requestId, 'stream.start', { requestId, model });
      } catch { /* ignore */ }

      await this.streamFromPipeline(response, requestId, res, model);

    } catch (error) {
      this.logger.logModule('StreamingManager', 'stream_error', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
        model,
      });

      // Send error chunk and close
      this.sendErrorChunk(res, error, requestId);
      this.stopHeartbeat(requestId);
      res.end();
      try { this.writeSSELog(requestId, 'stream.error', { message: (error as any)?.message || String(error) }); } catch { /* ignore */ }
      try { this.closeSSELog(requestId); } catch { /* ignore */ }
    }
  }

  /**
   * Stream Anthropic-compatible responses (delegates to generic streaming)
   */
  async streamAnthropicResponse(response: any, requestId: string, res: Response, model: string): Promise<void> {
    await this.streamResponse(response, requestId, res, model);
  }

  /**
   * Check if should stream from pipeline
   */
  private shouldStreamFromPipeline(): boolean {
    return this.config.enablePipeline ?? false;
  }

  /**
   * Stream from pipeline
   */
  private async streamFromPipeline(
    response: any,
    requestId: string,
    res: Response,
    model: string
  ): Promise<void> {
    // Always synthesize streaming from non-stream JSON
    if (!response || typeof response !== 'object' || !('data' in response)) {
      throw new Error('Streaming pipeline response is missing data payload');
    }
    const data = (response as Record<string, unknown>).data as any;
    await this.processStreamingData(data, requestId, res, model);
  }

  /**
   * Process streaming data
   */
  private async processStreamingData(
    data: any,
    requestId: string,
    res: Response,
    model: string
  ): Promise<void> {
    const finishReasons: string[] = [];
    let sawToolCalls = false;
    const emitChatRequiredAction = (msg: any) => {
      try {
        const enable = String(process.env.ROUTECODEX_CHAT_REQUIRED_ACTION || process.env.RCC_CHAT_REQUIRED_ACTION || '1').toLowerCase() !== '0';
        if (!enable || !msg || typeof msg !== 'object') return;
        const tcs: any[] = Array.isArray((msg as any).tool_calls) ? ((msg as any).tool_calls as any[]) : [];
        if (!tcs.length) return;
        const tool_calls = tcs.map((tc: any) => {
          const id = (tc && typeof tc.id === 'string' && tc.id) ? tc.id : `call_${Math.random().toString(36).slice(2,8)}`;
          const fn = (tc && typeof tc.function === 'object') ? tc.function : {};
          const name = typeof (fn as any).name === 'string' ? (fn as any).name : 'tool';
          const argsRaw = (fn as any).arguments;
          const args = typeof argsRaw === 'string' ? argsRaw : (() => { try { return JSON.stringify(argsRaw ?? {}); } catch { return '{}'; } })();
          return { id, type: 'function', function: { name, arguments: args } };
        });
        const evt = {
          type: 'response.required_action',
          required_action: { type: 'submit_tool_outputs', submit_tool_outputs: { tool_calls } }
        } as any;
        res.write(`event: response.required_action\n`);
        res.write(`data: ${JSON.stringify(evt)}\n\n`);
      } catch { /* ignore */ }
    };
    // Removed user-visible tool hint delta to avoid confusing client UIs.
    const genCallId = (index: number) => `call_${requestId}_${index}_${Math.random().toString(36).slice(2, 8)}`;

    // Helper: synthesize OpenAI-style streaming chunks from a non-stream JSON response
    const synthesizeFromResponse = (resp: any) => {
      const chunks: any[] = [];
      try {
        const msg = resp?.choices?.[0]?.message || {};
        const role = typeof msg?.role === 'string' ? msg.role : 'assistant';
        const content = typeof msg?.content === 'string' ? msg.content : '';
        const toolCallsFromArray = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
        const fnCall = (msg as any)?.function_call || null;
        const toolCalls = (() => {
          if (toolCallsFromArray.length) return toolCallsFromArray;
          if (fnCall && typeof fnCall === 'object') {
            const name = typeof fnCall.name === 'string' ? fnCall.name : undefined;
            const args = typeof fnCall.arguments === 'string' ? fnCall.arguments : (fnCall.arguments != null ? JSON.stringify(fnCall.arguments) : undefined);
            if (name || args) {
              return [{ id: undefined, type: 'function', function: { ...(name?{name}:{ }), ...(args?{arguments: args}:{ }) } }];
            }
          }
          return [] as any[];
        })();

        // Emit initial role delta to satisfy some clients' expectations
        chunks.push({ role });

        // Emit content when it不是工具JSON/补丁块回显
        const isLikelyToolJson = (s: string): boolean => /"version"\s*:\s*"rcc\.tool\.v1"/i.test(s) || /rcc\.tool\.v1/i.test(s);
        const isPatchBlock = (s: string): boolean => /\*\*\*\s*Begin\s*Patch/i.test(s);
        if (content.length > 0 && !isLikelyToolJson(content) && !isPatchBlock(content)) {
          chunks.push({ content });
        }

        // Emit tool_calls as delta blocks: name then arguments (single shot)
        if (toolCalls.length > 0) {
          sawToolCalls = true;
          for (let i = 0; i < toolCalls.length; i++) {
            const tc = toolCalls[i] || {};
            const fn = tc.function || {};
            const id = typeof tc.id === 'string' && tc.id.trim() ? tc.id : genCallId(i);
            const name = typeof fn.name === 'string' ? fn.name : undefined;
            const args = typeof fn.arguments === 'string' ? fn.arguments : (fn.arguments != null ? JSON.stringify(fn.arguments) : undefined);
            if (name) {
              chunks.push({ tool_calls: [{ index: i, id, type: 'function', function: { name } }] });
            }
            if (typeof args === 'string' && args.length > 0) {
              for (const d of chunkString(args)) {
                chunks.push({ tool_calls: [{ index: i, id, type: 'function', function: { arguments: d } }] });
              }
            }
          }
        }

        const finish = toolCalls.length > 0
          ? 'tool_calls'
          : (resp?.choices?.[0]?.finish_reason || resp?.finish_reason || 'stop');
        return { chunks, finish };
      } catch {
        return { chunks, finish: 'stop' };
      }
    };

    const pushChunk = async (raw: any) => {
      const normalized = this.normalizeChunk(raw, model, finishReasons);
      await this.sendChunk(res, normalized, requestId, model);
      await this.delay(10);
    };

    if (Array.isArray(data)) {
      // If array of chunks, stream as-is. Ensure the first delta carries role=assistant
      try {
        const first = data[0];
        if (first) {
          const preview = this.normalizeChunk(first, model, []);
          const hasRole = !!(preview?.choices && preview.choices[0]?.delta && typeof preview.choices[0].delta.role === 'string');
          if (!hasRole) {
            await this.sendChunk(res, { role: 'assistant' }, requestId, model);
            await this.delay(10);
          }
        }
      } catch { /* ignore */ }

      for (const chunk of data) {
        await pushChunk(chunk);
      }
      let finalReason = finishReasons.length ? finishReasons[finishReasons.length - 1] : undefined;
      if (!finalReason && sawToolCalls) { finalReason = 'tool_calls'; }
      // Removed hint delta to avoid confusing client UIs
      this.sendFinalChunk(res, requestId, model, finalReason);
      return;
    }

    if (typeof data === 'object' && data !== null) {
      // Non-stream JSON response: synthesize delta stream when choices[].message exists
      if (Array.isArray((data as any).choices) && (data as any).choices.length > 0 && (data as any).choices[0]?.message) {
        const { chunks, finish } = synthesizeFromResponse(data);
        for (const c of chunks) {
          await this.sendChunk(res, c, requestId, model);
          await this.delay(10);
        }
        try { emitChatRequiredAction((data as any).choices[0]?.message); } catch { /* ignore */ }
        this.sendFinalChunk(res, requestId, model, finish);
        return;
      }
      // Fallback: treat as single chunk
      await pushChunk(data);
      const finalReason = finishReasons.length ? finishReasons[finishReasons.length - 1] : undefined;
      this.sendFinalChunk(res, requestId, model, finalReason);
      return;
    }
  }

  /**
   * Normalize chunk into OpenAI streaming shape
   */
  private normalizeChunk(chunk: any, model: string, finishReasons: string[]): any {
    if (!chunk || typeof chunk !== 'object') {
      return chunk;
    }

    const hasDelta =
      chunk.object === 'chat.completion.chunk' ||
      (Array.isArray(chunk.choices) && chunk.choices.some((choice: any) => choice?.delta));

    if (hasDelta) {
      // Map delta.function_call -> delta.tool_calls for OpenAI older shape
      try {
        const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
        const isImagePath = (p: any): boolean => {
          try { const s = String(p || '').toLowerCase(); return /\.(png|jpg|jpeg|gif|webp|bmp|svg|tiff?|ico|heic|jxl)$/.test(s); } catch { return false; }
        };
        const parseArgs = (args: any): any => {
          if (typeof args === 'string') { try { return JSON.parse(args); } catch { return {}; } }
          if (args && typeof args === 'object') return args;
          return {};
        };
        for (const c of choices) {
          const d = c?.delta || {};
          const fc = d?.function_call;
          if (fc && typeof fc === 'object') {
            const name = typeof fc.name === 'string' ? fc.name : undefined;
            const args = typeof fc.arguments === 'string' ? fc.arguments : (fc.arguments != null ? JSON.stringify(fc.arguments) : undefined);
            const tc: any = { index: 0, type: 'function', function: {} as any };
            if (name) { (tc.function as any).name = name; }
            if (typeof args === 'string') { (tc.function as any).arguments = args; }
            if (!Array.isArray(d.tool_calls)) { d.tool_calls = []; }
            (d.tool_calls as any[]).push(tc);
          }
          // Filter invalid view_image tool_calls where path is not an image
          if (Array.isArray(d.tool_calls)) {
            const kept: any[] = [];
            for (const tc of d.tool_calls as any[]) {
              try {
                const fn = tc?.function || {};
                const nm = typeof fn?.name === 'string' ? fn.name : undefined;
                if (nm === 'view_image') {
                  const a = parseArgs(fn?.arguments);
                  const p = (a && typeof a === 'object') ? (a as any).path : undefined;
                  if (!isImagePath(p)) {
                    // Replace with a brief hint in content; drop this tool_call
                    const hint = typeof p === 'string' && p ? `提示：${p} 不是图片，请改用 shell: {"command":["cat","${p}"]}` : '提示：路径不是图片，请改用 shell: {"command":["cat","<path>"]}';
                    if (typeof d.content === 'string' && d.content.length > 0) {
                      d.content += `\n${hint}`;
                    } else {
                      d.content = hint;
                    }
                    continue;
                  }
                }
                kept.push(tc);
              } catch { kept.push(tc); }
            }
            d.tool_calls = kept;
          }
        }
      } catch { /* ignore */ }
      this.captureFinishReason(chunk, finishReasons);
      return chunk;
    }

    if (!Array.isArray(chunk.choices)) {
      return chunk;
    }

    const normalizedChoices = chunk.choices.map((choice: any, index: number) => {
      const message = choice?.message || {};
      const toolCallsArr = Array.isArray(message.tool_calls) ? message.tool_calls : undefined;
      const fnCall = (message as any)?.function_call || null;
      const isImagePath = (p: any): boolean => {
        try { const s = String(p || '').toLowerCase(); return /\.(png|jpg|jpeg|gif|webp|bmp|svg|tiff?|ico|heic|jxl)$/.test(s); } catch { return false; }
      };
      const parseArgs = (args: any): any => {
        if (typeof args === 'string') { try { return JSON.parse(args); } catch { return {}; } }
        if (args && typeof args === 'object') return args;
        return {};
      };
      const toolCalls = (() => {
        if (toolCallsArr && toolCallsArr.length) return toolCallsArr;
        if (fnCall && typeof fnCall === 'object') {
          const name = typeof fnCall.name === 'string' ? fnCall.name : undefined;
          const args = typeof fnCall.arguments === 'string' ? fnCall.arguments : (fnCall.arguments != null ? JSON.stringify(fnCall.arguments) : undefined);
          if (name || args) {
            return [{ id: undefined, type: 'function', function: { ...(name?{name}:{ }), ...(args?{arguments: args}:{ }) } }];
          }
        }
        return undefined;
      })();
      // Filter invalid view_image tool_calls when arguments contain a non-image path
      const filteredToolCalls = (() => {
        if (!Array.isArray(toolCalls)) return toolCalls;
        const kept: any[] = [];
        for (const tc of toolCalls) {
          try {
            const fn = (tc as any)?.function || {};
            const nm = typeof fn?.name === 'string' ? fn.name : undefined;
            if (nm === 'view_image') {
              const a = parseArgs((fn as any).arguments);
              const p = (a && typeof a === 'object') ? (a as any).path : undefined;
              if (!isImagePath(p)) {
                const hint = typeof p === 'string' && p ? `提示：${p} 不是图片，请改用 shell: {"command":["cat","${p}"]}` : '提示：路径不是图片，请改用 shell: {"command":["cat","<path>"]}';
                if (typeof message.content === 'string' && message.content.length > 0) {
                  message.content += `\n${hint}`;
                } else {
                  (message as any).content = hint;
                }
                continue;
              }
            }
            kept.push(tc);
          } catch { kept.push(tc); }
        }
        return kept;
      })();
      const delta: Record<string, unknown> = {};
      if (message.role && typeof message.role === 'string') {
        delta.role = message.role;
      }
      if (typeof message.content === 'string') {
        const s = message.content as string;
        const looksToolJson = /"version"\s*:\s*"rcc\.tool\.v1"/i.test(s) || /rcc\.tool\.v1/i.test(s);
        const looksPatch = /\*\*\*\s*Begin\s*Patch/i.test(s);
        if (!looksToolJson && !looksPatch) {
          delta.content = s;
        }
      }
      if (filteredToolCalls) {
        delta.tool_calls = filteredToolCalls;
      }
      if (typeof choice.content === 'string' && !delta.content) {
        delta.content = choice.content;
      }

      const finishReason = choice?.finish_reason ?? (message?.finish_reason as string | undefined);
      if (finishReason) {
        finishReasons.push(finishReason);
      }

      return {
        index: choice?.index ?? index,
        delta,
        finish_reason: null
      };
    });

    return {
      id: chunk.id ?? `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: chunk.created ?? Math.floor(Date.now() / 1000),
      model: chunk.model ?? model,
      choices: normalizedChoices
    };
  }

  private captureFinishReason(chunk: any, finishReasons: string[]): void {
    if (!chunk || typeof chunk !== 'object') {
      return;
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const choice of choices) {
      const reason = choice?.finish_reason;
      if (typeof reason === 'string' && reason.length > 0) {
        finishReasons.push(reason);
      }
    }
  }

  /**
   * Send chunk to response
   */
  private async sendChunk(
    res: Response,
    chunk: StreamingChunk | any,
    requestId: string,
    model: string
  ): Promise<void> {
    // Clean reasoning/thinking tags in content fields (delta.content and message.content)
    const cleanse = (obj: any) => {
      try {
        if (!obj || typeof obj !== 'object') return obj;
        const choices = Array.isArray(obj.choices) ? obj.choices : [];
        for (const c of choices) {
          if (c && typeof c === 'object') {
            const d = c.delta || {};
            if (typeof d.content === 'string') { d.content = stripThinkingTags(d.content); }
            if (c.message && typeof c.message === 'object' && typeof c.message.content === 'string') {
              c.message.content = stripThinkingTags(c.message.content);
            }
          }
        }
      } catch { /* ignore */ }
      return obj;
    };

    // If passing a light delta object (e.g., { role }, { content }, { tool_calls }), clean its content
    if (chunk && typeof chunk === 'object' && !('id' in chunk)) {
      if (typeof (chunk as any).content === 'string') {
        (chunk as any).content = stripThinkingTags((chunk as any).content);
      }
    }

    const chunkData = typeof chunk === 'object' && chunk.id ? cleanse(chunk) : {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        delta: chunk,
        finish_reason: null
      }]
    };

    // Short-window duplicate tool_call dedupe (per request, across chunks)
    try {
      const choices = Array.isArray((chunkData as any).choices) ? (chunkData as any).choices : [];
      for (const c of choices) {
        const d = c?.delta || {};
        if (Array.isArray(d.tool_calls) && d.tool_calls.length > 0) {
          const kept: any[] = [];
          const WINDOW = Math.max(1, Math.min(16, Number(process.env.ROUTECODEX_TOOL_CALL_DEDUPE_WINDOW || 4)));
          const bucket = this.lastToolCallKeys.get(requestId) || { set: new Set<string>(), order: [] };
          for (const tc of d.tool_calls as any[]) {
            try {
              const fn = tc?.function || {};
              const name = typeof fn?.name === 'string' ? fn.name : '';
              const args = fn?.arguments;
              const argsStr = typeof args === 'string' ? args : (args != null ? JSON.stringify(args) : '');
              const key = `${name}\n${argsStr}`;
              const hasBoth = name && argsStr;
              if (hasBoth && bucket.set.has(key)) { continue; }
              kept.push(tc);
              if (hasBoth) {
                bucket.set.add(key);
                bucket.order.push(key);
                if (bucket.order.length > WINDOW) {
                  const old = bucket.order.shift();
                  if (old) bucket.set.delete(old);
                }
              }
            } catch { kept.push(tc); }
          }
          d.tool_calls = kept;
          this.lastToolCallKeys.set(requestId, bucket);
        }
      }
    } catch { /* ignore dedupe errors */ }

    const sseData = `data: ${JSON.stringify(chunkData)}\n\n`;
    res.write(sseData);
    try { this.writeSSELog(requestId, 'chunk', chunkData); } catch { /* ignore */ }

    try {
      const LOG = String(process.env.ROUTECODEX_LOG_STREAM_CHUNKS || process.env.RCC_LOG_STREAM_CHUNKS || '0') === '1';
      if (LOG) {
        this.logger.logModule('StreamingManager', 'chunk_sent', {
          requestId,
          chunkId: chunkData.id,
          model,
        });
      }
    } catch { /* no-op */ }
  }

  /**
   * Send final chunk
   */
  private sendFinalChunk(res: Response, requestId: string, model: string, finishReason?: string): void {
    const finalChunk = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: finishReason ?? 'stop'
      }]
    };

    // 可选：发出 Responses 风格的 done 事件（默认关闭，以避免跨协议混用）
    try {
      const EMIT_RESP_DONE = String(process.env.ROUTECODEX_CHAT_RESP_DONE || '0') === '1';
      if (EMIT_RESP_DONE) {
        const evt = { type: 'response.done' } as Record<string, unknown>;
        res.write(`event: response.done\n`);
        res.write(`data: ${JSON.stringify(evt)}\n\n`);
      }
    } catch { /* ignore */ }
    const finalData = `data: ${JSON.stringify(finalChunk)}\n\ndata: [DONE]\n\n`;
    res.write(finalData);
    this.stopHeartbeat(requestId);
    res.end();
    // Reset short-window cache for this request
    try { this.lastToolCallKeys.delete(requestId); } catch { /* ignore */ }
    try {
      this.writeSSELog(requestId, 'chunk.final', finalChunk);
      this.writeSSELog(requestId, 'done', { requestId });
      this.closeSSELog(requestId);
    } catch { /* ignore */ }

    try {
      const LOG = String(process.env.ROUTECODEX_LOG_STREAM_CHUNKS || process.env.RCC_LOG_STREAM_CHUNKS || '0') === '1';
      if (LOG) {
        this.logger.logModule('StreamingManager', 'stream_complete', {
          requestId,
          model,
        });
      }
    } catch { /* no-op */ }
  }

  /**
   * Send error chunk
   */
  private sendErrorChunk(res: Response, error: any, requestId: string): void {
    const errorChunk = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'unknown',
      choices: [{
        index: 0,
        delta: {
          content: `Error: ${error instanceof Error ? error.message : String(error)}`
        },
        finish_reason: 'error'
      }]
    };

    try {
      const evt = { type: 'response.done' } as Record<string, unknown>;
      res.write(`event: response.done\n`);
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    } catch { /* ignore */ }
    const errorData = `data: ${JSON.stringify(errorChunk)}\n\ndata: [DONE]\n\n`;
    res.write(errorData);
    this.stopHeartbeat(requestId);
    try {
      this.writeSSELog(requestId, 'error', errorChunk);
      this.writeSSELog(requestId, 'done', { requestId });
      this.closeSSELog(requestId);
    } catch { /* ignore */ }
  }

  // Write one SSE log record line
  private writeSSELog(requestId: string, event: string, data: any): void {
    try {
      const ws = this.sseLogWriters.get(requestId);
      if (!ws) return;
      ws.write(JSON.stringify({ ts: Date.now(), requestId, event, data }) + '\n');
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

  /**
   * Delay utility
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Heartbeat helpers
  private startHeartbeat(res: Response, requestId: string, model: string): void {
    try {
      const iv = Math.max(1000, Number(process.env.ROUTECODEX_STREAM_HEARTBEAT_MS || process.env.RCC_STREAM_HEARTBEAT_MS || 15000));
      const pre = String(process.env.ROUTECODEX_STREAM_PRE_HEARTBEAT || process.env.RCC_STREAM_PRE_HEARTBEAT || '1') === '1';
      const writeBeat = () => {
        try {
          const payload = { type: 'heartbeat', ts: Date.now(), model };
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        } catch { /* ignore */ }
      };
      if (pre) writeBeat();
      const timer = setInterval(writeBeat, iv);
      this.heartbeatTimers.set(requestId, timer);
      try { res.on('close', () => this.stopHeartbeat(requestId)); } catch { /* ignore */ }
    } catch { /* ignore */ }
  }

  private stopHeartbeat(requestId: string): void {
    try {
      const t = this.heartbeatTimers.get(requestId);
      if (t) { clearInterval(t); this.heartbeatTimers.delete(requestId); }
    } catch { /* ignore */ }
  }

  /**
   * Check if response is streamable
   */
  isStreamable(response: any): boolean {
    return (
      response?.stream === true ||
      (typeof response?.pipe === 'function') ||
      (Array.isArray(response?.data)) ||
      (this.config.enableStreaming === true)
    );
  }

  /**
   * Get streaming statistics
   */
  getStreamingStats(): {
    enabled: boolean;
    config: ProtocolHandlerConfig;
  } {
    return {
      enabled: this.config.enableStreaming ?? false,
      config: this.config,
    };
  }
}
