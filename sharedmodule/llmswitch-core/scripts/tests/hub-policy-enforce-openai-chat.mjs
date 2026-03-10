#!/usr/bin/env node
import assert from 'node:assert/strict';

import { applyHubProviderOutboundPolicy } from '../../dist/conversion/hub/policy/policy-engine.js';

function main() {
  const input = {
    model: 'gpt-test',
    request: {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }],
      metadata: { ok: true }
    },
    parameters: {
      temperature: 0.2,
      top_p: 0.9,
      max_output_tokens: 12,
      unknown_param: 'nope'
    },
    extraTopLevel: 'must_drop',
    _private: 'must_strip',
    __internal: 'must_strip'
  };

  const out = applyHubProviderOutboundPolicy({
    policy: { mode: 'enforce' },
    providerProtocol: 'openai-chat',
    payload: input
  });

  assert.equal(typeof out, 'object');
  assert.equal(Array.isArray(out), false);
  assert.equal('request' in out, false);
  assert.equal('parameters' in out, false);
  assert.equal('_private' in out, false);
  assert.equal('__internal' in out, false);
  assert.equal('extraTopLevel' in out, false);

  // request wrapper should be flattened (model/messages/metadata)
  assert.equal(out.model, 'gpt-test');
  assert.equal(Array.isArray(out.messages), true);
  assert.deepEqual(out.metadata, { ok: true });

  // parameters wrapper should be flattened and mapped
  assert.equal(out.max_tokens, 12);
  assert.equal(out.temperature, 0.2);
  assert.equal(out.top_p, 0.9);
  assert.equal('unknown_param' in out, false);

  console.log('✅ hub policy enforce (openai-chat) passed');
}

main();
