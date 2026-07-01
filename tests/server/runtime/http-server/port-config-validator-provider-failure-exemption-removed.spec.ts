import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizePortsConfig, validatePortConfigs } from '../../../../src/server/runtime/http-server/port-config-validator.js';
import type { PortConfig } from '../../../../src/server/runtime/http-server/port-config-types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const portConfigTypesSourcePath = path.resolve(
  __dirname,
  '../../../../src/server/runtime/http-server/port-config-types.ts'
);

describe('port-config-validator: providerFailureExemption removed', () => {
  it('does not keep providerFailureExemption in the port config type surface', () => {
    const source = fs.readFileSync(portConfigTypesSourcePath, 'utf8');

    expect(source).not.toContain('ProviderFailureExemption');
    expect(source).not.toContain('providerFailureExemption?:');
  });

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

  it('legacy single-port normalization is removed', () => {
    expect(() => normalizePortsConfig({
      port: 5557,
      host: '127.0.0.1',
      providerFailureExemption: 'single_binding_rethrow',
    })).toThrow('legacy single-port normalization has been removed');
  });
});
