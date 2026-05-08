import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from '@jest/globals';

import { AnthropicSemanticMapper } from '../../sharedmodule/llmswitch-core/src/conversion/hub/operation-table/semantic-mappers/anthropic-mapper.js';
import { ResponsesSemanticMapper } from '../../sharedmodule/llmswitch-core/src/conversion/hub/operation-table/semantic-mappers/responses-mapper.js';
import { AnthropicResponseMapper } from '../../sharedmodule/llmswitch-core/src/conversion/hub/response/response-mappers.js';
import { runRespInboundStage1SseDecode } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_inbound/resp_inbound_stage1_sse_decode/index.js';
import { runRespInboundStage2FormatParse } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_inbound/resp_inbound_stage2_format_parse/index.js';
import { runRespInboundStage3SemanticMap } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_inbound/resp_inbound_stage3_semantic_map/index.js';
import { runRespProcessStage2Finalize } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_process/resp_process_stage2_finalize/index.js';
import { runRespOutboundStage1ClientRemap } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_outbound/resp_outbound_stage1_client_remap/index.js';

const SAMPLE_ROOTS = Array.from(
  new Set(
    [
      '/Volumes/extension/.rcc/codex-samples',
      path.join(process.env.HOME || '', '.rcc', 'codex-samples')
    ].filter((entry) => typeof entry === 'string' && entry.trim().length > 0 && fs.existsSync(entry))
  )
);

function listSampleDirs(protocol: string, providerKey: string): string[] {
  const dirs: string[] = [];
  for (const root of SAMPLE_ROOTS) {
    const providerDir = path.join(root, protocol, providerKey);
    if (!fs.existsSync(providerDir) || !fs.statSync(providerDir).isDirectory()) {
      continue;
    }
    for (const name of fs.readdirSync(providerDir)) {
      const dir = path.join(providerDir, name);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        continue;
      }
      dirs.push(dir);
    }
  }
  return Array.from(new Set(dirs)).sort().reverse();
}

function pickLatestSampleDir(options: {
  protocol: string;
  providerKeys: string[];
  requireResponse?: boolean;
  nameIncludes?: string;
}): string | undefined {
  const { protocol, providerKeys, requireResponse = false, nameIncludes } = options;
  for (const providerKey of providerKeys) {
    const dir = listSampleDirs(protocol, providerKey).find((entry) => {
      if (nameIncludes && !path.basename(entry).includes(nameIncludes)) {
        return false;
      }
      return requireResponse ? hasRequestAndResponseSamples(entry) : hasRequestSample(entry);
    });
    if (dir) {
      return dir;
    }
  }
  return undefined;
}

function buildDiscoveredCases(options: {
  protocol: string;
  providerKeys: string[];
  requireResponse?: boolean;
  limitPerProvider?: number;
}): Array<{ label: string; requestDir: string; hasResponse?: boolean }> {
  const { protocol, providerKeys, requireResponse = false, limitPerProvider = 1 } = options;
  const cases: Array<{ label: string; requestDir: string; hasResponse?: boolean }> = [];
  for (const providerKey of providerKeys) {
    const dirs = listSampleDirs(protocol, providerKey)
      .filter((entry) => (requireResponse ? hasRequestAndResponseSamples(entry) : hasRequestSample(entry)))
      .slice(0, limitPerProvider);
    for (const dir of dirs) {
      cases.push({
        label: `${providerKey}:${path.basename(dir)}`,
        requestDir: dir,
        ...(requireResponse ? { hasResponse: true } : {})
      });
    }
  }
  return cases;
}

const REAL_SAMPLE_DIR = pickLatestSampleDir({
  protocol: 'openai-responses',
  providerKeys: ['ali-coding-plan.key1.glm-5', 'ali-coding-plan.key1.qwen3.6-plus'],
  requireResponse: true
});
const REQUEST_SAMPLE_PATH = `${REAL_SAMPLE_DIR}/provider-request.json`;
const RESPONSE_SAMPLE_PATH = `${REAL_SAMPLE_DIR}/provider-response.json`;
const hasRealSample = Boolean(REAL_SAMPLE_DIR) && fs.existsSync(REQUEST_SAMPLE_PATH) && fs.existsSync(RESPONSE_SAMPLE_PATH);

