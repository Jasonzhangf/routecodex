import { describe, expect, it } from '@jest/globals';
import { normalizePortsConfig, validatePortConfigs } from '../../../../src/server/runtime/http-server/port-config-validator.js';
import type { PortConfig } from '../../../../src/server/runtime/http-server/port-config-types.js';

describe('port-config-validator: providerFailureExemption removed', () => {
  it('rejects providerFailureExemption on provider-mode ports', () => {
    const config = {
      port: 5555,
      host: '127.0.0.1',
      mode: 'provider',
      providerBinding: 'mock.gpt',
      protocolBehavior: 'auto',
      providerFailureExemption: 'single_binding_rethrow',
    } as unknown as PortConfig;

    const result = validatePortConfigs([config]);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: 'providerFailureExemption',
        message: expect.stringContaining('removed'),
      }),
    ]));
  });

  it('rejects providerFailureExemption on router-mode ports', () => {
    const config = {
      port: 5556,
      host: '127.0.0.1',
      mode: 'router',
      routingPolicyGroup: 'default',
      providerFailureExemption: 'single_binding_rethrow',
    } as unknown as PortConfig;

    const result = validatePortConfigs([config]);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: 'providerFailureExemption',
        message: expect.stringContaining('removed'),
      }),
    ]));
  });

  it('legacy single-port normalization does not create providerFailureExemption', () => {
    const configs = normalizePortsConfig({
      port: 5557,
      host: '127.0.0.1',
      providerFailureExemption: 'single_binding_rethrow',
    });

    expect(configs).toHaveLength(1);
    expect(configs[0]).not.toHaveProperty('providerFailureExemption');
    expect(validatePortConfigs(configs).valid).toBe(true);
  });
});
