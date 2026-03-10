#!/usr/bin/env node
/**
 * Ensure Antigravity Claude-thinking outbound shape is unified across entry protocols.
 *
 * 目标：无论入口是 /v1/responses 还是 /v1/messages，映射到 gemini-chat 时
 * Antigravity Claude-thinking 的 contents 序列（role + 文本）保持一致。
 * 不在这里做“只保留最新 user”之类的非标裁剪，保持协议转换层的纯粹性。
 */

import { GeminiSemanticMapper } from '../../dist/conversion/hub/semantic-mappers/gemini-mapper.js';

async function buildPayloadFromChat(chat, adapterContext) {
  const mapper = new GeminiSemanticMapper();
  const envelope = await mapper.fromChat(chat, adapterContext);
  return envelope.payload;
}

function buildBaseChatEnvelope() {
  return {
    messages: [],
    tools: undefined,
    toolOutputs: undefined,
    parameters: {
      model: 'claude-sonnet-4-5-thinking'
    },
    metadata: {
      systemInstructions: [],
      // adapterContext snapshot used by GeminiSemanticMapper.buildGeminiRequestFromChat
      context: {
        requestId: 'req_matrix_antigravity_claude_thinking',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'gemini-chat',
        providerId: 'antigravity.geetasamodgeetasamoda.claude-sonnet-4-5-thinking',
        profileId: 'antigravity.geetasamodgeetasamoda.claude-sonnet-4-5-thinking',
        routeId: 'thinking',
        streamingHint: 'auto',
        toolCallIdStyle: 'fc'
      }
    }
  };
}

function buildAdapterContextFromMetadata(meta) {
  const ctxMeta = meta && meta.context ? meta.context : {};
  return {
    requestId: ctxMeta.requestId || 'req_matrix_antigravity_claude_thinking',
    entryEndpoint: ctxMeta.entryEndpoint || '/v1/responses',
    providerProtocol: ctxMeta.providerProtocol || 'gemini-chat',
    providerId: ctxMeta.providerId || 'antigravity.geetasamodgeetasamoda.claude-sonnet-4-5-thinking',
    routeId: ctxMeta.routeId || 'thinking',
    profileId: ctxMeta.profileId || 'antigravity.geetasamodgeetasamoda.claude-sonnet-4-5-thinking',
    streamingHint: ctxMeta.streamingHint || 'auto',
    toolCallIdStyle: ctxMeta.toolCallIdStyle || 'fc'
  };
}

function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg);
  }
}

function normalizeContents(payload) {
  const contents = Array.isArray(payload.contents) ? payload.contents : [];
  return contents.map((entry) => {
    const role = String(entry.role || '').toLowerCase();
    const parts = Array.isArray(entry.parts) ? entry.parts : [];
    const texts = parts
      .map((part) => {
        if (!part || typeof part !== 'object') return '';
        const text = part.text;
        return typeof text === 'string' ? text : '';
      })
      .filter((v) => v && v.trim().length > 0);
    return {
      role,
      text: texts.join('\n')
    };
  });
}

async function main() {
  // 模拟一条带有历史 model 片段的对话：user + model（例如 Anthropic 错误日志中的「{」）
  const chatFromAnthropic = buildBaseChatEnvelope();
  chatFromAnthropic.messages = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: '列出本地文件'
        }
      ]
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: '{'
        }
      ]
    }
  ];
  chatFromAnthropic.metadata.context.entryEndpoint = '/v1/messages';

  const adapterCtxAnthropic = buildAdapterContextFromMetadata(chatFromAnthropic.metadata);
  const payloadFromAnthropic = await buildPayloadFromChat(chatFromAnthropic, adapterCtxAnthropic);

  const normAnthropic = normalizeContents(payloadFromAnthropic);

  // 再模拟 Responses 入口下的等价对话（仅 user），验证形状一致。
  const chatFromResponses = buildBaseChatEnvelope();
  // 使用与 Anthropic 入口相同的消息序列，只改变 entryEndpoint，
  // 验证转换层不会因为入口协议不同而改变 contents 形状。
  chatFromResponses.messages = JSON.parse(JSON.stringify(chatFromAnthropic.messages));
  chatFromResponses.metadata.context.entryEndpoint = '/v1/responses';

  const adapterCtxResponses = buildAdapterContextFromMetadata(chatFromResponses.metadata);
  const payloadFromResponses = await buildPayloadFromChat(chatFromResponses, adapterCtxResponses);

  const normResponses = normalizeContents(payloadFromResponses);

  // 期望：两条路径在 Claude-thinking 下的 contents 序列一致（长度相同，role/text 对应相同）。
  assert(
    normAnthropic.length === normResponses.length,
    `expected same contents length, anthropic=${normAnthropic.length}, responses=${normResponses.length}`
  );
  for (let i = 0; i < normAnthropic.length; i += 1) {
    const a = normAnthropic[i];
    const b = normResponses[i];
    assert(
      a.role === b.role,
      `mismatch at index ${i}: role anthropic=${a.role}, responses=${b.role}`
    );
    assert(
      a.text === b.text,
      `mismatch at index ${i}: text anthropic="${a.text}", responses="${b.text}"`
    );
  }

  console.log('✅ antigravity Claude-thinking outbound shape unified (Anthropic vs Responses)');
}

main().catch((err) => {
  console.error('❌ antigravity Claude-thinking shape check failed:', err && err.message ? err.message : err);
  process.exit(1);
});
