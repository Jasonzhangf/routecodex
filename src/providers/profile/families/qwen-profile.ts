import type { ProviderFamilyProfile, ResolveOAuthTokenFileInput } from '../profile-contracts.js';

function hasConfiguredOAuthClient(auth: ResolveOAuthTokenFileInput['auth']): boolean {
  return !!auth.clientId || !!auth.tokenUrl || !!auth.deviceCodeUrl;
}

export const qwenFamilyProfile: ProviderFamilyProfile = {
  id: 'qwen/default',
  providerFamily: 'qwen',
  resolveOAuthTokenFileMode(input: ResolveOAuthTokenFileInput): boolean | undefined {
    if (input.oauthProviderId !== 'qwen') {
      return undefined;
    }
    return !hasConfiguredOAuthClient(input.auth);
  }
};
