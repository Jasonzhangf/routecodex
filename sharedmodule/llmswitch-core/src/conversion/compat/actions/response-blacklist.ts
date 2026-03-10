import type { JsonObject } from '../../hub/types/json.js';
import { applyResponseBlacklistWithNative } from '../../../router/virtual-router/engine-selection/native-compat-action-semantics.js';

export interface ResponseBlacklistConfig {
  paths?: string[];
  keepCritical?: boolean;
}

export class ResponseBlacklistSanitizer {
  private readonly cfg: ResponseBlacklistConfig;

  constructor(config: ResponseBlacklistConfig) {
    this.cfg = config;
  }

  apply(payload: JsonObject): JsonObject {
    return applyResponseBlacklistWithNative(
      payload as unknown as Record<string, unknown>,
      this.cfg as unknown as Record<string, unknown>
    ) as unknown as JsonObject;
  }
}
