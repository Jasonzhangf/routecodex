import { describe, expect, test } from '@jest/globals';

import {
  runReqOutboundStage3CompatWithNative,
  runRespInboundStage3CompatWithNative
} from '../../src/router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';
import {
  extractAntigravityGeminiSessionIdWithNative
} from '../../src/router/virtual-router/engine-selection/native-router-hotpath.js';

describe('antigravity thoughtSignature session lease', () => {
  test('reuses alias latest signature session when current derived session has no cached signature', () => {
    const tag = `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const aliasKey = `antigravity.aliasa.${tag}`;
    const signature = 's'.repeat(80);

    const oldPayload: any = {
      request: {
        contents: [{ role: 'user', parts: [{ text: `seed-old-${tag}` }] }]
      }
    };
    const oldSid = extractAntigravityGeminiSessionIdWithNative(oldPayload);
    runRespInboundStage3CompatWithNative({
      payload: {
        request_id: `req_test_lease_seed_${tag}`,
        candidates: [{ content: { parts: [{ thoughtSignature: signature }] } }]
      },
      adapterContext: {
        requestId: `req_test_lease_seed_${tag}`,
        providerProtocol: 'gemini-chat',
        providerId: 'antigravity',
        providerKey: `${aliasKey}.gemini-3-pro`,
        runtimeKey: aliasKey,
        sessionId: oldSid
      },
      explicitProfile: 'chat:gemini-cli'
    });

    const newPayload: any = {
      request: {
        contents: [
          { role: 'user', parts: [{ text: `seed-new-${tag}` }] },
          { role: 'model', parts: [{ functionCall: { name: 'glob', args: {}, id: 'call_1' } }] }
        ]
      }
    };
    const newSid = extractAntigravityGeminiSessionIdWithNative(newPayload);
    expect(newSid).not.toBe(oldSid);

    const out = runReqOutboundStage3CompatWithNative({
      payload: newPayload,
      adapterContext: {
        requestId: `req_test_lease_${tag}`,
        providerProtocol: 'gemini-chat',
        providerKey: `${aliasKey}.gemini-3-pro`,
        runtimeKey: aliasKey,
        providerId: 'antigravity'
      },
      explicitProfile: 'chat:gemini-cli'
    });

    expect(out?.payload?.request?.contents?.[1]?.parts?.[0]?.thoughtSignature).toBe(signature);
  });
});
