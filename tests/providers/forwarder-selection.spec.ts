/**
 * ProviderForwarder loader 单测
 *
 * 覆盖：
 * - 解析 forwarders 节点
 * - 命名空间校验（fwd. 前缀）
 * - 引用不存在的 providerId 失败
 * - 同一 (protocol, model) 双 forwarder 失败
 * - fwd id 含点号但 model 显式（不 split 推算）
 * - transportOverride 拒绝（hard guardrail）
 * - 抽出 knownProviderIds 用于 sanity check
 */

import {
  buildForwarderProfiles,
  validateForwarderId,
  FORWARDER_ID_PREFIX,
} from '../../src/providers/profile/forwarder-types-adapter.js';

describe('ProviderForwarder loader', () => {
  describe('validateForwarderId', () => {
    it('accepts well-formed forwarder id', () => {
      expect(validateForwarderId('fwd.openai.gpt-4o').ok).toBe(true);
      expect(validateForwarderId('fwd.openai.gpt-4.1').ok).toBe(true);
      expect(validateForwarderId('fwd.openai.claude-sonnet-4-5').ok).toBe(true);
    });

    it('rejects non-fwd prefix', () => {
      const result = validateForwarderId('openai.key1');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('fwd.');
      }
    });

    it('rejects empty id after prefix', () => {
      const result = validateForwarderId(FORWARDER_ID_PREFIX);
      expect(result.ok).toBe(false);
    });
  });

  describe('buildForwarderProfiles', () => {
    const knownIds = new Set([
      'openai-prod-1',
      'openai-prod-2',
      'azure-gpt-4o',
      'openrouter-gpt4',
    ]);

    it('parses weighted forwarder with explicit model', () => {
      const config = {
        forwarders: {
          'fwd.openai.gpt-4o': {
            protocol: 'openai',
            model: 'gpt-4o',
            resolutionMode: 'model-first',
            strategy: 'weighted',
            weights: { 'openai-prod-1': 5, 'openai-prod-2': 3 },
            targets: [
              { providerId: 'openai-prod-1', weight: 5 },
              { providerId: 'openai-prod-2', weight: 3 },
            ],
            stickyKey: 'session',
          },
        },
      };
      const result = buildForwarderProfiles(config, knownIds);
      expect(result.profiles).toHaveLength(1);
      const profile = result.profiles[0];
      expect(profile.id).toBe('fwd.openai.gpt-4o');
      expect(profile.protocol).toBe('openai');
      expect(profile.model).toBe('gpt-4o');
      expect(profile.strategy).toBe('weighted');
      expect(profile.stickyKey).toBe('session');
      expect(profile.targets).toHaveLength(2);
    });

    it('preserves dotted model name without semantic split', () => {
      const config = {
        forwarders: {
          'fwd.openai.gpt-4.1': {
            protocol: 'openai',
            model: 'gpt-4.1',
            strategy: 'round-robin',
            targets: [{ providerId: 'openai-prod-1' }],
          },
        },
      };
      const result = buildForwarderProfiles(config, knownIds);
      expect(result.profiles[0].model).toBe('gpt-4.1');
      // 显式 model 字段独立于 id
      expect(result.profiles[0].id).toBe('fwd.openai.gpt-4.1');
    });

    it('rejects unknown providerId reference', () => {
      const config = {
        forwarders: {
          'fwd.openai.gpt-4o': {
            protocol: 'openai',
            model: 'gpt-4o',
            targets: [{ providerId: 'unknown-provider' }],
          },
        },
      };
      expect(() => buildForwarderProfiles(config, knownIds)).toThrow(/unknown providerId/);
    });

    it('rejects duplicate forwarder for same (protocol, model)', () => {
      const config = {
        forwarders: {
          'fwd.openai.gpt-4o-a': {
            protocol: 'openai',
            model: 'gpt-4o',
            targets: [{ providerId: 'openai-prod-1' }],
          },
          'fwd.openai.gpt-4o-b': {
            protocol: 'openai',
            model: 'gpt-4o',
            targets: [{ providerId: 'openai-prod-2' }],
          },
        },
      };
      expect(() => buildForwarderProfiles(config, knownIds)).toThrow(/duplicate forwarder/);
    });

    it('rejects transportOverride (hard guardrail)', () => {
      const config = {
        forwarders: {
          'fwd.openai.gpt-4o': {
            protocol: 'openai',
            model: 'gpt-4o',
            targets: [{ providerId: 'openai-prod-1' }],
            transportOverride: { timeout: 1000 },
          },
        },
      };
      expect(() => buildForwarderProfiles(config, knownIds)).toThrow(/transportOverride/);
    });

    it('rejects non-fwd id', () => {
      const config = {
        forwarders: {
          'openai.gpt-4o': {
            protocol: 'openai',
            model: 'gpt-4o',
            targets: [{ providerId: 'openai-prod-1' }],
          },
        },
      };
      expect(() => buildForwarderProfiles(config, knownIds)).toThrow(/fwd\./);
    });

    it('rejects empty targets', () => {
      const config = {
        forwarders: {
          'fwd.openai.gpt-4o': {
            protocol: 'openai',
            model: 'gpt-4o',
            targets: [],
          },
        },
      };
      expect(() => buildForwarderProfiles(config, knownIds)).toThrow(/no enabled targets/);
    });
  });
});
