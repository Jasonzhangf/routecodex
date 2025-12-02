import type { CompatibilityModule, CompatibilityContext } from '../compatibility-interface.js';
import type { ModuleDependencies } from '../../../../../types/module.types.js';
import type { UnknownObject } from '../../../../../types/common-types.js';

/**
 * Responses C4M Compatibility
 * - Removes unsupported fields before sending payloads to the c4m Responses endpoint
 * - Keeps response untouched
 */
export class ResponsesC4MCompatibility implements CompatibilityModule {
  readonly id: string;
  readonly type = 'responses-c4m-compatibility';
  readonly providerType = 'responses';

  constructor(private readonly dependencies: ModuleDependencies) {
    this.id = `responses-c4m-compatibility-${Date.now()}`;
  }

  async initialize(): Promise<void> {
    this.dependencies.logger?.logModule?.(this.id, 'initialize', { providerType: this.providerType });
  }

  async cleanup(): Promise<void> {
    this.dependencies.logger?.logModule?.(this.id, 'cleanup', {});
  }

  async processIncoming(request: UnknownObject, context: CompatibilityContext): Promise<UnknownObject> {
    const sanitized = this.stripUnsupportedFields(request);
    if (sanitized !== request) {
      this.dependencies.logger?.logModule?.(this.id, 'strip-fields', {
        requestId: context.requestId,
        removed: ['max_tokens', 'maxTokens']
      });
    }
    return sanitized;
  }

  async processOutgoing(response: UnknownObject): Promise<UnknownObject> {
    return response;
  }

  private stripUnsupportedFields(payload: UnknownObject): UnknownObject {
    if (!payload || typeof payload !== 'object') {
      return payload;
    }
    const clone = Array.isArray(payload)
      ? (payload.map(item => this.stripUnsupportedFields(item as UnknownObject)) as unknown as UnknownObject)
      : { ...(payload as Record<string, unknown>) };

    if ('max_tokens' in clone) {
      delete (clone as Record<string, unknown>).max_tokens;
    }
    if ('maxTokens' in clone) {
      delete (clone as Record<string, unknown>).maxTokens;
    }
    if ((clone as Record<string, unknown>).data && typeof (clone as Record<string, unknown>).data === 'object') {
      (clone as Record<string, unknown>).data = this.stripUnsupportedFields(
        (clone as Record<string, unknown>).data as UnknownObject
      );
    }
    return clone;
  }
}

export default ResponsesC4MCompatibility;
