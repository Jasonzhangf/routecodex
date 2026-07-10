import {
  consumeResponsesPayloadSnapshotByAliasesWithNative as consumeResponsesPayloadSnapshotByAliases,
  consumeResponsesPassthroughWithNative as consumeResponsesPassthrough,
  consumeResponsesPassthroughByAliasesWithNative as consumeResponsesPassthroughByAliases,
  consumeResponsesPayloadSnapshotWithNative as consumeResponsesPayloadSnapshot,
  registerResponsesPassthroughWithNative as registerResponsesPassthrough,
  registerResponsesPayloadSnapshotWithNative as registerResponsesPayloadSnapshot
} from './helpers/resp-semantics-direct-native.js';

describe('responses registry pruning', () => {
  it('registers and consumes payload snapshots through native registry', () => {
    registerResponsesPayloadSnapshot('resp-roundtrip', {
      id: 'resp-roundtrip',
      object: 'response',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }]
    });

    expect(consumeResponsesPayloadSnapshot('resp-roundtrip')).toMatchObject({
      id: 'resp-roundtrip',
      object: 'response'
    });
    expect(consumeResponsesPayloadSnapshot('resp-roundtrip')).toBeUndefined();
  });

  it('consumes and clears all alias keys for retained payload snapshots and passthrough payloads', () => {
    const snapshot = {
      id: 'resp-alias',
      request_id: 'req-alias',
      object: 'response'
    };
    const passthrough = {
      id: 'resp-alias',
      request_id: 'req-alias',
      choices: [{ message: { role: 'assistant', content: 'ok' } }]
    };

    registerResponsesPayloadSnapshot('resp-alias', snapshot, { clone: false });
    registerResponsesPayloadSnapshot('req-alias', snapshot, { clone: false });
    registerResponsesPassthrough('resp-alias', passthrough, { clone: false });
    registerResponsesPassthrough('req-alias', passthrough, { clone: false });

    expect(consumeResponsesPayloadSnapshotByAliases(['req-alias', 'resp-alias'])).toMatchObject({
      id: 'resp-alias',
      request_id: 'req-alias'
    });
    expect(consumeResponsesPassthroughByAliases(['req-alias', 'resp-alias'])).toMatchObject({
      id: 'resp-alias',
      request_id: 'req-alias'
    });

    expect(consumeResponsesPayloadSnapshot('req-alias')).toBeUndefined();
    expect(consumeResponsesPayloadSnapshot('resp-alias')).toBeUndefined();
    expect(consumeResponsesPassthrough('req-alias')).toBeUndefined();
    expect(consumeResponsesPassthrough('resp-alias')).toBeUndefined();
  });
});
