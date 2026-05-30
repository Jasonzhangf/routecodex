import { applyHubProviderOutboundPolicy } from '../../sharedmodule/llmswitch-core/src/conversion/hub/policy/policy-engine.js';

describe('hub provider outbound reasoning field filter', () => {
  it('strips Responses input reasoning content even when policy enforcement is off', () => {
    const payload = {
      model: 'gpt-5.5',
      input: [
        {
          type: 'reasoning',
          content: [{ type: 'reasoning_text', text: 'must not leave outbound with policy off' }]
        }
      ]
    } as any;

    const out = applyHubProviderOutboundPolicy({
      policy: { mode: 'off' },
      providerProtocol: 'openai-responses',
      payload,
      requestId: 'req_cc_reasoning_filter_policy_off'
    }) as any;

    expect(out.input[0].content).toBeUndefined();
  });

  it('strips Responses input reasoning content for non-DeepSeek providers', () => {
    const payload = {
      model: 'gpt-5.5',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        {
          type: 'reasoning',
          content: [{ type: 'reasoning_text', text: 'must not leave outbound' }],
          summary: [{ type: 'summary_text', text: 'summary stays' }],
          encrypted_content: null
        }
      ],
      stream: true
    } as any;

    const out = applyHubProviderOutboundPolicy({
      policy: { mode: 'enforce' },
      providerProtocol: 'openai-responses',
      payload,
      requestId: 'req_cc_reasoning_filter'
    }) as any;

    expect(out.input[1].type).toBe('reasoning');
    expect(out.input[1].content).toBeUndefined();
    expect(out.input[1].encrypted_content).toBeUndefined();
    expect(out.input[1].summary).toEqual([{ type: 'summary_text', text: 'summary stays' }]);
  });

  it('preserves Responses input reasoning content for DeepSeek compat', () => {
    const payload = {
      model: 'deepseek-reasoner',
      input: [
        {
          type: 'reasoning',
          content: [{ type: 'reasoning_text', text: 'deepseek compat keeps this' }]
        }
      ]
    } as any;

    const out = applyHubProviderOutboundPolicy({
      policy: { mode: 'enforce' },
      providerProtocol: 'openai-responses',
      compatibilityProfile: 'chat:deepseek',
      payload,
      requestId: 'req_deepseek_reasoning_filter'
    }) as any;

    expect(out.input[0].content).toEqual([{ type: 'reasoning_text', text: 'deepseek compat keeps this' }]);
  });
});