const RESPONSES_REQUEST_SAMPLE_DIR = pickLatestSampleDir({
  protocol: 'openai-responses',
  providerKeys: ['lmstudio.key1.minimax-m2.7', 'lmstudio.key1.mlx-qwen3.5-35b-a3b-claude-4.6-opus-reasoning-distilled']
});
const RESPONSES_REQUEST_SAMPLE_PATH = `${RESPONSES_REQUEST_SAMPLE_DIR}/provider-request.json`;
const hasResponsesRequestSample = Boolean(RESPONSES_REQUEST_SAMPLE_DIR) && fs.existsSync(RESPONSES_REQUEST_SAMPLE_PATH);

const RESPONSES_CROSS_PROTOCOL_SAMPLE_DIR = pickLatestSampleDir({
  protocol: 'openai-responses',
  providerKeys: ['ali-coding-plan.key1.qwen3.6-plus', 'ali-coding-plan.key1.glm-5', 'ali-coding-plan.key1.kimi-k2.5'],
  requireResponse: true
});
const RESPONSES_CROSS_PROTOCOL_REQUEST_SAMPLE_PATH =
  `${RESPONSES_CROSS_PROTOCOL_SAMPLE_DIR}/provider-request.json`;
const RESPONSES_CROSS_PROTOCOL_RESPONSE_SAMPLE_PATH =
  `${RESPONSES_CROSS_PROTOCOL_SAMPLE_DIR}/provider-response.json`;
const hasResponsesCrossProtocolSample =
  Boolean(RESPONSES_CROSS_PROTOCOL_SAMPLE_DIR) &&
  fs.existsSync(RESPONSES_CROSS_PROTOCOL_REQUEST_SAMPLE_PATH) &&
  fs.existsSync(RESPONSES_CROSS_PROTOCOL_RESPONSE_SAMPLE_PATH);

function loadJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function normalizeAnthropicProviderRequest(payload: Record<string, unknown>) {
  return {
    model: payload.model,
    max_tokens: payload.max_tokens,
    messages: payload.messages,
    system: payload.system,
    thinking: payload.thinking,
    output_config: payload.output_config,
    stream: payload.stream
  };
}

function normalizeResponsesProviderRequest(payload: Record<string, unknown>) {
  const prune = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(prune);
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (key === 'tool_call_id') {
          continue;
        }
        out[key] = prune(entry);
      }
      return out;
    }
    return value;
  };

  return {
    input: prune(payload.input),
    model: payload.model,
    store: payload.store,
    stream: payload.stream
  };
}

function snapshotAnthropicResponse(payload: any) {
  return {
    id: payload.id,
    model: payload.model,
    finish_reason: payload.choices?.[0]?.finish_reason,
    content: payload.choices?.[0]?.message?.content,
    reasoning_content: payload.choices?.[0]?.message?.reasoning_content,
    usage: payload.usage
  };
}

function snapshotOpenAIChatPayload(payload: any) {
  return {
    id: payload.id,
    model: payload.model,
    finish_reason: payload.choices?.[0]?.finish_reason,
    content: payload.choices?.[0]?.message?.content,
    reasoning_content: payload.choices?.[0]?.message?.reasoning_content,
    usage: payload.usage
  };
}

function snapshotResponsesPayload(payload: any) {
  return {
    id: payload.id,
    object: payload.object,
    model: payload.model,
    output_text: payload.output_text,
    status: payload.status,
    usage: payload.usage
  };
}

const OPENAI_CHAT_ANTHROPIC_CASES = buildDiscoveredCases({
  protocol: 'openai-chat',
  providerKeys: ['ali-coding-plan.key1.glm-5', 'ali-coding-plan.key1.qwen3.6-plus'],
  requireResponse: true,
  limitPerProvider: 2
});

