import type { ProviderFamilyLookupInput, ProviderFamilyProfile } from './profile-contracts.js';
import { resolveProviderFamilyFromDirectory } from './provider-directory.js';
import { anthropicFamilyProfile } from './families/anthropic-profile.js';
import { deepseekFamilyProfile } from './families/deepseek-profile.js';
import { glmFamilyProfile } from './families/glm-profile.js';
import { responsesFamilyProfile } from './families/responses-profile.js';

const FAMILY_PROFILES = new Map<string, ProviderFamilyProfile>([
  ['responses', responsesFamilyProfile],
  ['anthropic', anthropicFamilyProfile],
  ['deepseek', deepseekFamilyProfile],
  ['glm', glmFamilyProfile],
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
