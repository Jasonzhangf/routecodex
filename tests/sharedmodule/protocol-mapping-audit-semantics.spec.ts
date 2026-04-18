import { describe, expect, it } from '@jest/globals';

import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import { ResponsesSemanticMapper } from '../../sharedmodule/llmswitch-core/src/conversion/hub/semantic-mappers/responses-mapper.js';
import { AnthropicSemanticMapper } from '../../sharedmodule/llmswitch-core/src/conversion/hub/semantic-mappers/anthropic-mapper.js';
import { GeminiSemanticMapper } from '../../sharedmodule/llmswitch-core/src/conversion/hub/semantic-mappers/gemini-mapper.js';
import {
  DISABLE_LEGACY_PROTOCOL_MAPPING_AUDIT_MIRROR_ENV,
  readLegacyProtocolMappingAuditBucket,
  readProtocolMappingAudit,
  readProtocolMappingAuditBucket
} from '../../sharedmodule/llmswitch-core/src/conversion/hub/operation-table/semantic-mappers/protocol-mapping-audit.js';

function createResponsesContext(requestId: string): AdapterContext {
  return {
    requestId,
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-responses'
  };
}

function findAuditEntry(
  chat: any,
  bucket: 'preserved' | 'dropped' | 'lossy' | 'unsupported',
  field: string,
  targetProtocol: string
) {
  const canonical = readProtocolMappingAuditBucket(chat, bucket);
  const legacy = readLegacyProtocolMappingAuditBucket(chat, bucket);
  const matcher = (entry: any) =>
    entry?.field === field &&
    entry?.targetProtocol === targetProtocol;
  return {
    canonical: canonical.find(matcher),
    legacy: legacy.find(matcher)
  };
}