const OPENAI_RESPONSES_ANTHROPIC_CASES = buildDiscoveredCases({
  protocol: 'openai-responses',
  providerKeys: ['ali-coding-plan.key1.glm-5', 'ali-coding-plan.key1.qwen3.6-plus', 'ali-coding-plan.key1.kimi-k2.5'],
  requireResponse: true,
  limitPerProvider: 1
});

const REASONING_STOP_GUARD_REAL_SAMPLE_DIR = pickLatestSampleDir({
  protocol: 'openai-responses',
  providerKeys: ['mimo.key1.mimo-v2.5-pro'],
  requireResponse: true,
  nameIncludes: 'reasoning_stop_guard'
});

const REASONING_STOP_GUARD_LIVE_CASES = [
  {
    label: 'mimo exec_command followup',
    dir:
      '/Volumes/extension/.rcc/codex-samples/openai-responses/mimo.key1.mimo-v2.5-pro/openai-responses-mimo.key1-mimo-v2.5-pro-20260507T220242798-168767-1436_reasoning_stop_guard',
    expectedToolName: 'exec_command'
  },
  {
    label: 'whitedrem old bad root-tools shape 168770',
    dir:
      '/Volumes/extension/.rcc/codex-samples/openai-responses/whitedrem.key1.deepseek-v4-pro/openai-responses-whitedrem.key1-deepseek-v4-pro-20260507T220934622-168770-1439_reasoning_stop_guard',
    expectedRootTools: ['exec_command', 'reasoning.stop'],
    expectedMaxTokensCleared: true
  },
  {
    label: 'whitedrem old bad root-tools shape 168772',
    dir:
      '/Volumes/extension/.rcc/codex-samples/openai-responses/whitedrem.key1.deepseek-v4-pro/openai-responses-whitedrem.key1-deepseek-v4-pro-20260507T221321610-168772-1441_reasoning_stop_guard',
    expectedRootTools: ['exec_command', 'reasoning.stop'],
    expectedMaxTokensCleared: true
  },
  {
    label: 'mimo old bad root-tools shape 168773',
    dir:
      '/Volumes/extension/.rcc/codex-samples/openai-responses/mimo.key1.mimo-v2.5-pro/openai-responses-whitedrem.key1-deepseek-v4-pro-20260507T221523279-168773-1442_reasoning_stop_guard',
    expectedRootTools: ['exec_command', 'reasoning.stop'],
    expectedMaxTokensCleared: true
  }
].filter((entry) => fs.existsSync(entry.dir));

const OPENAI_RESPONSES_NATIVE_REQUEST_CASES = buildDiscoveredCases({
  protocol: 'openai-responses',
  providerKeys: ['lmstudio.key1.minimax-m2.7', 'lmstudio.key1.mlx-qwen3.5-35b-a3b-claude-4.6-opus-reasoning-distilled'],
  limitPerProvider: 1
});

function hasRequestSample(dir: string): boolean {
  return fs.existsSync(`${dir}/provider-request.json`);
}

function hasRequestAndResponseSamples(dir: string): boolean {
  return hasRequestSample(dir) && fs.existsSync(`${dir}/provider-response.json`);
}

async function replayAnthropicRequestFromSample(options: {
  dir: string;
  requestId: string;
  entryEndpoint: '/v1/chat/completions' | '/v1/responses' | '/v1/messages';
}) {
  const requestDoc = loadJson(`${options.dir}/provider-request.json`);
  const mapper = new AnthropicSemanticMapper();
  const adapterContext = {
    requestId: options.requestId,
    entryEndpoint: options.entryEndpoint,
    providerProtocol: 'anthropic-messages'
  };

  const chat = await mapper.toChat(
    {
      protocol: 'anthropic-messages',
      direction: 'request',
      payload: requestDoc.body
    } as any,
    adapterContext as any
  );

  const roundtrip = await mapper.fromChat(chat, adapterContext as any);
  return { requestDoc, chat, roundtrip };
}

