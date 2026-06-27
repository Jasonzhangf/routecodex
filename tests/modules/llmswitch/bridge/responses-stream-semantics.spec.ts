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

  it('treats response.completed as terminal without requiring response.done', async () => {
    const output = await collectWrappedStreamOutput({
      chunks: [
        'event: response.completed\n'
        + 'data: {"type":"response.completed","response":{"id":"resp_completed_only","object":"response","status":"completed","model":"gpt-5.4-mini","output":[{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"ok"}]}]}}\n\n'
      ],
    });

    expect(output).toContain('event: response.completed');
    expect(output).not.toContain('stream closed before response.completed');
    expect(output).not.toContain('event: error');
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

  it('projects upstream_stream_incomplete when stream ends without any response terminal', async () => {
    const output = await collectWrappedStreamOutput({
      chunks: [
        ': keepalive\n\n',
        'event: response.output_text.delta\n'
        + 'data: {"type":"response.output_text.delta","delta":"partial"}\n\n'
      ],
    });

    expect(output).toContain('event: error');
    expect(output).toContain('"code":"upstream_stream_incomplete"');
    expect(output).toContain('stream closed before response.completed');
  });

  it('does not emit write-after-end when upstream writes after assistant auto-close', async () => {
    const upstream = new PassThrough();
    const wrapped = attachResponsesStreamSemanticsForHttp({
      stream: upstream,
      entryEndpoint: '/v1/responses',
      requestLabel: 'req_stream_semantics_late_write',
    });
    let output = '';
    let uncaught: Error | undefined;
    const onUncaught = (error: Error) => {
      uncaught = error;
    };
    process.prependOnceListener('uncaughtException', onUncaught);
    try {
      const ended = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('wrapped stream did not end after assistant auto-close')), 1000);
        wrapped.on('data', (chunk) => {
          output += String(chunk);
        });
        wrapped.on('end', () => {
          clearTimeout(timer);
          resolve();
        });
        wrapped.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      upstream.write(
        'event: response.created\n'
        + 'data: {"type":"response.created","response":{"id":"resp_terminal_late_write","object":"response","status":"in_progress","output":[{"id":"msg_terminal_late_write","type":"message","role":"assistant","status":"in_progress","content":[{"type":"output_text","text":"partial"}]}]}}\n\n'
      );
      upstream.write(
        'event: response.output_item.done\n'
        + 'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_terminal_late_write","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"done"}]}}\n\n'
      );
      await ended;
      upstream.write(
        'event: response.output_text.delta\n'
        + 'data: {"type":"response.output_text.delta","delta":"late"}\n\n'
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(output).toContain('event: response.completed');
      expect(output).toContain('event: response.done');
      expect(uncaught?.message ?? '').not.toContain('write after end');
    } finally {
      process.removeListener('uncaughtException', onUncaught);
      upstream.destroy();
    }
  });

  it('does not auto-close assistant message when later tool-call frames still arrive', async () => {
    const upstream = new PassThrough();
    const wrapped = attachResponsesStreamSemanticsForHttp({
      stream: upstream,
      entryEndpoint: '/v1/responses',
      requestLabel: 'req_stream_semantics_late_tool_call',
    });
    let output = '';
    const ended = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('wrapped stream did not end for late tool-call followup')), 1000);
      wrapped.on('data', (chunk) => {
        output += String(chunk);
      });
      wrapped.on('end', () => {
        clearTimeout(timer);
        resolve();
      });
      wrapped.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    upstream.write(
      'event: response.created\n'
      + 'data: {"type":"response.created","response":{"id":"resp_late_tool_call","object":"response","status":"in_progress","output":[{"id":"msg_late_tool_call","type":"message","role":"assistant","status":"in_progress","content":[{"type":"output_text","text":"partial"}]}]}}\n\n'
    );
    upstream.write(
      'event: response.output_item.done\n'
      + 'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_late_tool_call","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"done"}]}}\n\n'
    );
    upstream.write(
      'event: response.output_item.added\n'
      + 'data: {"type":"response.output_item.added","output_index":1,"item":{"id":"fc_late_tool_call","type":"function_call","call_id":"call_late_tool_call","name":"exec_command","arguments":""}}\n\n'
    );
    upstream.write(
      'event: response.function_call_arguments.done\n'
      + 'data: {"type":"response.function_call_arguments.done","output_index":1,"item_id":"fc_late_tool_call","arguments":"{\\"cmd\\":\\"echo hi\\"}"}\n\n'
    );
    upstream.write(
      'event: response.output_item.done\n'
      + 'data: {"type":"response.output_item.done","output_index":1,"item":{"id":"fc_late_tool_call","type":"function_call","call_id":"call_late_tool_call","name":"exec_command","arguments":"{\\"cmd\\":\\"echo hi\\"}","status":"completed"}}\n\n'
    );
    upstream.write(
      'event: response.completed\n'
      + 'data: {"type":"response.completed","response":{"id":"resp_late_tool_call","object":"response","status":"completed","output":[{"id":"msg_late_tool_call","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"done"}]},{"id":"fc_late_tool_call","type":"function_call","call_id":"call_late_tool_call","name":"exec_command","arguments":"{\\"cmd\\":\\"echo hi\\"}","status":"completed"}]}}\n\n'
    );
    upstream.write(
      'event: response.done\n'
      + 'data: {"type":"response.done","response":{"id":"resp_late_tool_call","object":"response","status":"completed","output":[{"id":"msg_late_tool_call","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"done"}]},{"id":"fc_late_tool_call","type":"function_call","call_id":"call_late_tool_call","name":"exec_command","arguments":"{\\"cmd\\":\\"echo hi\\"}","status":"completed"}]}}\n\n'
    );
    upstream.end();

    await ended;

    expect(output).toContain('event: response.function_call_arguments.done');
    expect(output).toContain('"call_id":"call_late_tool_call"');
    expect(output).toContain('event: response.completed');
    expect(output).toContain('event: response.done');
    expect(output.indexOf('event: response.function_call_arguments.done')).toBeGreaterThan(
      output.indexOf('event: response.output_item.done')
    );
    expect(output.indexOf('event: response.completed')).toBeGreaterThan(
      output.indexOf('event: response.function_call_arguments.done')
    );
  });
});
