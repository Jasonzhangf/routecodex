import { PassThrough } from 'node:stream';
import { describe, expect, it } from '@jest/globals';
import { attachResponsesStreamSemanticsForHttp } from '../../../../src/modules/llmswitch/bridge/responses-stream-semantics.js';

async function collectWrappedStreamOutput(args: {
  chunks: string[];
  endStream?: boolean;
  timeoutMs?: number;
}): Promise<string> {
  const upstream = new PassThrough();
  const wrapped = attachResponsesStreamSemanticsForHttp({
    stream: upstream,
    entryEndpoint: '/v1/responses',
    requestLabel: 'req_stream_semantics_spec',
  });
  let output = '';
  wrapped.on('data', (chunk) => {
    output += String(chunk);
  });
  const endPromise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`wrapped stream did not end within ${args.timeoutMs ?? 1000}ms`));
    }, args.timeoutMs ?? 1000);
    wrapped.on('end', () => {
      clearTimeout(timer);
      resolve();
    });
    wrapped.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  for (const chunk of args.chunks) {
    upstream.write(chunk);
  }
  if (args.endStream !== false) {
    upstream.end();
  }
  await endPromise;
  return output;
}

describe('responses stream semantics wrapper', () => {
  it('projects upstream_stream_incomplete when stream closes before response.completed', async () => {
    const output = await collectWrappedStreamOutput({
      chunks: [
        'event: response.created\n'
        + 'data: {"type":"response.created","response":{"id":"resp_stream_closed_1","object":"response","status":"in_progress","output":[]}}\n\n',
        'event: response.output_text.delta\n'
        + 'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
      ],
    });

    expect(output).toContain('event: error');
    expect(output).toContain('"code":"upstream_stream_incomplete"');
    expect(output).toContain('stream closed before response.completed');
    expect(output).not.toContain('event: response.completed');
  });

  it('auto-closes assistant output_item.done by appending response.completed and response.done', async () => {
    const output = await collectWrappedStreamOutput({
      chunks: [
        'event: response.created\n'
        + 'data: {"type":"response.created","response":{"id":"resp_terminal_only_message","object":"response","status":"in_progress","output":[{"id":"msg_terminal_only_message","type":"message","role":"assistant","status":"in_progress","content":[{"type":"output_text","text":"partial"}]}]}}\n\n',
        'event: response.output_item.done\n'
        + 'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_terminal_only_message","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"done"}]}}\n\n',
      ],
      endStream: false,
    });

    expect(output).toContain('event: response.output_item.done');
    expect(output).toContain('event: response.completed');
    expect(output).toContain('event: response.done');
    expect(output).toContain('"id":"resp_terminal_only_message"');
    expect(output).not.toContain('upstream_stream_incomplete');
  });
});