async function replayAnthropicResponseToClient(options: {
  dir: string;
  requestId: string;
  entryEndpoint: '/v1/chat/completions' | '/v1/responses';
  clientProtocol: 'openai-chat' | 'openai-responses';
  requestSemantics?: Record<string, unknown>;
  adapterContextExtra?: Record<string, unknown>;
}) {
  const responseDoc = loadJson(`${options.dir}/provider-response.json`);
  const responsePayload =
    typeof responseDoc?.body?.raw === 'string' && responseDoc.body.raw.trim().length > 0
      ? {
        ...responseDoc.body,
        __sse_stream: Readable.from([responseDoc.body.raw])
      }
      : responseDoc.body;
  const adapterContext = {
    requestId: options.requestId,
    entryEndpoint: options.entryEndpoint,
    providerProtocol: 'anthropic-messages',
    ...(options.adapterContextExtra ?? {})
  };

  const stage1 = await runRespInboundStage1SseDecode({
    providerProtocol: 'anthropic-messages',
    payload: responsePayload as any,
    adapterContext: adapterContext as any,
    wantsStream: false
  });

  const stage2 = await runRespInboundStage2FormatParse({
    adapterContext: adapterContext as any,
    payload: stage1.payload as any
  });

  const chatResponse = await runRespInboundStage3SemanticMap({
    adapterContext: adapterContext as any,
    formatEnvelope: stage2,
    mapper: new AnthropicResponseMapper(),
    requestSemantics: options.requestSemantics as any
  });

  const governed = await import('../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_process/resp_process_stage1_tool_governance/index.js')
    .then(({ runRespProcessStage1ToolGovernance }) =>
      runRespProcessStage1ToolGovernance({
        payload: chatResponse as any,
        entryEndpoint: options.entryEndpoint,
        requestId: options.requestId,
        clientProtocol: options.clientProtocol,
        requestSemantics: options.requestSemantics as any,
        adapterContext: adapterContext as any
      })
    );

  const finalized = await runRespProcessStage2Finalize({
    payload: governed.governedPayload as any,
    originalPayload: chatResponse as any,
    entryEndpoint: options.entryEndpoint,
    requestId: options.requestId,
    wantsStream: false,
    reasoningMode: 'keep'
  });

  const clientPayload = runRespOutboundStage1ClientRemap({
    payload: finalized.finalizedPayload as any,
    clientProtocol: options.clientProtocol,
    requestId: options.requestId,
    responseSemantics: (finalized.processedRequest as any)?.semantics,
    requestSemantics: options.requestSemantics as any,
    adapterContext: adapterContext as any
  });

  return { chatResponse, clientPayload };
}

async function replayResponsesRequestFromSample(options: {
  dir: string;
  requestId: string;
}) {
  const requestDoc = loadJson(`${options.dir}/provider-request.json`);
  const mapper = new ResponsesSemanticMapper();
  const adapterContext = {
    requestId: options.requestId,
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-responses'
  };

  const chat = await mapper.toChat(
    {
      protocol: 'openai-responses',
      direction: 'request',
      payload: requestDoc.body
    } as any,
    adapterContext as any
  );

  const roundtrip = await mapper.fromChat(chat, adapterContext as any);
  return { requestDoc, chat, roundtrip };
}

