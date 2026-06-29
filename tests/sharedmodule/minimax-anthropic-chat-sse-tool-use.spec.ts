import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import { MetadataCenter } from '../../src/server/runtime/http-server/metadata-center/metadata-center.js';
import { convertProviderResponse } from '../../sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.js';

async function readStreamBody(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

const TEST_METADATA_WRITER = {
  module: 'tests/sharedmodule/minimax-anthropic-chat-sse-tool-use.spec.ts',
  symbol: 'bindMetadataCenter',
  stage: 'test_runtime_control_provider_protocol'
} as const;

describe('MiniMax Anthropic SSE tool_use chat projection', () => {
  it('projects captured 10000 Anthropic tool_use SSE to OpenAI chat SSE without generation_error', async () => {
    const samplePath = `${process.env.HOME}/.rcc/codex-samples/openai-chat/ports/10000/req_1782733503705_5aba9660/provider-response_3.json`;
    const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8')) as Record<string, any>;
    expect(sample?.meta?.providerKey).toBe('minimax.key1.MiniMax-M3');
    expect(sample?.body?.mode).toBe('sse');
    expect(typeof sample?.body?.bodyText).toBe('string');

    const context: Record<string, unknown> = {
      requestId: 'req_minimax_anthropic_tool_use_chat_sse',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'anthropic-messages'
    };
    const center = MetadataCenter.attach(context);
    center.writeRequestTruth('requestId', context.requestId, TEST_METADATA_WRITER, 'test-request-truth');
    center.writeRequestTruth('entryEndpoint', context.entryEndpoint, TEST_METADATA_WRITER, 'test-request-truth');
    center.writeRuntimeControl('providerProtocol', 'anthropic-messages', TEST_METADATA_WRITER, 'test-provider-protocol');

    const converted = await convertProviderResponse({
      providerProtocol: 'anthropic-messages',
      providerResponse: sample.body,
      context: context as any,
      entryEndpoint: '/v1/chat/completions',
      wantsStream: true
    });

    expect(converted.body?.object).toBe('chat.completion');
    expect(converted.body?.created).toEqual(expect.any(Number));
    expect(JSON.stringify(converted.body)).toContain('tool_calls');
    expect(converted.sseStream).toBeDefined();

    const sseBody = await readStreamBody(converted.sseStream!);
    expect(sseBody).toContain('data:');
    expect(sseBody).toContain('tool_calls');
    expect(sseBody).toContain('"created":');
    expect(sseBody).toContain('[DONE]');
    expect(sseBody).not.toContain('generation_error');
    expect(sseBody).not.toContain('missing created timestamp');
  });
});
