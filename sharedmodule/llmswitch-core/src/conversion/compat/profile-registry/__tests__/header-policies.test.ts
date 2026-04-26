import { describe, expect, test } from '@jest/globals';
import { applyHeaderPolicies } from '../header-policies.js';
import type { HeaderPolicyRule } from '../types.js';

describe('applyHeaderPolicies', () => {
  test('returns original headers when rules are empty/undefined', () => {
    const existing = { 'X-Existing': 'yes' };
    expect(applyHeaderPolicies(existing, undefined, { providerId: 'qwen', providerType: 'openai' })).toBe(existing);
    expect(applyHeaderPolicies(existing, [], { providerId: 'qwen', providerType: 'openai' })).toBe(existing);
  });

  test('returns undefined when no rules match and no existing headers', () => {
    const rules: HeaderPolicyRule[] = [
      { when: { providerId: 'other' }, setIfMissing: { 'X-Foo': 'bar' } }
    ];
    expect(applyHeaderPolicies(undefined, rules, { providerId: 'qwen', providerType: 'openai' })).toBeUndefined();
  });

  test('setIfMissing only sets when key absent (case-insensitive check)', () => {
    const rules: HeaderPolicyRule[] = [
      { when: { providerId: 'qwen' }, setIfMissing: { 'X-DashScope-AuthType': 'qwen-oauth' } }
    ];
    // No existing headers → key is set
    const result1 = applyHeaderPolicies(undefined, rules, { providerId: 'qwen', providerType: 'openai' });
    expect(result1).toEqual({ 'X-DashScope-AuthType': 'qwen-oauth' });

    // Already present (same case) → not overwritten
    const result2 = applyHeaderPolicies({ 'X-DashScope-AuthType': 'existing' }, rules, { providerId: 'qwen', providerType: 'openai' });
    expect(result2).toEqual({ 'X-DashScope-AuthType': 'existing' });

    // Already present (different case) → not overwritten
    const result3 = applyHeaderPolicies({ 'x-dashscope-authtype': 'existing' }, rules, { providerId: 'qwen', providerType: 'openai' });
    expect(result3).toEqual({ 'x-dashscope-authtype': 'existing' });
  });

  test('set unconditionally overwrites', () => {
    const rules: HeaderPolicyRule[] = [
      { when: { providerId: 'qwen' }, set: { 'X-Force': 'overwritten' } }
    ];
    const result = applyHeaderPolicies({ 'X-Force': 'original' }, rules, { providerId: 'qwen', providerType: 'openai' });
    expect(result).toEqual({ 'X-Force': 'overwritten' });
  });

  test('when.providerId matching is case-insensitive', () => {
    const rules: HeaderPolicyRule[] = [
      { when: { providerId: 'qwen' }, setIfMissing: { 'X-Test': 'yes' } }
    ];
    expect(applyHeaderPolicies(undefined, rules, { providerId: 'QWEN', providerType: 'openai' })).toEqual({ 'X-Test': 'yes' });
    expect(applyHeaderPolicies(undefined, rules, { providerId: 'other', providerType: 'openai' })).toBeUndefined();
  });

  test('when.providerTypeContains matching', () => {
    const rules: HeaderPolicyRule[] = [
      { when: { providerTypeContains: 'anthropic' }, setIfMissing: { 'X-App': 'claude-cli' } }
    ];
    expect(applyHeaderPolicies(undefined, rules, { providerId: 'some', providerType: 'anthropic-oauth' })).toEqual({ 'X-App': 'claude-cli' });
    expect(applyHeaderPolicies(undefined, rules, { providerId: 'some', providerType: 'openai' })).toBeUndefined();
  });

  test('combined when conditions must ALL match', () => {
    const rules: HeaderPolicyRule[] = [
      { when: { providerId: 'qwen', providerTypeContains: 'anthropic' }, setIfMissing: { 'X-Both': 'yes' } }
    ];
    // Matches both
    expect(applyHeaderPolicies(undefined, rules, { providerId: 'qwen', providerType: 'anthropic' })).toEqual({ 'X-Both': 'yes' });
    // Only one matches
    expect(applyHeaderPolicies(undefined, rules, { providerId: 'qwen', providerType: 'openai' })).toBeUndefined();
    expect(applyHeaderPolicies(undefined, rules, { providerId: 'other', providerType: 'anthropic' })).toBeUndefined();
  });

  test('multiple rules fire in order, later rules can overwrite earlier setIfMissing via set', () => {
    const rules: HeaderPolicyRule[] = [
      { when: { providerId: 'qwen' }, setIfMissing: { 'X-A': 'first' } },
      { when: { providerId: 'qwen' }, set: { 'X-A': 'overwritten' } }
    ];
    const result = applyHeaderPolicies(undefined, rules, { providerId: 'qwen', providerType: 'openai' });
    expect(result).toEqual({ 'X-A': 'overwritten' });
  });

  test('preserves existing headers not touched by rules', () => {
    const existing = { 'X-Existing': 'keep' };
    const rules: HeaderPolicyRule[] = [
      { when: { providerId: 'qwen' }, setIfMissing: { 'X-New': 'added' } }
    ];
    const result = applyHeaderPolicies(existing, rules, { providerId: 'qwen', providerType: 'openai' });
    expect(result).toEqual({ 'X-Existing': 'keep', 'X-New': 'added' });
  });

  test('qwen header injection mirrors hardcoded behavior', () => {
    // This test mirrors maybeInjectQwenHeaders exactly
    const rules: HeaderPolicyRule[] = [
      { when: { providerId: 'qwen' }, setIfMissing: {
        'X-DashScope-UserAgent': 'QwenCode/0.14.3 (darwin; arm64)',
        'X-DashScope-CacheControl': 'enable',
        'X-DashScope-AuthType': 'qwen-oauth',
        'User-Agent': 'QwenCode/0.14.3 (darwin; arm64)'
      }}
    ];

    // No existing headers
    const result = applyHeaderPolicies(undefined, rules, { providerId: 'qwen', providerType: 'openai' });
    expect(result).toEqual({
      'X-DashScope-UserAgent': 'QwenCode/0.14.3 (darwin; arm64)',
      'X-DashScope-CacheControl': 'enable',
      'X-DashScope-AuthType': 'qwen-oauth',
      'User-Agent': 'QwenCode/0.14.3 (darwin; arm64)'
    });

    // With existing User-Agent
    const result2 = applyHeaderPolicies({ 'User-Agent': 'custom-agent' }, rules, { providerId: 'qwen', providerType: 'openai' });
    expect(result2!['User-Agent']).toBe('custom-agent');
    expect(result2!['X-DashScope-AuthType']).toBe('qwen-oauth');
  });

  test('claude-code header injection mirrors hardcoded behavior', () => {
    const rules: HeaderPolicyRule[] = [
      { when: { providerTypeContains: 'anthropic' }, setIfMissing: {
        'User-Agent': 'claude-cli/2.0.76 (external, cli)',
        'X-App': 'claude-cli',
        'anthropic-beta': 'claude-code'
      }}
    ];

    const result = applyHeaderPolicies(undefined, rules, { providerId: 'some', providerType: 'anthropic-oauth' });
    expect(result).toEqual({
      'User-Agent': 'claude-cli/2.0.76 (external, cli)',
      'X-App': 'claude-cli',
      'anthropic-beta': 'claude-code'
    });
  });
});