describe('real sample hub input/output compare', () => {
  (hasRealSample ? it : it.skip)(
    'replays real provider-request through anthropic mapper and compares hub input/output fields',
    async () => {
      const requestDoc = loadJson(REQUEST_SAMPLE_PATH);
      const { chat, roundtrip } = await replayAnthropicRequestFromSample({
        dir: REAL_SAMPLE_DIR!,
        requestId: 'real-sample-request-replay',
        entryEndpoint: '/v1/responses'
      });

      expect(Array.isArray(chat.messages)).toBe(true);
      expect(chat.messages.length).toBeGreaterThan(0);
      expect(chat.messages.some((message: any) => message?.role === 'user')).toBe(true);
      expect(chat.semantics).toBeTruthy();
      expect(normalizeAnthropicProviderRequest(roundtrip.payload as Record<string, unknown>)).toEqual(
        normalizeAnthropicProviderRequest(requestDoc.body as Record<string, unknown>)
      );
    }
  );

  (hasRealSample ? it : it.skip)(
    'replays real provider-response through response hub stages and compares hub input/output fields',
    async () => {
      const { chatResponse, clientPayload } = await replayAnthropicResponseToClient({
        dir: REAL_SAMPLE_DIR!,
        requestId: 'real-sample-response-replay',
        entryEndpoint: '/v1/responses',
        clientProtocol: 'openai-responses'
      });

        expect({
          id: (clientPayload as any).id,
          object: (clientPayload as any).object,
          model: (clientPayload as any).model,
          usage: (clientPayload as any).usage
        }).toMatchObject({
          id: chatResponse.id,
          object: 'response',
          model: chatResponse.model,
          usage: chatResponse.usage
        });
    }
  );
});

describe('real sample responses hub input/output compare', () => {
  (hasResponsesRequestSample ? it : it.skip)(
    'replays real openai responses provider-request through responses mapper and compares hub input/output fields',
    async () => {
      const requestDoc = loadJson(RESPONSES_REQUEST_SAMPLE_PATH);
      const mapper = new ResponsesSemanticMapper();
      const adapterContext = {
        requestId: 'real-sample-responses-request-replay',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses'
      };

      const chat = await mapper.toChat(
        {
          protocol: 'openai-responses',
          direction: 'request',
          payload: requestDoc.body
        } as any,
        adapterContext as any
      );

      expect(Array.isArray(chat.messages)).toBe(true);
      expect(chat.messages.length).toBeGreaterThan(0);
      expect(chat.messages.some((message: any) => message?.role === 'user')).toBe(true);
      expect((chat.semantics as any)?.responses?.context?.input).toEqual(
        (requestDoc.body as any).input
      );
      expect((chat.semantics as any)?.responses?.context?.parameters).toMatchObject({
        store: false
      });

      const roundtrip = await mapper.fromChat(chat, adapterContext as any);
      expect(normalizeResponsesProviderRequest(roundtrip.payload as Record<string, unknown>)).toEqual(
        normalizeResponsesProviderRequest(requestDoc.body as Record<string, unknown>)
      );
      expect((roundtrip.payload as any).metadata).toMatchObject({
        context: {
          entryEndpoint: '/v1/responses',
          providerProtocol: 'openai-responses',
          requestId: 'real-sample-responses-request-replay'
        }
      });
    }
  );

  (hasResponsesCrossProtocolSample ? it : it.skip)(
    'replays real anthropic provider request/response for /v1/responses and compares hub input/output fields',
    async () => {
      const requestDoc = loadJson(RESPONSES_CROSS_PROTOCOL_REQUEST_SAMPLE_PATH);
      const responseDoc = loadJson(RESPONSES_CROSS_PROTOCOL_RESPONSE_SAMPLE_PATH);
      const adapterContext = {
        requestId: 'real-sample-responses-cross-protocol-replay',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'anthropic-messages'
      };

      const mapper = new AnthropicSemanticMapper();
      const chat = await mapper.toChat(
        {
          protocol: 'anthropic-messages',
          direction: 'request',
          payload: requestDoc.body
        } as any,
        adapterContext as any
      );

      expect(Array.isArray(chat.messages)).toBe(true);
      expect(chat.messages.length).toBeGreaterThan(0);
      expect(chat.messages.some((message: any) => message?.role === 'user')).toBe(true);
      expect(chat.semantics).toBeTruthy();

      const roundtrip = await mapper.fromChat(chat, adapterContext as any);
      expect(normalizeAnthropicProviderRequest(roundtrip.payload as Record<string, unknown>)).toEqual(
        normalizeAnthropicProviderRequest(requestDoc.body as Record<string, unknown>)
      );

      const stage1 = await runRespInboundStage1SseDecode({
        providerProtocol: 'anthropic-messages',
        payload:
          (typeof responseDoc?.body?.raw === 'string' && responseDoc.body.raw.trim().length > 0
            ? {
              ...responseDoc.body,
              __sse_stream: Readable.from([responseDoc.body.raw])
            }
            : responseDoc.body) as any,
        adapterContext: adapterContext as any,
        wantsStream: false
      });

      const stage2 = await runRespInboundStage2FormatParse({
        adapterContext: adapterContext as any,
        payload: stage1.payload as any
      });

      const chatResponse = await runRespInboundStage3SemanticMap({
        adapterContext: adapterContext as any,
        formatEnvelope: stage2,
        mapper: new AnthropicResponseMapper()
      });

      expect(chatResponse).toBeTruthy();
      expect(typeof chatResponse?.id).toBe('string');
      expect(typeof chatResponse?.model).toBe('string');
      expect(chatResponse?.choices?.[0]?.message?.role).toBe('assistant');

      const finalized = await runRespProcessStage2Finalize({
        payload: chatResponse as any,
        originalPayload: chatResponse as any,
        entryEndpoint: '/v1/responses',
        requestId: 'real-sample-responses-cross-protocol-replay',
        wantsStream: false,
        reasoningMode: 'keep'
      });

      const clientPayload = runRespOutboundStage1ClientRemap({
        payload: finalized.finalizedPayload as any,
        clientProtocol: 'openai-responses',
        requestId: 'real-sample-responses-cross-protocol-replay',
        responseSemantics: (finalized.processedRequest as any)?.semantics
      });

        expect({
          id: (clientPayload as any).id,
          object: (clientPayload as any).object,
          model: (clientPayload as any).model,
          usage: (clientPayload as any).usage
        }).toMatchObject({
          id: chatResponse.id,
          object: 'response',
          model: chatResponse.model,
          usage: chatResponse.usage
        });
      expect((clientPayload as any).request_id).toBe('real-sample-responses-cross-protocol-replay');
      expect(Array.isArray((clientPayload as any).output)).toBe(true);
    }
  );
});

