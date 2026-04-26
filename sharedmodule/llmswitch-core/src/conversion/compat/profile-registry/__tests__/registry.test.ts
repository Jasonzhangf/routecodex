import { describe, expect, test, beforeAll } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadCompatProfileRegistry, getProfile, getHeaderPolicies, getPolicyOverrides } from '../registry.js';

describe('loadCompatProfileRegistry', () => {
  // __tests__/registry.test.ts -> ../.. = compat/profile-registry/../../ = compat/ -> profiles/
  const _testDir = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
  const profilesDir = path.resolve(_testDir, '..', '..', 'profiles');

  let registry: ReturnType<typeof loadCompatProfileRegistry>;

  beforeAll(() => {
    registry = loadCompatProfileRegistry(profilesDir);
  });

  test('loads all profile JSON files from the profiles directory', () => {
    const jsonFiles = fs.readdirSync(profilesDir).filter(f => f.endsWith('.json'));
    expect(registry.profiles.size).toBe(jsonFiles.length);
  });

  test('all profiles have valid id and protocol', () => {
    for (const [id, profile] of registry.profiles) {
      expect(typeof profile.id).toBe('string');
      expect(profile.id.trim()).toBeTruthy();
      expect(profile.id).toBe(id);
      expect(typeof profile.protocol).toBe('string');
      expect(typeof profile.protocol).toBe('string'); // allow empty (chat:lmstudio)
    }
  });

  test('getProfile throws for missing profile (fail-fast, no fallback)', () => {
    expect(() => getProfile(registry, 'chat:nonexistent')).toThrow(
      /profile not found.*chat:nonexistent/
    );
  });

  test('getProfile returns existing profile', () => {
    const profile = getProfile(registry, 'chat:qwen');
    expect(profile.id).toBe('chat:qwen');
    expect(profile.protocol).toBe('openai-chat');
  });

  test('getHeaderPolicies returns empty array for profiles without headerPolicies', () => {
    const policies = getHeaderPolicies(registry, 'chat:glm');
    expect(policies).toEqual([]);
  });

  test('getPolicyOverrides returns undefined for profiles without policyOverrides', () => {
    const overrides = getPolicyOverrides(registry, 'chat:glm');
    expect(overrides).toBeUndefined();
  });

  test('throws on missing profiles directory', () => {
    expect(() => loadCompatProfileRegistry('/nonexistent/path')).toThrow(
      /profiles directory not found/
    );
  });

  test('throws on invalid JSON', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-test-'));
    fs.writeFileSync(path.join(tmpDir, 'bad.json'), '{invalid json}');
    expect(() => loadCompatProfileRegistry(tmpDir)).toThrow(/invalid JSON/);
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('throws on profile missing id', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-test-'));
    fs.writeFileSync(path.join(tmpDir, 'no-id.json'), JSON.stringify({ protocol: 'openai-chat' }));
    expect(() => loadCompatProfileRegistry(tmpDir)).toThrow(/missing required field 'id'/);
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('throws on profile missing protocol', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-test-'));
    fs.writeFileSync(path.join(tmpDir, 'no-proto.json'), JSON.stringify({ id: 'test:profile' }));
    expect(() => loadCompatProfileRegistry(tmpDir)).toThrow(/invalid field 'protocol'/);
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('throws on duplicate profile id', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-test-'));
    const profile = { id: 'test:dup', protocol: 'openai-chat' };
    fs.writeFileSync(path.join(tmpDir, 'a.json'), JSON.stringify(profile));
    fs.writeFileSync(path.join(tmpDir, 'b.json'), JSON.stringify(profile));
    expect(() => loadCompatProfileRegistry(tmpDir)).toThrow(/duplicate profile id/);
    fs.rmSync(tmpDir, { recursive: true });
  });
});
