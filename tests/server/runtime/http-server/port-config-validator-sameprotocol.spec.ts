import { describe, expect, it } from '@jest/globals';
import { validatePortConfigs, normalizePortsConfig } from '../../../../src/server/runtime/http-server/port-config-validator.js';

describe('port-config-validator: sameProtocolBehavior', () => {
  describe('validatePortConfigs', () => {
    it('allows router mode with sameProtocolBehavior=direct', () => {
      const result = validatePortConfigs([{
        port: 5520, host: '0.0.0.0', mode: 'router',
        routingPolicyGroup: 'default', sameProtocolBehavior: 'direct',
      }]);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('allows router mode with sameProtocolBehavior=relay', () => {
      const result = validatePortConfigs([{
        port: 5520, host: '0.0.0.0', mode: 'router',
        routingPolicyGroup: 'default', sameProtocolBehavior: 'relay',
      }]);
      expect(result.valid).toBe(true);
    });

    it('rejects router mode with invalid sameProtocolBehavior', () => {
      const result = validatePortConfigs([{
        port: 5520, host: '0.0.0.0', mode: 'router',
        routingPolicyGroup: 'default', sameProtocolBehavior: 'invalid' as any,
      }]);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === 'sameProtocolBehavior')).toBe(true);
    });

    it('rejects provider mode with sameProtocolBehavior', () => {
      const result = validatePortConfigs([{
        port: 5555, host: '0.0.0.0', mode: 'provider',
        providerBinding: 'openai.gpt-4', protocolBehavior: 'auto',
        sameProtocolBehavior: 'direct' as any,
      }]);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === 'sameProtocolBehavior')).toBe(true);
    });

    it('allows router mode without sameProtocolBehavior (defaults to direct)', () => {
      const result = validatePortConfigs([{
        port: 5520, host: '0.0.0.0', mode: 'router',
        routingPolicyGroup: 'default',
      }]);
      expect(result.valid).toBe(true);
    });
  });

  describe('normalizePortsConfig', () => {
    it('extracts sameProtocolBehavior from httpserver config', () => {
      const configs = normalizePortsConfig({
        port: 5520, host: '0.0.0.0', sameProtocolBehavior: 'relay',
      });
      expect(configs).toHaveLength(1);
      expect(configs[0].sameProtocolBehavior).toBe('relay');
    });

    it('defaults to direct when sameProtocolBehavior is valid', () => {
      const configs = normalizePortsConfig({
        port: 5520, host: '0.0.0.0', sameProtocolBehavior: 'direct',
      });
      expect(configs[0].sameProtocolBehavior).toBe('direct');
    });

    it('ignores invalid sameProtocolBehavior values', () => {
      const configs = normalizePortsConfig({
        port: 5520, host: '0.0.0.0', sameProtocolBehavior: 'invalid',
      } as any);
      expect(configs[0].sameProtocolBehavior).toBeUndefined();
    });

    it('defaults router mode for legacy configs without ports array', () => {
      const configs = normalizePortsConfig({ port: 8080, host: '0.0.0.0' });
      expect(configs).toHaveLength(1);
      expect(configs[0].mode).toBe('router');
      expect(configs[0].routingPolicyGroup).toBe('default');
    });
  });
});