describe('real sample matrix compare: openai-chat -> anthropic', () => {
  const requestCases = OPENAI_CHAT_ANTHROPIC_CASES.filter((entry) => hasRequestSample(entry.requestDir));
  const responseCases = OPENAI_CHAT_ANTHROPIC_CASES.filter((entry) => entry.hasResponse && hasRequestAndResponseSamples(entry.requestDir));

  if (requestCases.length > 0) {
    it.each(requestCases)(
      '$label request roundtrip',
      async ({ requestDir, label }) => {
        const { requestDoc, roundtrip } = await replayAnthropicRequestFromSample({
          dir: requestDir,
          requestId: `real-sample-openai-chat-request-${label}`,
          entryEndpoint: '/v1/chat/completions'
        });

        expect(normalizeAnthropicProviderRequest(roundtrip.payload as Record<string, unknown>)).toEqual(
          normalizeAnthropicProviderRequest(requestDoc.body as Record<string, unknown>)
        );
      }
    );
  } else {
    it.skip('request roundtrip skipped: no openai-chat anthropic samples found', () => {});
  }

  if (responseCases.length > 0) {
    it.each(responseCases)(
      '$label response roundtrip',
      async ({ requestDir, label }) => {
        const { chatResponse, clientPayload } = await replayAnthropicResponseToClient({
          dir: requestDir,
          requestId: `real-sample-openai-chat-response-${label}`,
          entryEndpoint: '/v1/chat/completions',
          clientProtocol: 'openai-chat'
        });

        expect(snapshotOpenAIChatPayload(clientPayload)).toEqual(snapshotAnthropicResponse(chatResponse));
      }
    );
  } else {
    it.skip('response roundtrip skipped: no openai-chat anthropic samples found', () => {});
  }
});

