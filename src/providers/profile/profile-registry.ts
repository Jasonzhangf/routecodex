import type { ProviderFamilyLookupInput, ProviderFamilyProfile } from './profile-contracts.js';
import { resolveProviderFamilyFromDirectory } from './provider-directory.js';
import { iflowFamilyProfile } from './families/iflow-profile.js';

const FAMILY_PROFILES = new Map<string, ProviderFamilyProfile>([
  ['iflow', iflowFamilyProfile]
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
