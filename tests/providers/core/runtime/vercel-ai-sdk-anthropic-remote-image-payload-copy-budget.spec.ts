import fs from 'node:fs';
import path from 'node:path';
import { inlineRemoteAnthropicImageUrls } from '../../../../src/providers/core/runtime/vercel-ai-sdk/anthropic-sdk-transport.js';

const pngBytes = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d
]);

const fetchPng = (async () => new Response(pngBytes, {
  status: 200,
  headers: { 'content-type': 'image/png' }
})) as typeof fetch;

describe('Anthropic remote image payload copy budget', () => {
  it('rejects eager full-body clone implementations', () => {
    const source = fs.readFileSync(
      path.join(
        process.cwd(),
        'src/providers/core/runtime/vercel-ai-sdk/anthropic-sdk-remote-image.ts'
      ),
      'utf8'
    );

    expect(source).not.toContain('deepCloneRecord');
    expect(source).not.toContain('structuredClone(');
    expect(source).not.toMatch(/JSON\.parse\(JSON\.stringify\(/);
  });

  it('copies only rewritten image ancestors and preserves all unaffected references', async () => {
    const textBlock = { type: 'text', text: 'keep' };
    const remoteSource = { type: 'url', url: 'https://example.com/image.png', vendor: { keep: true } };
    const imageBlock = { type: 'image', source: remoteSource, cache_control: { type: 'ephemeral' } };
    const rewrittenMessage = { role: 'user', content: [textBlock, imageBlock] };
    const untouchedMessage = { role: 'assistant', content: [{ type: 'text', text: 'unchanged' }] };
    const messages = [rewrittenMessage, untouchedMessage];
    const tools = [{ name: 'large_tool', input_schema: { type: 'object' } }];
    const metadata = { protocol: { keep: true } };
    const extension = { nested: ['same-reference'] };
    const input = {
      model: 'kimi-k2.5',
      messages,
      tools,
      metadata,
      extension
    };
    const before = JSON.stringify(input);

    const { body, rewrites } = await inlineRemoteAnthropicImageUrls(input, { fetchImpl: fetchPng });

    expect(rewrites).toBe(1);
    expect(body).not.toBe(input);
    expect(body.messages).not.toBe(messages);
    expect(body.tools).toBe(tools);
    expect(body.metadata).toBe(metadata);
    expect(body.extension).toBe(extension);

    const outputMessages = body.messages as Array<Record<string, unknown>>;
    expect(outputMessages[0]).not.toBe(rewrittenMessage);
    expect(outputMessages[1]).toBe(untouchedMessage);

    const outputContent = outputMessages[0]?.content as Array<Record<string, unknown>>;
    expect(outputContent).not.toBe(rewrittenMessage.content);
    expect(outputContent[0]).toBe(textBlock);
    expect(outputContent[1]).not.toBe(imageBlock);

    const outputSource = outputContent[1]?.source as Record<string, unknown>;
    expect(outputSource).not.toBe(remoteSource);
    expect(outputSource).toMatchObject({
      type: 'base64',
      media_type: 'image/png',
      vendor: remoteSource.vendor
    });
    expect(outputSource.vendor).toBe(remoteSource.vendor);
    expect(typeof outputSource.data).toBe('string');
    expect(outputSource.url).toBeUndefined();
    expect(JSON.stringify(input)).toBe(before);
    expect(remoteSource).toEqual({
      type: 'url',
      url: 'https://example.com/image.png',
      vendor: { keep: true }
    });
  });

  it('returns the original body when no remote image rewrite is required', async () => {
    const input = {
      model: 'claude-test',
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }]
        }
      ]
    };

    const result = await inlineRemoteAnthropicImageUrls(input, { fetchImpl: fetchPng });

    expect(result).toEqual({ body: input, rewrites: 0 });
    expect(result.body).toBe(input);
  });

  it('does not partially mutate caller state when a later image fetch fails', async () => {
    const firstSource = { type: 'url', url: 'https://example.com/first.png' };
    const secondSource = { type: 'url', url: 'https://example.com/second.png' };
    const input = {
      model: 'kimi-k2.5',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: firstSource },
            { type: 'image', source: secondSource }
          ]
        }
      ]
    };
    const before = JSON.stringify(input);
    let fetchCount = 0;
    const fetchFirstThenFail = (async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return new Response(pngBytes, {
          status: 200,
          headers: { 'content-type': 'image/png' }
        });
      }
      throw new TypeError('second fetch failed');
    }) as typeof fetch;

    await expect(
      inlineRemoteAnthropicImageUrls(input, { fetchImpl: fetchFirstThenFail })
    ).rejects.toMatchObject({
      code: 'REMOTE_IMAGE_FETCH_NETWORK_ERROR',
      statusCode: 502
    });

    expect(JSON.stringify(input)).toBe(before);
    expect(firstSource).toEqual({ type: 'url', url: 'https://example.com/first.png' });
    expect(secondSource).toEqual({ type: 'url', url: 'https://example.com/second.png' });
  });
});
