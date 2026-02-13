import path from 'path';

export type OAuthProviderId = 'iflow' | 'qwen' | 'gemini-cli' | 'antigravity' | 'deepseek-account';

export const SUPPORTED_OAUTH_PROVIDERS: OAuthProviderId[] = [
  'iflow',
  'qwen',
  'gemini-cli',
  'antigravity',
  'deepseek-account'
];

export interface RawTokenPayload {
  access_token?: string;
  AccessToken?: string;
  refresh_token?: string;
  api_key?: string;
  apiKey?: string;
  expires_at?: number | string;
  expired?: number | string;
  expiry_date?: number | string;
  email?: string;
  account?: string;
  name?: string;
  // 可选：标记该 token 仅供读取，不做自动刷新或重新授权
  norefresh?: boolean;
  [key: string]: unknown;
}

export type TokenStatus = 'valid' | 'expiring' | 'expired' | 'invalid';

export interface TokenState {
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  hasApiKey: boolean;
  expiresAt: number | null;
  msUntilExpiry: number | null;
  status: TokenStatus;
  // 为 true 时，token-daemon 不会尝试自动刷新该 token
  noRefresh: boolean;
}

export interface TokenIdentity {
  provider: OAuthProviderId;
  filePath: string;
  sequence: number;
  alias: string;
}

export interface TokenDescriptor extends TokenIdentity {
  state: TokenState;
  displayName: string;
}

export interface TokenUsage {
  serverId: string;
  providerId: string;
  protocol: string;
}

export function buildTokenKey(id: TokenIdentity): string {
  return `${id.provider}::${id.filePath}`;
}

export function formatTokenLabel(desc: TokenDescriptor): string {
  const base = path.basename(desc.filePath);
  if (desc.displayName && desc.displayName !== base) {
    return `${desc.displayName} (${base})`;
  }
  return base;
}
