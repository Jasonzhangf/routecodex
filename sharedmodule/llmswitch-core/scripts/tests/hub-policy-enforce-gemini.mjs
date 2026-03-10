#!/usr/bin/env node
import assert from 'node:assert/strict';

import { applyHubProviderOutboundPolicy } from '../../dist/conversion/hub/policy/policy-engine.js';

function main() {
  const input = {
    model: 'gemini-test',
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    extraTopLevel: 'must_drop',
    _private: 'must_strip',
    __internal: 'must_strip'
  };

  const out = applyHubProviderOutboundPolicy({
    policy: { mode: 'enforce' },
    providerProtocol: 'gemini-chat',
    payload: input
  });

  assert.equal(typeof out, 'object');
  assert.equal(Array.isArray(out), false);
  assert.equal('_private' in out, false);
  assert.equal('__internal' in out, false);
  assert.equal('extraTopLevel' in out, false);
  assert.equal(out.model, 'gemini-test');
  assert.equal(Array.isArray(out.contents), true);

  console.log('✅ hub policy enforce (gemini-chat) passed');
}

main();