describe('protocol mapping audit semantics canonicalization', () => {
  it('mirrors anthropic dropped/lossy audit into semantics.audit.protocolMapping', async () => {
    const responsesMapper = new ResponsesSemanticMapper();
    const anthropicMapper = new AnthropicSemanticMapper();
    const chat = await responsesMapper.toChat(
      {
        protocol: 'openai-responses',
        direction: 'request',
        payload: {
          model: 'claude-sonnet-4-5',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
          prompt_cache_key: 'cache-key-901',
          reasoning: { effort: 'medium' }
        }
      } as any,
      createResponsesContext('req-audit-canonical-anthropic')
    );

    await anthropicMapper.fromChat(chat, {
      requestId: 'req-audit-canonical-anthropic-out',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages'
    } as AdapterContext);

    const dropped = findAuditEntry(chat, 'dropped', 'prompt_cache_key', 'anthropic-messages');
    expect(dropped.canonical).toMatchObject({
      field: 'prompt_cache_key',
      disposition: 'dropped',
      sourceProtocol: 'openai-responses',
      targetProtocol: 'anthropic-messages',
      reason: 'unsupported_semantics_no_equivalent'
    });
    expect(dropped.legacy).toMatchObject({
      field: 'prompt_cache_key',
      targetProtocol: 'anthropic-messages',
      reason: 'unsupported_semantics_no_equivalent'
    });

    const lossy = findAuditEntry(chat, 'lossy', 'reasoning', 'anthropic-messages');
    expect(lossy.canonical).toMatchObject({
      field: 'reasoning',
      disposition: 'lossy',
      sourceProtocol: 'openai-responses',
      targetProtocol: 'anthropic-messages'
    });
  });

  it('mirrors anthropic preserved/unsupported audit into semantics.audit.protocolMapping', async () => {
    const responsesMapper = new ResponsesSemanticMapper();
    const anthropicMapper = new AnthropicSemanticMapper();
    const chat = await responsesMapper.toChat(
      {
        protocol: 'openai-responses',
        direction: 'request',
        payload: {
          model: 'claude-sonnet-4-5',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
          tool_choice: 'required',
          response_format: {
            type: 'json_schema',
            name: 'reply_schema',
            schema: {
              type: 'object',
              properties: { answer: { type: 'string' } },
              required: ['answer']
            }
          }
        }
      } as any,
      createResponsesContext('req-audit-canonical-anthropic-preserved')
    );

    await anthropicMapper.fromChat(chat, {
      requestId: 'req-audit-canonical-anthropic-preserved-out',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages'
    } as AdapterContext);

    const preserved = findAuditEntry(chat, 'preserved', 'tool_choice', 'anthropic-messages');
    expect(preserved.canonical).toMatchObject({
      field: 'tool_choice',
      disposition: 'preserved',
      sourceProtocol: 'openai-responses',
      targetProtocol: 'anthropic-messages',
      reason: 'preserved_verbatim_top_level'
    });
    expect(preserved.legacy).toMatchObject({
      field: 'tool_choice',
      targetProtocol: 'anthropic-messages',
      reason: 'preserved_verbatim_top_level'
    });

    const unsupported = findAuditEntry(chat, 'unsupported', 'response_format', 'anthropic-messages');
    expect(unsupported.canonical).toMatchObject({
      field: 'response_format',
      disposition: 'unsupported',
      sourceProtocol: 'openai-responses',
      targetProtocol: 'anthropic-messages',
      reason: 'structured_output_not_supported'
    });
    expect(unsupported.legacy).toMatchObject({
      field: 'response_format',
      targetProtocol: 'anthropic-messages',
      reason: 'structured_output_not_supported'
    });
  });

  it('mirrors gemini dropped/lossy audit into semantics.audit.protocolMapping', async () => {
    const responsesMapper = new ResponsesSemanticMapper();
    const geminiMapper = new GeminiSemanticMapper();
    const chat = await responsesMapper.toChat(
      {
        protocol: 'openai-responses',
        direction: 'request',
        payload: {
          model: 'gemini-2.5-pro',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
          prompt_cache_key: 'cache-key-902',
          reasoning: { effort: 'high' }
        }
      } as any,
      createResponsesContext('req-audit-canonical-gemini')
    );

    await geminiMapper.fromChat(chat, {
      requestId: 'req-audit-canonical-gemini-out',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'gemini-chat',
      providerId: 'gemini-cli'
    } as AdapterContext);

    const dropped = findAuditEntry(chat, 'dropped', 'prompt_cache_key', 'gemini-chat');
    expect(dropped.canonical).toMatchObject({
      field: 'prompt_cache_key',
      disposition: 'dropped',
      sourceProtocol: 'openai-responses',
      targetProtocol: 'gemini-chat',
      reason: 'unsupported_semantics_no_equivalent'
    });
    expect(dropped.legacy).toMatchObject({
      field: 'prompt_cache_key',
      targetProtocol: 'gemini-chat',
      reason: 'unsupported_semantics_no_equivalent'
    });

    const lossy = findAuditEntry(chat, 'lossy', 'reasoning', 'gemini-chat');
    expect(lossy.canonical).toMatchObject({
      field: 'reasoning',
      disposition: 'lossy',
      sourceProtocol: 'openai-responses',
      targetProtocol: 'gemini-chat'
    });
  });

  it('mirrors gemini preserved/unsupported audit into semantics.audit.protocolMapping', async () => {
    const responsesMapper = new ResponsesSemanticMapper();
    const geminiMapper = new GeminiSemanticMapper();
    const chat = await responsesMapper.toChat(
      {
        protocol: 'openai-responses',
        direction: 'request',
        payload: {
          model: 'gemini-2.5-pro',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
          tool_choice: 'required',
          response_format: {
            type: 'json_schema',
            name: 'reply_schema',
            schema: {
              type: 'object',
              properties: { answer: { type: 'string' } },
              required: ['answer']
            }
          }
        }
      } as any,
      createResponsesContext('req-audit-canonical-gemini-preserved')
    );

    await geminiMapper.fromChat(chat, {
      requestId: 'req-audit-canonical-gemini-preserved-out',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'gemini-chat',
      providerId: 'gemini-cli'
    } as AdapterContext);

    const preserved = findAuditEntry(chat, 'preserved', 'tool_choice', 'gemini-chat');
    expect(preserved.canonical).toMatchObject({
      field: 'tool_choice',
      disposition: 'preserved',
      sourceProtocol: 'openai-responses',
      targetProtocol: 'gemini-chat',
      reason: 'preserved_via_metadata_passthrough'
    });
    expect(preserved.legacy).toMatchObject({
      field: 'tool_choice',
      targetProtocol: 'gemini-chat',
      reason: 'preserved_via_metadata_passthrough'
    });

    const unsupported = findAuditEntry(chat, 'unsupported', 'response_format', 'gemini-chat');
    expect(unsupported.canonical).toMatchObject({
      field: 'response_format',
      disposition: 'unsupported',
      sourceProtocol: 'openai-responses',
      targetProtocol: 'gemini-chat',
      reason: 'structured_output_not_supported'
    });
    expect(unsupported.legacy).toMatchObject({
      field: 'response_format',
      targetProtocol: 'gemini-chat',
      reason: 'structured_output_not_supported'
    });
  });

  it('replays canonical protocolMapping when legacy metadata mirror is removed', async () => {
    const responsesMapper = new ResponsesSemanticMapper();
    const geminiMapper = new GeminiSemanticMapper();
    const chat = await responsesMapper.toChat(
      {
        protocol: 'openai-responses',
        direction: 'request',
        payload: {
          model: 'gemini-2.5-pro',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
          prompt_cache_key: 'cache-key-903',
          tool_choice: 'required',
          response_format: { type: 'json_object' },
          reasoning: { effort: 'high' }
        }
      } as any,
      createResponsesContext('req-audit-canonical-replay-without-legacy')
    );

    await geminiMapper.fromChat(chat, {
      requestId: 'req-audit-canonical-replay-without-legacy-out',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'gemini-chat',
      providerId: 'gemini-cli'
    } as AdapterContext);

    delete (chat.metadata as any).mappingAudit;

    const audit = readProtocolMappingAudit(chat as any);
    expect(audit).toBeDefined();
    expect(
      readProtocolMappingAuditBucket(chat as any, 'dropped').some(
        (entry) =>
          entry.field === 'prompt_cache_key' &&
          entry.targetProtocol === 'gemini-chat'
      )
    ).toBe(true);
    expect(
      readProtocolMappingAuditBucket(chat as any, 'preserved').some(
        (entry) =>
          entry.field === 'tool_choice' &&
          entry.targetProtocol === 'gemini-chat'
      )
    ).toBe(true);
    expect(
      readProtocolMappingAuditBucket(chat as any, 'unsupported').some(
        (entry) =>
          entry.field === 'response_format' &&
          entry.targetProtocol === 'gemini-chat'
      )
    ).toBe(true);
  });

  it('keeps canonical audit only when legacy mirror is explicitly disabled', async () => {
    const previous = process.env[DISABLE_LEGACY_PROTOCOL_MAPPING_AUDIT_MIRROR_ENV];
    process.env[DISABLE_LEGACY_PROTOCOL_MAPPING_AUDIT_MIRROR_ENV] = '1';

    try {
      const responsesMapper = new ResponsesSemanticMapper();
      const anthropicMapper = new AnthropicSemanticMapper();
      const chat = await responsesMapper.toChat(
        {
          protocol: 'openai-responses',
          direction: 'request',
          payload: {
            model: 'claude-sonnet-4-5',
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
            tool_choice: 'required',
            response_format: { type: 'json_object' },
            reasoning: { effort: 'medium' }
          }
        } as any,
        createResponsesContext('req-audit-canonical-only-anthropic')
      );

      await anthropicMapper.fromChat(chat, {
        requestId: 'req-audit-canonical-only-anthropic-out',
        entryEndpoint: '/v1/messages',
        providerProtocol: 'anthropic-messages'
      } as AdapterContext);

      expect(
        readProtocolMappingAuditBucket(chat, 'preserved').some(
          (entry) =>
            entry.field === 'tool_choice' &&
            entry.targetProtocol === 'anthropic-messages' &&
            entry.reason === 'preserved_verbatim_top_level'
        )
      ).toBe(true);
      expect(
        readProtocolMappingAuditBucket(chat, 'unsupported').some(
          (entry) =>
            entry.field === 'response_format' &&
            entry.targetProtocol === 'anthropic-messages' &&
            entry.reason === 'structured_output_not_supported'
        )
      ).toBe(true);
      expect(
        readProtocolMappingAuditBucket(chat, 'lossy').some(
          (entry) =>
            entry.field === 'reasoning' &&
            entry.targetProtocol === 'anthropic-messages'
        )
      ).toBe(true);
      expect(readProtocolMappingAudit(chat)).toBeDefined();
      expect(readLegacyProtocolMappingAuditBucket(chat, 'preserved')).toHaveLength(0);
      expect((chat.metadata as any)?.mappingAudit).toBeUndefined();
    } finally {
      if (typeof previous === 'undefined') {
        delete process.env[DISABLE_LEGACY_PROTOCOL_MAPPING_AUDIT_MIRROR_ENV];
      } else {
        process.env[DISABLE_LEGACY_PROTOCOL_MAPPING_AUDIT_MIRROR_ENV] = previous;
      }
    }
  });

  it('keeps gemini canonical audit readable when legacy mirror is explicitly disabled', async () => {
    const previous = process.env[DISABLE_LEGACY_PROTOCOL_MAPPING_AUDIT_MIRROR_ENV];
    process.env[DISABLE_LEGACY_PROTOCOL_MAPPING_AUDIT_MIRROR_ENV] = '1';

    try {
      const responsesMapper = new ResponsesSemanticMapper();
      const geminiMapper = new GeminiSemanticMapper();
      const chat = await responsesMapper.toChat(
        {
          protocol: 'openai-responses',
          direction: 'request',
          payload: {
            model: 'gemini-2.5-pro',
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
            prompt_cache_key: 'cache-key-904',
            tool_choice: 'required',
            response_format: { type: 'json_object' },
            reasoning: { effort: 'high' }
          }
        } as any,
        createResponsesContext('req-audit-canonical-only-gemini')
      );

      await geminiMapper.fromChat(chat, {
        requestId: 'req-audit-canonical-only-gemini-out',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'gemini-chat',
        providerId: 'gemini-cli'
      } as AdapterContext);

      expect(
        readProtocolMappingAuditBucket(chat, 'dropped').some(
          (entry) =>
            entry.field === 'prompt_cache_key' &&
            entry.targetProtocol === 'gemini-chat' &&
            entry.reason === 'unsupported_semantics_no_equivalent'
        )
      ).toBe(true);
      expect(
        readProtocolMappingAuditBucket(chat, 'preserved').some(
          (entry) =>
            entry.field === 'tool_choice' &&
            entry.targetProtocol === 'gemini-chat' &&
            entry.reason === 'preserved_via_metadata_passthrough'
        )
      ).toBe(true);
      expect(
        readProtocolMappingAuditBucket(chat, 'unsupported').some(
          (entry) =>
            entry.field === 'response_format' &&
            entry.targetProtocol === 'gemini-chat' &&
            entry.reason === 'structured_output_not_supported'
        )
      ).toBe(true);
      expect(readProtocolMappingAudit(chat)).toBeDefined();
      expect(readLegacyProtocolMappingAuditBucket(chat, 'dropped')).toHaveLength(0);
      expect((chat.metadata as any)?.mappingAudit).toBeUndefined();
    } finally {
      if (typeof previous === 'undefined') {
        delete process.env[DISABLE_LEGACY_PROTOCOL_MAPPING_AUDIT_MIRROR_ENV];
      } else {
        process.env[DISABLE_LEGACY_PROTOCOL_MAPPING_AUDIT_MIRROR_ENV] = previous;
      }
    }
  });
});