describe('real sample matrix compare: openai-responses -> anthropic -> openai-responses', () => {
  const requestCases = OPENAI_RESPONSES_ANTHROPIC_CASES.filter((entry) => hasRequestSample(entry.requestDir));
  const responseCases = OPENAI_RESPONSES_ANTHROPIC_CASES.filter((entry) => hasRequestAndResponseSamples(entry.requestDir));

  if (requestCases.length > 0) {
    it.each(requestCases)(
      '$label request roundtrip',
      async ({ requestDir, label }) => {
        const { requestDoc, roundtrip } = await replayAnthropicRequestFromSample({
          dir: requestDir,
          requestId: `real-sample-openai-responses-request-${label}`,
          entryEndpoint: '/v1/responses'
        });

        expect(normalizeAnthropicProviderRequest(roundtrip.payload as Record<string, unknown>)).toEqual(
          normalizeAnthropicProviderRequest(requestDoc.body as Record<string, unknown>)
        );
      }
    );
  } else {
    it.skip('request roundtrip skipped: no openai-responses anthropic samples found', () => {});
  }

  if (responseCases.length > 0) {
    it.each(responseCases)(
      '$label response roundtrip',
      async ({ requestDir, label }) => {
        const { chatResponse, clientPayload } = await replayAnthropicResponseToClient({
          dir: requestDir,
          requestId: `real-sample-openai-responses-response-${label}`,
          entryEndpoint: '/v1/responses',
          clientProtocol: 'openai-responses'
        });

        expect({
          id: (clientPayload as any).id,
          object: (clientPayload as any).object,
          model: (clientPayload as any).model,
          usage: (clientPayload as any).usage
        }).toMatchObject({
          id: chatResponse.id,
          object: 'response',
          model: chatResponse.model,
          usage: chatResponse.usage
        });
      }
    );
  } else {
    it.skip('response roundtrip skipped: no openai-responses anthropic samples found', () => {});
  }
});

describe('real sample matrix compare: reasoning_stop_guard followup keeps declared client tool surface', () => {
  (REASONING_STOP_GUARD_REAL_SAMPLE_DIR ? it : it.skip)(
    'maps anthropic tool_use(exec_command) back to responses function_call on live mimo followup sample',
    async () => {
      const { clientPayload } = await replayAnthropicResponseToClient({
        dir: REASONING_STOP_GUARD_REAL_SAMPLE_DIR!,
        requestId: 'real-sample-reasoning-stop-guard-followup',
        entryEndpoint: '/v1/responses',
        clientProtocol: 'openai-responses',
        requestSemantics: {
          tools: {
            clientToolsRaw: [
              {
                type: 'function',
                function: {
                  name: 'exec_command',
                  parameters: {
                    type: 'object',
                    properties: { cmd: { type: 'string' } },
                    required: ['cmd']
                  }
                }
              }
            ]
          },
          __routecodex: {
            serverToolFollowup: true,
            serverToolFollowupSource: 'servertool.reasoning_stop_guard'
          }
        },
        adapterContextExtra: {
          capturedChatRequest: {
            model: 'mimo-v2.5-pro',
            messages: [{ role: 'user', content: '继续执行' }],
            tools: [
              {
                type: 'function',
                function: {
                  name: 'exec_command',
                  parameters: { type: 'object' }
                }
              }
            ]
          }
        }
      });

      const output = Array.isArray((clientPayload as any)?.output) ? (clientPayload as any).output : [];
      const functionCall = output.find((item: any) => item?.type === 'function_call' && item?.name === 'exec_command');
      expect(functionCall).toBeTruthy();
      expect((clientPayload as any)?.status).toBe('requires_action');
    }
  );
});

