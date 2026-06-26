import { describe, expect, it } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';

import { sendPipelineResponse } from '../../../src/server/handlers/handler-response-utils.js';
import { MetadataCenter } from '../../../src/server/runtime/http-server/metadata-center/metadata-center.js';

function sseStreamFrame(data: Record<string, unknown>, event = 'message'): Readable {
  return Readable.from([`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`]);
}

function sseStreamChunks(chunks: string[]): Readable {
  return Readable.from(chunks);
}

function delayedSseStreamChunks(chunks: string[]): Readable {
  async function* delayedChunks() {
    for (const chunk of chunks) {
      await new Promise((resolve) => setImmediate(resolve));
      yield chunk;
    }
  }
  return Readable.from(delayedChunks());
}

function directResponsesTerminalFrames(responseId: string, lineBreak = '\n'): string[] {
  return [
    `event: response.completed${lineBreak}data: ${JSON.stringify({
      type: 'response.completed',
      response: { id: responseId, object: 'response', status: 'completed' }
    })}${lineBreak}${lineBreak}`,
    `event: response.done${lineBreak}data: ${JSON.stringify({
      type: 'response.done',
      response: { id: responseId, object: 'response', status: 'completed' }
    })}${lineBreak}${lineBreak}`,
  ];
}

async function requestSse(
  body: Record<string, unknown>,
  options?: {
    metadata?: Record<string, unknown>;
    continuationOwner?: 'direct' | 'relay';
    chunks?: string[];
    delayChunks?: boolean;
    entryEndpoint?: string;
  }
): Promise<{ status: number; text: string }> {
  const app = express();
  app.get('/sse', (_req, res) => {
    const stream = options?.chunks
      ? options.delayChunks
        ? delayedSseStreamChunks(options.chunks)
        : sseStreamChunks(options.chunks)
      : sseStreamFrame(body);
    void sendPipelineResponse(
      res as any,
      {
        status: 200,
        headers: {},
        body: {
          mode: 'sse'
        },
        sseStream: stream,
        metadata: {
          outboundStream: true,
          clientModelId: 'client-visible-model',
          ...(options?.metadata ?? {})
        },
        continuationOwner: options?.continuationOwner,
      } as any,
      'req_sse_metadata_guard',
      { entryEndpoint: options?.entryEndpoint ?? '/v1/responses' }
    );
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${addr.port}/sse`, {
      headers: { accept: 'text/event-stream' }
    });
    return { status: response.status, text: await response.text() };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('handler-response-utils SSE metadata guard (Phase Server-C)', () => {
  it('fails fast before emitting SSE data payload with top-level internal metadata controls', async () => {
    const response = await requestSse({ id: 'evt-1', metadata: { routeHint: 'tools' } });

    expect(response.status).toBe(200);
    expect(response.text).toContain('event: error');
    expect(response.text).toContain('sse_stream_error');
    expect(response.text).not.toContain('"metadata"');
  });

  it('fails fast before emitting SSE data payload with nested __rt', async () => {
    const response = await requestSse({ id: 'evt-2', choices: [{ message: { __rt: { internal: true } } }] });

    expect(response.status).toBe(200);
    expect(response.text).toContain('event: error');
    expect(response.text).toContain('sse_stream_error');
    expect(response.text).not.toContain('__rt');
  });

  it('passes clean SSE data payload', async () => {
    const response = await requestSse({ id: 'evt-3', choices: [{ message: { role: 'assistant', content: 'hi' } }] });

    expect(response.status).toBe(200);
    expect(response.text).toContain('"content":"hi"');
    expect(response.text).not.toContain('sse_stream_error');
  });

  it('normalizes chat completion SSE tail metadata without changing tool_call semantics', async () => {
    const response = await requestSse(
      {},
      {
        entryEndpoint: '/v1/chat/completions',
        delayChunks: true,
        chunks: [
          `data: ${JSON.stringify({
            id: 'chatcmpl_tool_tail_stable',
            object: 'chat.completion.chunk',
            created: 1782386212,
            model: 'MiniMax-M3',
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call_tail_1',
                  type: 'function',
                  function: { name: 'search_content', arguments: '' }
                }]
              },
              finish_reason: null
            }]
          })}\n\n`,
          `data: ${JSON.stringify({
            id: 'chatcmpl_tool_tail_stable',
            object: 'chat.completion.chunk',
            created: 1782386212,
            model: 'MiniMax-M3',
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }
          })}\n\n`,
          `data: ${JSON.stringify({
            id: '',
            object: '',
            created: 0,
            model: 'MiniMax-M3',
            choices: [],
            usage: null
          })}\n\n`,
          `data: ${JSON.stringify({
            id: '',
            object: 'chat.completion.chunk',
            created: 0,
            model: '',
            choices: [],
            usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }
          })}\n\n`,
          'data: [DONE]\n\n',
        ]
      }
    );

    expect(response.status).toBe(200);
    expect(response.text).toContain('"finish_reason":"tool_calls"');
    expect(response.text).toContain('"name":"search_content"');
    expect(response.text).not.toContain('"id":""');
    expect(response.text).not.toContain('"object":""');
    expect(response.text).not.toContain('"created":0');
    expect(response.text).toContain('"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}');
    expect(response.text).toContain('data: [DONE]');
    expect(response.text).not.toContain('sse_stream_error');
  });

  it('RED: direct chat completion tool_calls stream restores client model while preserving tool_call semantics', async () => {
    const response = await requestSse(
      {},
      {
        continuationOwner: 'direct',
        entryEndpoint: '/v1/chat/completions',
        metadata: {
          clientModelId: 'gpt-5.4',
          originalModelId: 'gpt-5.4',
        },
        delayChunks: true,
        chunks: [
          `data: ${JSON.stringify({
            id: 'chatcmpl_direct_restore_1',
            object: 'chat.completion.chunk',
            created: 1782386212,
            model: 'MiniMax-M3',
            choices: [{
              index: 0,
              delta: { role: 'assistant' },
              finish_reason: null
            }]
          })}\n\n`,
          `data: ${JSON.stringify({
            id: 'chatcmpl_direct_restore_1',
            object: 'chat.completion.chunk',
            created: 1782386212,
            model: 'MiniMax-M3',
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call_direct_restore_1',
                  type: 'function',
                  function: { name: 'read_file', arguments: '' }
                }]
              },
              finish_reason: null
            }]
          })}\n\n`,
          `data: ${JSON.stringify({
            id: 'chatcmpl_direct_restore_1',
            object: 'chat.completion.chunk',
            created: 1782386212,
            model: 'MiniMax-M3',
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: 0,
                  function: {
                    arguments: '{"path":"src/main.rs"}'
                  }
                }]
              },
              finish_reason: null
            }]
          })}\n\n`,
          `data: ${JSON.stringify({
            id: 'chatcmpl_direct_restore_1',
            object: 'chat.completion.chunk',
            created: 1782386212,
            model: 'MiniMax-M3',
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
          })}\n\n`,
          'data: [DONE]\n\n',
        ]
      }
    );

    expect(response.status).toBe(200);
    expect(response.text).toContain('"model":"gpt-5.4"');
    expect(response.text).not.toContain('"model":"MiniMax-M3"');
    expect(response.text).toContain('"name":"read_file"');
    expect(response.text).toContain('"finish_reason":"tool_calls"');
    expect(response.text).toContain('"arguments":"{\\"path\\":\\"src/main.rs\\"}"');
    expect(response.text).toContain('data: [DONE]');
    expect(response.text).not.toContain('sse_stream_error');
  });

  it('restores direct chat completion client model from metadata center after metadata copy', async () => {
    const metadataCarrier: Record<string, unknown> = {};
    MetadataCenter.attach(metadataCarrier).writeProviderObservation(
      'clientModelId',
      'gpt-5.5',
      {
        module: 'tests/server/handlers/handler-response-sse-frame-metadata-guard.spec.ts',
        symbol: 'metadata-center-direct-chat-model-restore',
        stage: 'HubRespOutbound04ClientSemantic',
      },
      'test: client model restore should survive metadata projection copy'
    );

    const response = await requestSse(
      {},
      {
        continuationOwner: 'direct',
        entryEndpoint: '/v1/chat/completions',
        metadata: metadataCarrier,
        delayChunks: true,
        chunks: [
          `data: ${JSON.stringify({
            id: 'chatcmpl_direct_center_restore',
            object: 'chat.completion.chunk',
            created: 1782386212,
            model: 'glm-5.2',
            choices: [{
              index: 0,
              delta: { content: 'hello' },
              finish_reason: null
            }]
          })}\n\n`,
          `data: ${JSON.stringify({
            id: 'chatcmpl_direct_center_restore',
            object: 'chat.completion.chunk',
            created: 1782386212,
            model: 'glm-5.2',
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
          })}\n\n`,
          'data: [DONE]\n\n',
        ]
      }
    );

    expect(response.status).toBe(200);
    expect(response.text).toContain('"model":"gpt-5.5"');
    expect(response.text).not.toContain('"model":"glm-5.2"');
    expect(response.text).toContain('"finish_reason":"tool_calls"');
    expect(response.text).not.toContain('sse_stream_error');
  });

  it('keeps ordinary provider metadata on direct passthrough SSE', async () => {
    const response = await requestSse(
      {},
      {
        continuationOwner: 'direct',
        chunks: [
          `event: response.metadata\ndata: ${JSON.stringify({
            type: 'response.metadata',
            metadata: { provider_event_id: 'evt-provider-1' }
          })}\n\n`,
          ...directResponsesTerminalFrames('resp_provider_metadata_1'),
        ]
      }
    );

    expect(response.status).toBe(200);
    expect(response.text).toContain('"metadata":{"provider_event_id":"evt-provider-1"}');
    expect(response.text).not.toContain('sse_stream_error');
  });

  it('streams CRLF direct passthrough frames with ordinary provider metadata', async () => {
    const response = await requestSse(
      {},
      {
        continuationOwner: 'direct',
        chunks: [
          `event: response.metadata\r\ndata: ${JSON.stringify({
            type: 'response.metadata',
            metadata: { provider_event_id: 'evt-provider-crlf' }
          })}\r\n\r\n`,
          ...directResponsesTerminalFrames('resp_provider_metadata_crlf', '\r\n'),
        ]
      }
    );

    expect(response.status).toBe(200);
    expect(response.text).toContain('\r\n\r\n');
    expect(response.text).toContain('"metadata":{"provider_event_id":"evt-provider-crlf"}');
    expect(response.text).not.toContain('sse_stream_error');
  });

  it('RED: strips top-level metadata from non-response.metadata direct passthrough frames before client emission', async () => {
    const response = await requestSse(
      {},
      {
        continuationOwner: 'direct',
        chunks: [
          `event: response.custom_tool_call_input.delta\ndata: ${JSON.stringify({
            type: 'response.custom_tool_call_input.delta',
            delta: 'abc',
            metadata: { provider_event_id: 'evt-provider-nonstandard' }
          })}\n\n`,
          ...directResponsesTerminalFrames('resp_custom_tool_input_delta_1'),
        ]
      }
    );

    expect(response.status).toBe(200);
    expect(response.text).toContain('response.custom_tool_call_input.delta');
    expect(response.text).toContain('"delta":"abc"');
    expect(response.text).not.toContain('"metadata"');
    expect(response.text).not.toContain('sse_stream_error');
  });

  it('fails direct passthrough split SSE frame before leaking internal metadata controls', async () => {
    const frame = `event: response.metadata\ndata: ${JSON.stringify({
      type: 'response.metadata',
      metadata: { routeHint: 'tools' }
    })}\n\n`;
    const response = await requestSse(
      {},
      {
        continuationOwner: 'direct',
        chunks: [frame.slice(0, 18), frame.slice(18)]
      }
    );

    expect(response.status).toBe(200);
    expect(response.text).toContain('event: error');
    expect(response.text).toContain('sse_stream_error');
    expect(response.text).not.toContain('routeHint');
  });

  it('rejects wrapper response.metadata without standard response event semantics', async () => {
    const response = await requestSse({
      response: {
        id: 'resp_wrapper_meta_1',
        metadata: { provider_event_id: 'wrapper-metadata-must-not-pass' }
      }
    });

    expect(response.status).toBe(200);
    expect(response.text).toContain('event: error');
    expect(response.text).toContain('sse_stream_error');
    expect(response.text).not.toContain('wrapper-metadata-must-not-pass');
  });
});
