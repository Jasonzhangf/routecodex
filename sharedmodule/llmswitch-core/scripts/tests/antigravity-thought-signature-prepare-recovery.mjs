#!/usr/bin/env node
/**
 * Regression: native antigravity thoughtSignature prepare + recovery behavior.
 *
 * Covers:
 * - Normal injection from cached thoughtSignature
 * - Alias latest-session leasing for new sessions
 * - Rewind guard (smaller messageCount should skip injection)
 * - Recovery mode (__rt.antigravityThoughtSignatureRecovery) strips stale signatures
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

function firstFunctionCallPartFromWrapped(payload) {
  const contents = payload?.request?.contents;
  if (!Array.isArray(contents)) return undefined;
  for (const entry of contents) {
    const parts = Array.isArray(entry?.parts) ? entry.parts : [];
    for (const part of parts) {
      if (part && typeof part === 'object' && part.functionCall) {
        return part;
      }
    }
  }
  return undefined;
}

function runGeminiCliReq(payload, adapterContext, requestId) {
  return runReqOutboundStage3CompatWithNative({
    payload: structuredClone(payload),
    adapterContext: {
      providerProtocol: 'gemini-chat',
      requestId,
      providerId: 'antigravity',
      providerKey: `${adapterContext.aliasKey}.gemini-3-pro`,
      runtimeKey: adapterContext.aliasKey,
      ...(adapterContext.extra || {})
    },
    explicitProfile: 'chat:gemini-cli'
  });
}

function seedSignature(aliasKey, sessionId, signature, requestId) {
  return runRespInboundStage3CompatWithNative({
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
      providerProtocol: 'gemini-chat',
      requestId,
      providerId: 'antigravity',
      providerKey: `${aliasKey}.gemini-3-pro`,
      runtimeKey: aliasKey,
      sessionId
    },
    explicitProfile: 'chat:gemini-cli'
  });
}

async function main() {
  const signature = `EiYK${'s'.repeat(80)}`;
  const signature2 = `EiYK${'t'.repeat(96)}`;
  const signature3 = `EiYK${'u'.repeat(96)}`;
  const tag = `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const aliasKeyNormal = `antigravity.normal_${tag}`;
  const aliasKeyLease = `antigravity.lease_${tag}`;
  const aliasKeyRewind = `antigravity.rewind_${tag}`;
  const aliasKeyRecovery = `antigravity.recovery_${tag}`;

  {
    const payload = {
      model: 'gemini-3-pro',
      request: {
        contents: [
          { role: 'user', parts: [{ text: `seed-normal-${tag}` }] },
          { role: 'model', parts: [{ functionCall: { name: 'exec_command', args: { cmd: 'echo 1' }, id: 'fc_n_0' } }] }
        ]
      }
    };
    const sid = extractAntigravityGeminiSessionIdWithNative(payload);
    seedSignature(aliasKeyNormal, sid, signature, `req_native_prepare_normal_seed_${tag}`);

    const out = runGeminiCliReq(payload, { aliasKey: aliasKeyNormal }, `req_native_prepare_normal_${tag}`);
    const part = firstFunctionCallPartFromWrapped(out.payload);
    assert(part, 'expected a functionCall part (normal injection)');
    assert(part.thoughtSignature === signature, 'expected thoughtSignature injected (normal injection)');
  }

  {
    const basePayload = {
      model: 'gemini-3-pro',
      request: {
        contents: [{ role: 'user', parts: [{ text: `seed-lease-base-${tag}` }] }]
      }
    };
    const sidBase = extractAntigravityGeminiSessionIdWithNative(basePayload);
    seedSignature(aliasKeyLease, sidBase, signature2, `req_native_prepare_lease_seed_${tag}`);

    const leasePayload = {
      model: 'gemini-3-pro',
      request: {
        contents: [
          { role: 'user', parts: [{ text: `seed-lease-new-${tag}` }] },
          { role: 'model', parts: [{ functionCall: { name: 'exec_command', args: { cmd: 'pwd' }, id: 'fc_l_1' } }] }
        ]
      }
    };
    const sidNew = extractAntigravityGeminiSessionIdWithNative(leasePayload);
    assert(sidNew !== sidBase, 'expected different derived sid for leasing');

    const out = runGeminiCliReq(leasePayload, { aliasKey: aliasKeyLease }, `req_native_prepare_lease_${tag}`);
    const part = firstFunctionCallPartFromWrapped(out.payload);
    assert(part, 'expected a functionCall part (leasing)');
    assert(part.thoughtSignature === signature2, 'expected leased thoughtSignature injection');
  }

  {
    const requestIdSeed = `req_native_prepare_rewind_seed_${tag}`;
    const rewindPayloadSeed = {
      requestId: `agent-rewind-seed-${tag}`,
      userAgent: 'antigravity',
      contents: [
        { role: 'user', parts: [{ text: `seed-rewind-${tag}` }] },
        { role: 'assistant', parts: [{ text: 'a1' }] },
        { role: 'assistant', parts: [{ functionCall: { name: 'exec_command', args: { cmd: 'echo 2' }, id: 'fc_rw_0' } }] }
      ]
    };
    const outSeed = runReqOutboundStage3CompatWithNative({
      payload: structuredClone(rewindPayloadSeed),
      adapterContext: {
        providerProtocol: 'gemini-chat',
        requestId: requestIdSeed,
        providerId: 'antigravity',
        providerKey: `${aliasKeyRewind}.gemini-3-pro`,
        runtimeKey: aliasKeyRewind
      },
      explicitProfile: 'chat:gemini-cli'
    });
    assert(outSeed.appliedProfile === 'chat:gemini-cli', 'expected gemini-cli profile for rewind seed');

    runRespInboundStage3CompatWithNative({
      payload: {
        request_id: requestIdSeed,
        candidates: [{ content: { parts: [{ thoughtSignature: signature3 }] } }]
      },
      adapterContext: {
        providerProtocol: 'gemini-chat',
        requestId: requestIdSeed,
        providerId: 'antigravity',
        providerKey: `${aliasKeyRewind}.gemini-3-pro`,
        runtimeKey: aliasKeyRewind
      },
      explicitProfile: 'chat:gemini-cli'
    });

    const rewindPayloadLow = {
      requestId: `agent-rewind-low-${tag}`,
      userAgent: 'antigravity',
      contents: [
        { role: 'user', parts: [{ text: `seed-rewind-${tag}` }] },
        { role: 'assistant', parts: [{ functionCall: { name: 'exec_command', args: { cmd: 'echo 3' }, id: 'fc_rw_1' } }] }
      ]
    };
    const outLow = runReqOutboundStage3CompatWithNative({
      payload: rewindPayloadLow,
      adapterContext: {
        providerProtocol: 'gemini-chat',
        requestId: `req_native_prepare_rewind_low_${tag}`,
        providerId: 'antigravity',
        providerKey: `${aliasKeyRewind}.gemini-3-pro`,
        runtimeKey: aliasKeyRewind
      },
      explicitProfile: 'chat:gemini-cli'
    });
    const partLow = firstFunctionCallPartFromWrapped(outLow.payload);
    assert(partLow, 'expected functionCall part for rewind check');
    assert(
      partLow.thoughtSignature === undefined,
      'expected no thoughtSignature injection after rewind guard'
    );
  }

  {
    const recoveryPayload = {
      model: 'gemini-3-pro',
      request: {
        contents: [
          { role: 'user', parts: [{ text: `seed-recovery-${tag}` }] },
          {
            role: 'model',
            parts: [
              {
                thoughtSignature: 'stale_signature_should_be_stripped',
                functionCall: { name: 'exec_command', args: { cmd: 'echo 4' }, id: 'fc_rec_0' }
              }
            ]
          }
        ]
      }
    };

    const out = runGeminiCliReq(
      recoveryPayload,
      {
        aliasKey: aliasKeyRecovery,
        extra: { __rt: { antigravityThoughtSignatureRecovery: true } }
      },
      `req_native_prepare_recovery_${tag}`
    );
    const part = firstFunctionCallPartFromWrapped(out.payload);
    assert(part, 'expected functionCall part in recovery mode');
    assert(part.thoughtSignature === undefined, 'expected stale thoughtSignature stripped in recovery mode');

    const contents = out.payload?.request?.contents;
    const last = Array.isArray(contents) ? contents[contents.length - 1] : undefined;
    const hasRecoveryHint = Array.isArray(last?.parts)
      && last.parts.some((p) => typeof p?.text === 'string' && p.text.includes('[System Recovery]'));
    assert(hasRecoveryHint, 'expected recovery hint appended in recovery mode');
  }

  console.log('✅ antigravity thoughtSignature prepare+recovery passed');
}

main().catch((err) => {
  console.error(
    '❌ antigravity thoughtSignature prepare+recovery failed:',
    err && err.message ? err.message : err
  );
  process.exit(1);
});
