import { describe, expect, it } from '@jest/globals';
import {
  validatePortConfigs,
  normalizePortsConfig,
} from '../../../../src/server/runtime/http-server/port-config-validator.js';

describe('port-config-validator: providerFailureExemption (G10)', () => {
  it('[forward] provider-mode may declare providerFailureExemption=single_binding_rethrow', () => {
    const result = validatePortConfigs([{
      port: 5555,
      host: '0.0.0.0',
      mode: 'provider',
      providerBinding: 'openai.gpt-4',
      protocolBehavior: 'auto',
      providerFailureExemption: 'single_binding_rethrow',
    }]);
    expect(result.valid).toBe(true);
  });

  it('[reverse] router-mode must NOT declare providerFailureExemption=single_binding_rethrow', () => {
    const result = validatePortConfigs([{
      port: 5520,
      host: '0.0.0.0',
      mode: 'router',
      routingPolicyGroup: 'default',
      providerFailureExemption: 'single_binding_rethrow',
    }]);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'providerFailureExemption')).toBe(true);
  });

  it('[reverse] provider-mode with invalid providerFailureExemption value is rejected', () => {
    const result = validatePortConfigs([{
      port: 5555,
      host: '0.0.0.0',
      mode: 'provider',
      providerBinding: 'openai.gpt-4',
      protocolBehavior: 'auto',
      providerFailureExemption: 'auto_retry' as never,
    }]);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'providerFailureExemption')).toBe(true);
  });

  it('normalizePortsConfig preserves providerFailureExemption for provider-mode ports', () => {
    const configs = normalizePortsConfig({
      ports: [{
        port: 5555,
        host: '0.0.0.0',
        mode: 'provider',
        providerBinding: 'openai.gpt-4',
        protocolBehavior: 'auto',
        providerFailureExemption: 'single_binding_rethrow',
      }],
    } as never);
    expect(configs).toHaveLength(1);
    expect(configs[0].providerFailureExemption).toBe('single_binding_rethrow');
  });
});
