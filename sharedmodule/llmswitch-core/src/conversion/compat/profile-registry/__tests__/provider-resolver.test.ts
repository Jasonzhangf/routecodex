import { describe, expect, test, beforeAll } from '@jest/globals';
import path from 'node:path';
import fs from 'node:fs';
import {
  detectProviderTypeFromConfig,
  resolveOutboundProfileFromConfig,
  resolveDefaultCompatibilityProfileFromConfig
} from '../provider-resolver.js';
import type { ProviderResolutionConfig } from '../types.js';

describe('provider-resolver: config-driven resolution', () => {
  const configDir = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const configPath = path.join(configDir, 'provider-resolution-config.json');
  let config: ProviderResolutionConfig;

  beforeAll(() => {
    const raw = fs.readFileSync(configPath, 'utf-8');
    config = JSON.parse(raw) as ProviderResolutionConfig;
  });

  // =========================================================================
  // detectProviderTypeFromConfig — mirrors detectProviderType behavior
  // =========================================================================
  describe('detectProviderTypeFromConfig', () => {
    test('returns anthropic when type contains anthropic', () => {
      expect(detectProviderTypeFromConfig(config, { type: 'anthropic' })).toBe('anthropic');
    });

    test('returns anthropic when type contains claude', () => {
      expect(detectProviderTypeFromConfig(config, { type: 'claude' })).toBe('anthropic');
    });

    test('returns responses when type contains responses', () => {
      expect(detectProviderTypeFromConfig(config, { type: 'responses' })).toBe('responses');
    });

    test('returns gemini when type contains gemini', () => {
      expect(detectProviderTypeFromConfig(config, { type: 'gemini' })).toBe('gemini');
    });

    test('returns qwen when type contains qwen', () => {
      expect(detectProviderTypeFromConfig(config, { type: 'qwen' })).toBe('qwen');
    });

    test('returns glm when type contains glm', () => {
      expect(detectProviderTypeFromConfig(config, { type: 'glm' })).toBe('glm');
    });

    test('returns lmstudio when type contains lmstudio', () => {
      expect(detectProviderTypeFromConfig(config, { type: 'lmstudio' })).toBe('lmstudio');
    });

    test('returns openai when type is openai', () => {
      expect(detectProviderTypeFromConfig(config, { type: 'openai' })).toBe('openai');
    });

    test('returns default provider type when no fields are set', () => {
      expect(detectProviderTypeFromConfig(config, {})).toBe('openai');
    });

    test('detects type from providerId when type field is absent', () => {
      expect(detectProviderTypeFromConfig(config, { id: 'anthropic-provider' })).toBe('anthropic');
    });

    test('detects type from protocol field', () => {
      expect(detectProviderTypeFromConfig(config, { protocol: 'responses' })).toBe('responses');
    });

    test('combined raw|id lexicon matches keyword in either', () => {
      // raw is empty, id has 'gemini-cli' → should match 'gemini'
      expect(detectProviderTypeFromConfig(config, { id: 'gemini-cli' })).toBe('gemini');
    });

    test('returns raw when no keyword matches', () => {
      expect(detectProviderTypeFromConfig(config, { type: 'custom-protocol' })).toBe('custom-protocol');
    });

    test('mirrors the original detectProviderType for ali-coding-plan (anthropic)', () => {
      const result = detectProviderTypeFromConfig(config, {
        providerType: 'anthropic',
        providerId: 'ali-coding-plan'
      });
      expect(result).toBe('anthropic');
    });

    test('mirrors the original detectProviderType for qwenchat', () => {
      const result = detectProviderTypeFromConfig(config, {
        type: 'openai',
        id: 'qwenchat'
      });
      // 'qwenchat' in id → matches 'qwen' keyword
      expect(result).toBe('qwen');
    });
  });

  // =========================================================================
  // resolveOutboundProfileFromConfig — mirrors mapOutboundProfile behavior
  // =========================================================================
  describe('resolveOutboundProfileFromConfig', () => {
    test('anthropic → anthropic-messages', () => {
      expect(resolveOutboundProfileFromConfig(config, 'anthropic')).toBe('anthropic-messages');
    });

    test('responses → openai-responses', () => {
      expect(resolveOutboundProfileFromConfig(config, 'responses')).toBe('openai-responses');
    });

    test('gemini → gemini-chat', () => {
      expect(resolveOutboundProfileFromConfig(config, 'gemini')).toBe('gemini-chat');
    });

    test('qwen → openai-chat (default)', () => {
      expect(resolveOutboundProfileFromConfig(config, 'qwen')).toBe('openai-chat');
    });

    test('glm → openai-chat (default)', () => {
      expect(resolveOutboundProfileFromConfig(config, 'glm')).toBe('openai-chat');
    });

    test('openai → openai-chat', () => {
      expect(resolveOutboundProfileFromConfig(config, 'openai')).toBe('openai-chat');
    });

    test('case-insensitive', () => {
      expect(resolveOutboundProfileFromConfig(config, 'ANTHROPIC')).toBe('anthropic-messages');
    });

    test('unknown type → default', () => {
      expect(resolveOutboundProfileFromConfig(config, 'unknown-type')).toBe('openai-chat');
    });
  });

  // =========================================================================
  // resolveDefaultCompatibilityProfileFromConfig — mirrors resolveCompatibilityProfile
  // =========================================================================
  describe('resolveDefaultCompatibilityProfileFromConfig', () => {
    test('providerId "antigravity" → chat:gemini-cli', () => {
      expect(resolveDefaultCompatibilityProfileFromConfig(config, 'antigravity', {})).toBe('chat:gemini-cli');
    });

    test('providerId "gemini-cli" → chat:gemini-cli', () => {
      expect(resolveDefaultCompatibilityProfileFromConfig(config, 'gemini-cli', {})).toBe('chat:gemini-cli');
    });

    test('providerId case-insensitive "Antigravity" → chat:gemini-cli', () => {
      expect(resolveDefaultCompatibilityProfileFromConfig(config, 'Antigravity', {})).toBe('chat:gemini-cli');
    });

    test('providerType contains "antigravity" → chat:gemini-cli', () => {
      expect(resolveDefaultCompatibilityProfileFromConfig(config, 'some-provider', { type: 'antigravity-oauth' })).toBe('chat:gemini-cli');
    });

    test('providerType contains "gemini-cli" → chat:gemini-cli', () => {
      expect(resolveDefaultCompatibilityProfileFromConfig(config, 'some-provider', { protocol: 'gemini-cli-proxy' })).toBe('chat:gemini-cli');
    });

    test('default → compat:passthrough when no block matches', () => {
      expect(resolveDefaultCompatibilityProfileFromConfig(config, 'openai-provider', { type: 'openai' })).toBe('compat:passthrough');
    });

    test('default → compat:passthrough for empty provider', () => {
      expect(resolveDefaultCompatibilityProfileFromConfig(config, 'unknown', {})).toBe('compat:passthrough');
    });
  });
});