describe('real sample matrix compare: historical reasoning_stop_guard bad request shapes', () => {
  const clientToolsRaw = [
    {
      type: 'function',
      function: {
        name: 'exec_command',
        parameters: {
          type: 'object',
          properties: { cmd: { type: 'string' } },
          required: ['cmd']
        }
      }
    }
  ];

  if (REASONING_STOP_GUARD_LIVE_CASES.length > 0) {
    it.each(REASONING_STOP_GUARD_LIVE_CASES)(
      '$label keeps canonical followup semantics',
      async ({ dir, expectedToolName, expectedRootTools, expectedMaxTokensCleared }) => {
        const requestDoc = loadJson(`${dir}/provider-request.json`);
        const requestSemantics = {
          tools: { clientToolsRaw },
          __routecodex: {
            serverToolFollowup: true,
            serverToolFollowupSource: 'servertool.reasoning_stop_guard'
          }
        };

        if (expectedToolName) {
          const { clientPayload } = await replayAnthropicResponseToClient({
            dir,
            requestId: `real-sample-reasoning-stop-live-${path.basename(dir)}`,
            entryEndpoint: '/v1/responses',
            clientProtocol: 'openai-responses',
            requestSemantics,
            adapterContextExtra: {
              capturedChatRequest: {
                model: 'mimo-v2.5-pro',
                messages: [{ role: 'user', content: '继续执行' }],
                tools: clientToolsRaw
              }
            }
          });

          const output = Array.isArray((clientPayload as any)?.output) ? (clientPayload as any).output : [];
          const functionCall = output.find(
            (item: any) => item?.type === 'function_call' && item?.name === expectedToolName
          );
          expect(functionCall).toBeTruthy();
          expect((clientPayload as any)?.status).toBe('requires_action');
          return;
        }

        const { executeServerToolReenterPipeline } = await import(
          '../../src/server/runtime/http-server/executor/servertool-followup-dispatch.js'
        );

        const executeNested = async (input: any) => ({ status: 200, body: input.body });

        const result = await executeServerToolReenterPipeline({
          entryEndpoint: '/v1/responses',
          fallbackEntryEndpoint: '/v1/responses',
          requestId: `real-sample-shape-${path.basename(dir)}`,
          body: requestDoc.body,
          metadata: {
            __rt: {
              serverToolFollowup: true,
              clientInjectSource: 'servertool.reasoning_stop_guard'
            }
          },
          requestSemantics,
          executeNested
        });

        const rebuiltBody = (result.body ?? {}) as Record<string, unknown>;
        const rebuiltTools = Array.isArray(rebuiltBody.tools) ? rebuiltBody.tools : [];
        const rebuiltToolNames = rebuiltTools
          .map((tool: any) => tool?.name ?? tool?.function?.name ?? tool?.type)
          .filter((name: unknown): name is string => typeof name === 'string');

        expect(rebuiltToolNames).toEqual(expectedRootTools);
        if (expectedMaxTokensCleared) {
          expect((rebuiltBody as any).max_tokens).toBeUndefined();
          expect((rebuiltBody as any).max_output_tokens).toBeUndefined();
        }
        expect(((rebuiltBody as any).semantics?.__routecodex ?? null)).toEqual({
          serverToolFollowup: true,
          serverToolFollowupSource: 'servertool.reasoning_stop_guard'
        });
      }
    );
  } else {
    it.skip('historical reasoning_stop_guard bad request shapes skipped: no live samples found', () => {});
  }
});

describe('real sample matrix compare: openai-responses native request roundtrip', () => {
  const requestCases = OPENAI_RESPONSES_NATIVE_REQUEST_CASES.filter((entry) => hasRequestSample(entry.requestDir));

  if (requestCases.length > 0) {
    it.each(requestCases)(
      '$label request roundtrip',
      async ({ requestDir, label }) => {
        const { requestDoc, roundtrip } = await replayResponsesRequestFromSample({
          dir: requestDir,
          requestId: `real-sample-openai-responses-native-${label}`
        });

        expect(normalizeResponsesProviderRequest(roundtrip.payload as Record<string, unknown>)).toEqual(
          normalizeResponsesProviderRequest(requestDoc.body as Record<string, unknown>)
        );
      }
    );
  } else {
    it.skip('request roundtrip skipped: no native openai-responses samples found', () => {});
  }
});
