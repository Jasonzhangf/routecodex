import type { ProviderFamilyLookupInput, ProviderFamilyProfile } from './profile-contracts.js';
import { resolveProviderFamilyFromDirectory } from './provider-directory.js';
import { antigravityFamilyProfile } from './families/antigravity-profile.js';
import { anthropicFamilyProfile } from './families/anthropic-profile.js';
import { glmFamilyProfile } from './families/glm-profile.js';
import { iflowFamilyProfile } from './families/iflow-profile.js';
import { qwenFamilyProfile } from './families/qwen-profile.js';
import { responsesFamilyProfile } from './families/responses-profile.js';

const FAMILY_PROFILES = new Map<string, ProviderFamilyProfile>([
  ['iflow', iflowFamilyProfile],
  ['responses', responsesFamilyProfile],
  ['anthropic', anthropicFamilyProfile],
  ['glm', glmFamilyProfile],
  ['qwen', qwenFamilyProfile],
  ['antigravity', antigravityFamilyProfile]
]);

function normalizeToken(value?: string): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length ? normalized : undefined;
}

export function getProviderFamilyProfile(input: ProviderFamilyLookupInput): ProviderFamilyProfile | undefined {
  const explicitFamily = normalizeToken(input.providerFamily);
  if (explicitFamily && FAMILY_PROFILES.has(explicitFamily)) {
    return FAMILY_PROFILES.get(explicitFamily);
  }

  const family = resolveProviderFamilyFromDirectory({
    ...input,
    ...(explicitFamily && !FAMILY_PROFILES.has(explicitFamily) ? { providerFamily: undefined } : {})
  });
  if (!family) {
    return undefined;
  }
  return FAMILY_PROFILES.get(family);
}

export function hasProviderFamilyProfile(input: ProviderFamilyLookupInput): boolean {
  return !!getProviderFamilyProfile(input);
}
