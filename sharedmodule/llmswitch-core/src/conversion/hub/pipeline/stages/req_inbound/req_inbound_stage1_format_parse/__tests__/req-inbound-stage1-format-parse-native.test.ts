import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { runReqInboundStage1FormatParse } from '../index.js';

describe('req-inbound-stage1-format-parse native wrapper', () => {
  afterEach(() => {
    delete process.env.ROUTECODEX_STAGE_TIMING;
    delete process.env.ROUTECODEX_HUB_STAGE_TIMING_DETAIL;
    delete process.env.ROUTECODEX_STAGE_TIMING_MIN_MS;
    jest.restoreAllMocks();
  });

  it('normalizes non-canonical chat reasoning before native format parse', async () => {
    const envelope = await runReqInboundStage1FormatParse({
      rawRequest: {
        model: 'gpt-test',
        messages: [
          {
            role: 'assistant',
            content: '<think>internal</think> visible answer'
          }
        ]
      } as any,
      adapterContext: {
        requestId: 'req-inbound-stage1-reasoning',
        providerProtocol: 'openai-chat'
      } as any,
    });

    expect(envelope.format).toBe('openai-chat');
    expect((envelope.payload as any).messages?.[0]?.content).toBe('visible answer');
  });

  it('uses the fast path when inbound payload has no reasoning markup', async () => {
    process.env.ROUTECODEX_STAGE_TIMING = '1';
    process.env.ROUTECODEX_HUB_STAGE_TIMING_DETAIL = '1';
    process.env.ROUTECODEX_STAGE_TIMING_MIN_MS = '0';
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await runReqInboundStage1FormatParse({
      rawRequest: {
        model: 'gpt-test',
        messages: [
          {
            role: 'user',
            content: 'plain user request'
          }
        ]
      } as any,
      adapterContext: {
        requestId: 'req-inbound-stage1-fast-path',
        providerProtocol: 'openai-chat'
      } as any,
    });

    const rendered = logSpy.mock.calls
      .map((call) => String(call?.[0] ?? ''))
      .find((line) => line.includes('req_inbound.stage1_reasoning_normalize.completed'));
    expect(rendered).toContain('"strategy":"fast_path"');
  });

  it('ignores historical responses reasoning markup when the latest item is plain text', async () => {
    process.env.ROUTECODEX_STAGE_TIMING = '1';
    process.env.ROUTECODEX_HUB_STAGE_TIMING_DETAIL = '1';
    process.env.ROUTECODEX_STAGE_TIMING_MIN_MS = '0';
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await runReqInboundStage1FormatParse({
      rawRequest: {
        model: 'gpt-test',
        input: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: '<think>old internal</think> old visible'
              }
            ]
          },
          {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: 'latest plain user request'
              }
            ]
          }
        ]
      } as any,
      adapterContext: {
        requestId: 'req-inbound-stage1-responses-history-fast-path',
        providerProtocol: 'openai-responses'
      } as any,
    });

    const rendered = logSpy.mock.calls
      .map((call) => String(call?.[0] ?? ''))
      .find((line) => line.includes('req_inbound.stage1_reasoning_normalize.completed'));
    expect(rendered).toContain('"strategy":"fast_path"');
  });

  it('normalizes only the latest responses item that carries reasoning markup', async () => {
    process.env.ROUTECODEX_STAGE_TIMING = '1';
    process.env.ROUTECODEX_HUB_STAGE_TIMING_DETAIL = '1';
    process.env.ROUTECODEX_STAGE_TIMING_MIN_MS = '0';
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    const envelope = await runReqInboundStage1FormatParse({
      rawRequest: {
        model: 'gpt-test',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: 'older plain user request'
              }
            ]
          },
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: '<think>latest internal</think> latest visible'
              }
            ]
          }
        ]
      } as any,
      adapterContext: {
        requestId: 'req-inbound-stage1-responses-latest-native',
        providerProtocol: 'openai-responses'
      } as any,
    });

    expect(envelope.format).toBe('openai-responses');
    const rendered = logSpy.mock.calls
      .map((call) => String(call?.[0] ?? ''))
      .find((line) => line.includes('req_inbound.stage1_reasoning_normalize.completed'));
    expect(rendered).toContain('"strategy":"native"');
    expect(rendered).toContain('"target":"input[1]"');
  });
});
