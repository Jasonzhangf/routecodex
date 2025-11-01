/**
 * Generic HTTP Provider Implementation
 *
 * Provides a generic HTTP client for various AI service providers
 * with configurable authentication and request handling.
 */

import type { ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { UnknownObject } from '../../../../types/common-types.js';
import { BaseHttpProvider } from './shared/base-http-provider.js';

/**
 * Generic HTTP Provider Module
 */
export class GenericHTTPProvider extends BaseHttpProvider {
  readonly type = 'generic-http';
  readonly providerType: string;

  constructor(config: ModuleConfig, dependencies: ModuleDependencies) {
    super(config, dependencies);
    this.providerType = (config.config as any).type;
  }

  protected getDefaultBaseUrl(): string {
    const providerConfig = this.config.config as any;
    return providerConfig.baseUrl || '';
  }

  protected buildEndpointUrl(path?: string): string {
    const baseUrl = this.getDefaultBaseUrl();
    if (!baseUrl) {
      throw new Error('Base URL is required for Generic HTTP Provider');
    }
    return path ? `${baseUrl}${path}` : `${baseUrl}/chat/completions`;
  }
}