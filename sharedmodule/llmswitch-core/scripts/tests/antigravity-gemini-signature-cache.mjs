#!/usr/bin/env node
/**
 * Regression: Antigravity/Gemini thoughtSignature cache+inject path via native compat stage.
 *
 * Behavior:
 * - Session id derives from Gemini-native request contents.
 * - Response compat caches thoughtSignature for the session.
 * - Request compat injects cached thoughtSignature into functionCall parts.
 */

import {
  runReqOutboundStage3CompatWithNative,
  runRespInboundStage3CompatWithNative
} from '../../dist/router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';
import {
  extractAntigravityGeminiSessionIdWithNative
} from '../../dist/router/virtual-router/engine-selection/native-router-hotpath.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function seedSignature({ aliasKey, sessionId, signature, requestId }) {
  runRespInboundStage3CompatWithNative({
    payload: {
      request_id: requestId,
      candidates: [
        {
          content: {
            parts: [{ thoughtSignature: signature }]
          }
        }
      ]
    },
    adapterContext: {
      requestId,
      providerProtocol: 'gemini-chat',
      providerId: 'antigravity',
      providerKey: `${aliasKey}.gemini-3-pro`,
      runtimeKey: aliasKey,
      sessionId
    },
    explicitProfile: 'chat:gemini-cli'
  });
}

function runGeminiCliRequest(payload, adapterContext) {
  const out = runReqOutboundStage3CompatWithNative({
    payload: structuredClone(payload),
    adapterContext: {
      providerProtocol: 'gemini-chat',
      ...(adapterContext || {})
    },
    explicitProfile: 'chat:gemini-cli'
  });
  return out.payload;
}

function firstFunctionCallPart(payload) {
  const contents = payload?.request?.contents;
  if (!Array.isArray(contents)) return undefined;
  return contents
    .flatMap((c) => (c && typeof c === 'object' && Array.isArray(c.parts) ? c.parts : []))
    .find((p) => p && typeof p === 'object' && p.functionCall);
}

async function main() {
  const signature = 's'.repeat(80);
  const signature2 = 't'.repeat(96);

  const basePayload = {
    model: 'gemini-3-pro',
    request: {
      contents: [
        { role: 'user', parts: [{ text: 'hello world from user message' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'exec_command',
                args: { command: 'echo 1' },
                id: 'fc_toolu_test_01'
              }
            }
          ]
        }
      ]
    }
  };

  const sessionId = extractAntigravityGeminiSessionIdWithNative(basePayload.request);
  assert(typeof sessionId === 'string' && sessionId.startsWith('sid-') && sessionId.length === 20, `bad sessionId: ${sessionId}`);

  {
    const noAdapterPayload = {
      model: 'gemini-3-pro',
      userAgent: 'antigravity',
      requestType: 'agent',
      requestId: 'agent-test-no-adapter',
      request: structuredClone(basePayload.request)
    };
    const sidNoAdapter = extractAntigravityGeminiSessionIdWithNative(noAdapterPayload.request);
    seedSignature({
      aliasKey: 'antigravity.unknown',
      sessionId: sidNoAdapter,
      signature,
      requestId: 'req_matrix_antigravity_sig_seed_no_adapter'
    });

    const injectedNoAdapter = runGeminiCliRequest(noAdapterPayload, {
      requestId: 'req_matrix_antigravity_sig_no_adapter',
      entryEndpoint: '/v1/responses'
    });
    const fnPartNoAdapter = firstFunctionCallPart(injectedNoAdapter);
    assert(fnPartNoAdapter, 'expected a functionCall part (no-adapter)');
    assert(fnPartNoAdapter.thoughtSignature === signature, 'expected thoughtSignature injection without provider identity');
  }

  {
    seedSignature({
      aliasKey: 'antigravity.default',
      sessionId,
      signature,
      requestId: 'req_matrix_antigravity_sig_seed_scoped'
    });

    const injected = runGeminiCliRequest(basePayload, {
      requestId: 'req_matrix_antigravity_sig',
      entryEndpoint: '/v1/responses',
      providerId: 'antigravity',
      providerKey: 'antigravity.default.gemini-3-pro',
      runtimeKey: 'antigravity.default'
    });
    const fnPart = firstFunctionCallPart(injected);
    assert(fnPart, 'expected a functionCall part');
    assert(fnPart.thoughtSignature === signature, 'expected thoughtSignature to be injected from cache');
  }

  {
    const notInjected = runGeminiCliRequest(basePayload, {
      requestId: 'req_matrix_antigravity_sig_off',
      entryEndpoint: '/v1/responses',
      providerId: 'not-antigravity',
      providerKey: 'not-antigravity.k.gemini-3-pro',
      runtimeKey: 'not-antigravity.k'
    });
    const fnPart = firstFunctionCallPart(notInjected);
    assert(fnPart, 'expected a functionCall part');
    assert(fnPart.thoughtSignature !== signature, 'expected signature injection to be scoped');
  }

  {
    const adapterContext = {
      providerProtocol: 'gemini-chat',
      providerId: 'antigravity',
      providerKey: 'antigravity.flow.gemini-3-pro',
      runtimeKey: 'antigravity.flow'
    };

    const firstRequest = {
      requestId: 'agent-test-flow-1',
      userAgent: 'antigravity',
      contents: [
        { role: 'user', parts: [{ text: 'hello world from user message (flow)' }] }
      ]
    };
    runReqOutboundStage3CompatWithNative({
      payload: structuredClone(firstRequest),
      adapterContext: {
        ...adapterContext,
        requestId: 'req_matrix_antigravity_sig_flow_1',
        entryEndpoint: '/v1/responses'
      },
      explicitProfile: 'chat:gemini-cli'
    });

    runRespInboundStage3CompatWithNative({
      payload: {
        request_id: 'req_matrix_antigravity_sig_flow_1',
        candidates: [
          {
            content: {
              parts: [
                {
                  thoughtSignature: signature2,
                  functionCall: { name: 'echo', args: { message: 'hi' }, id: 'gemini_tool_0' }
                }
              ]
            }
          }
        ]
      },
      adapterContext: {
        ...adapterContext,
        requestId: 'req_matrix_antigravity_sig_flow_1',
        entryEndpoint: '/v1/responses'
      },
      explicitProfile: 'chat:gemini-cli'
    });

    const followup = {
      requestId: 'agent-test-flow-2',
      userAgent: 'antigravity',
      contents: [
        { role: 'user', parts: [{ text: 'hello world from user message (flow)' }] },
        {
          role: 'assistant',
          parts: [
            {
              functionCall: { name: 'echo', args: { message: 'hi' }, id: 'gemini_tool_0' }
            }
          ]
        }
      ]
    };
    const followupInjected = runReqOutboundStage3CompatWithNative({
      payload: followup,
      adapterContext: {
        ...adapterContext,
        requestId: 'req_matrix_antigravity_sig_flow_2',
        entryEndpoint: '/v1/responses'
      },
      explicitProfile: 'chat:gemini-cli'
    });
    const followupFnPart = firstFunctionCallPart(followupInjected.payload);
    assert(followupFnPart, 'expected a functionCall part (flow followup)');
    assert(followupFnPart.thoughtSignature === signature2, 'expected cached thoughtSignature injected after response compat caching');
  }

  console.log('✅ antigravity gemini thoughtSignature cache/inject passed');
}

main().catch((err) => {
  console.error('❌ antigravity gemini thoughtSignature cache/inject failed:', err && err.message ? err.message : err);
  process.exit(1);
});
