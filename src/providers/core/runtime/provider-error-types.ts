import type { ProviderError } from '../api/provider-types.js';

export type ProviderErrorAugmented = ProviderError & {
  code?: string;
  retryable?: boolean;
  status?: number;
  response?: {
    data?: {
      error?: {
        code?: string;
        message?: string;
        status?: number;
      };
    };
    status?: number;
  };
  details?: Record<string, unknown>;
  requestId?: string;
  providerKey?: string;
  providerId?: string;
  providerType?: string;
  providerFamily?: string;
  routeName?: string;
};
