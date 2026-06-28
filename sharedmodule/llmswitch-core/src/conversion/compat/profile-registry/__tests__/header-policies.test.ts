import { describe, expect, test } from '@jest/globals';
import { applyHeaderPolicies } from '../header-policies.js';
import type { HeaderPolicyRule } from '../types.js';

describe('applyHeaderPolicies', () => {
  test('returns original headers when rules are empty/undefined', () => {
    const existing = { 'X-Existing': 'yes' };
    expect(applyHeaderPolicies(existing, undefined, { providerId: 'custom', providerType: 'openai' })).toBe(existing);
    expect(applyHeaderPolicies(existing, [], { providerId: 'custom', providerType: 'openai' })).toBe(existing);
  });

  test('returns undefined when no rules match and no existing headers', () => {
    const rules: HeaderPolicyRule[] = [
      { when: { providerId: 'other' }, setIfMissing: { 'X-Foo': 'bar' } }
    ];
    expect(applyHeaderPolicies(undefined, rules, { providerId: 'custom', providerType: 'openai' })).toBeUndefined();
  });

  test('setIfMissing only sets when key absent (case-insensitive check)', () => {
    const rules: HeaderPolicyRule[] = [
      { when: { providerId: 'custom' }, setIfMissing: { 'X-Custom-Auth': 'apikey' } }
    ];
    // No existing headers → key is set
    const result1 = applyHeaderPolicies(undefined, rules, { providerId: 'custom', providerType: 'openai' });
    expect(result1).toEqual({ 'X-Custom-Auth': 'apikey' });

    // Already present (same case) → not overwritten
    const result2 = applyHeaderPolicies({ 'X-Custom-Auth': 'existing' }, rules, { providerId: 'custom', providerType: 'openai' });
    expect(result2).toEqual({ 'X-Custom-Auth': 'existing' });

    // Already present (different case) → not overwritten
    const result3 = applyHeaderPolicies({ 'x-custom-auth': 'existing' }, rules, { providerId: 'custom', providerType: 'openai' });
    expect(result3).toEqual({ 'x-custom-auth': 'existing' });
  });

  test('set unconditionally overwrites', () => {
    const rules: HeaderPolicyRule[] = [
      { when: { providerId: 'custom' }, set: { 'X-Force': 'overwritten' } }
    ];
    const result = applyHeaderPolicies({ 'X-Force': 'original' }, rules, { providerId: 'custom', providerType: 'openai' });
    expect(result).toEqual({ 'X-Force': 'overwritten' });
  });

  test('when.providerId matching is case-insensitive', () => {
    const rules: HeaderPolicyRule[] = [
      { when: { providerId: 'custom' }, setIfMissing: { 'X-Test': 'yes' } }
    ];
    expect(applyHeaderPolicies(undefined, rules, { providerId: 'CUSTOM', providerType: 'openai' })).toEqual({ 'X-Test': 'yes' });
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
      { when: { providerId: 'custom', providerTypeContains: 'anthropic' }, setIfMissing: { 'X-Both': 'yes' } }
    ];
    // Matches both
    expect(applyHeaderPolicies(undefined, rules, { providerId: 'custom', providerType: 'anthropic' })).toEqual({ 'X-Both': 'yes' });
    // Only one matches
    expect(applyHeaderPolicies(undefined, rules, { providerId: 'custom', providerType: 'openai' })).toBeUndefined();
    expect(applyHeaderPolicies(undefined, rules, { providerId: 'other', providerType: 'anthropic' })).toBeUndefined();
  });

  test('multiple rules fire in order, later rules can overwrite earlier setIfMissing via set', () => {
    const rules: HeaderPolicyRule[] = [
      { when: { providerId: 'custom' }, setIfMissing: { 'X-A': 'first' } },
      { when: { providerId: 'custom' }, set: { 'X-A': 'overwritten' } }
    ];
    const result = applyHeaderPolicies(undefined, rules, { providerId: 'custom', providerType: 'openai' });
    expect(result).toEqual({ 'X-A': 'overwritten' });
  });

  test('preserves existing headers not touched by rules', () => {
    const existing = { 'X-Existing': 'keep' };
    const rules: HeaderPolicyRule[] = [
      { when: { providerId: 'custom' }, setIfMissing: { 'X-New': 'added' } }
    ];
    const result = applyHeaderPolicies(existing, rules, { providerId: 'custom', providerType: 'openai' });
    expect(result).toEqual({ 'X-Existing': 'keep', 'X-New': 'added' });
  });

  test('provider-specific header injection applies setIfMissing rules', () => {
    const rules: HeaderPolicyRule[] = [
      { when: { providerId: 'custom' }, setIfMissing: {
        'X-Custom-Mode': 'enabled',
        'User-Agent': 'custom-cli/1.0'
      }}
    ];

    // No existing headers
    const result = applyHeaderPolicies(undefined, rules, { providerId: 'custom', providerType: 'openai' });
    expect(result).toEqual({
      'X-Custom-Mode': 'enabled',
      'User-Agent': 'custom-cli/1.0'
    });

    // With existing User-Agent
    const result2 = applyHeaderPolicies({ 'User-Agent': 'custom-agent' }, rules, { providerId: 'custom', providerType: 'openai' });
    expect(result2!['User-Agent']).toBe('custom-agent');
    expect(result2!['X-Custom-Mode']).toBe('enabled');
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
