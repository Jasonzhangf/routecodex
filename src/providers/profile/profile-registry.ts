import type { ProviderFamilyLookupInput, ProviderFamilyProfile } from './profile-contracts.js';
import { resolveProviderFamilyFromDirectory } from './provider-directory.js';
import { anthropicFamilyProfile } from './families/anthropic-profile.js';
import { iflowFamilyProfile } from './families/iflow-profile.js';
import { responsesFamilyProfile } from './families/responses-profile.js';

const FAMILY_PROFILES = new Map<string, ProviderFamilyProfile>([
  ['iflow', iflowFamilyProfile],
  ['responses', responsesFamilyProfile],
  ['anthropic', anthropicFamilyProfile]
]);

export function getProviderFamilyProfile(input: ProviderFamilyLookupInput): ProviderFamilyProfile | undefined {
  const family = resolveProviderFamilyFromDirectory(input);
  if (!family) {
    return undefined;
  }
  return FAMILY_PROFILES.get(family);
}

export function hasProviderFamilyProfile(input: ProviderFamilyLookupInput): boolean {
  return !!getProviderFamilyProfile(input);
}
