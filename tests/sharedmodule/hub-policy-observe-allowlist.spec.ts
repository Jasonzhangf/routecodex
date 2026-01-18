import { recordHubPolicyObservation } from '../../sharedmodule/llmswitch-core/src/conversion/hub/policy/policy-engine.js';

describe('hub policy allowlist observation (provider_outbound only)', () => {
  it('records unexpected_field for disallowed top-level keys on provider_outbound', () => {
    const records: Array<{ stage: string; payload: any }> = [];
    const stageRecorder = {
      record(stage: string, payload: object) {
        records.push({ stage, payload });
      }
    };

    recordHubPolicyObservation({
      policy: { mode: 'observe' },
      phase: 'provider_outbound',
      providerProtocol: 'openai-chat',
      payload: { model: 'gpt-test', choices: [] } as any,
      stageRecorder,
      requestId: 'req_test'
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.stage).toBe('hub_policy.observe.provider_outbound');
    expect(Array.isArray(records[0]?.payload?.violations)).toBe(true);
    expect(records[0]?.payload?.violations?.some((v: any) => v.path === 'choices')).toBe(true);
  });

  it('does not apply allowlist checks on provider_inbound', () => {
    const records: Array<{ stage: string; payload: any }> = [];
    const stageRecorder = {
      record(stage: string, payload: object) {
        records.push({ stage, payload });
      }
    };

    recordHubPolicyObservation({
      policy: { mode: 'observe' },
      phase: 'provider_inbound',
      providerProtocol: 'openai-chat',
      payload: { choices: [] } as any,
      stageRecorder,
      requestId: 'req_test'
    });

    expect(records).toHaveLength(0);
  });
});

