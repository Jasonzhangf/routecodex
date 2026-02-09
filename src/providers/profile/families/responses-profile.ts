import type { ApplyRequestHeadersInput, ProviderFamilyProfile } from '../profile-contracts.js';

const CODEX_DEFAULT_USER_AGENT = 'codex_cli_rs/0.73.0 (Mac OS 15.6.1; arm64) iTerm.app/3.6.5';

function assignHeader(headers: Record<string, string>, target: string, value: string): void {
  if (!value || !value.trim()) {
    return;
  }
  const lowered = target.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowered) {
      headers[key] = value;
      return;
    }
  }
  headers[target] = value;
}

export const responsesFamilyProfile: ProviderFamilyProfile = {
  id: 'responses/default',
  providerFamily: 'responses',
  applyRequestHeaders(input: ApplyRequestHeadersInput): Record<string, string> | undefined {
    if (!input.isCodexUaMode) {
      return undefined;
    }
    const headers = { ...(input.headers || {}) };
    assignHeader(headers, 'User-Agent', CODEX_DEFAULT_USER_AGENT);
    assignHeader(headers, 'originator', 'codex_cli_rs');
    return headers;
  }
};
