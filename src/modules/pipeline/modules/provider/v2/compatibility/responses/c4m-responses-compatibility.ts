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
    const { sanitized, removed } = this.stripUnsupportedFields(request);
    if (removed.length) {
      this.dependencies.logger?.logModule?.(this.id, 'strip-fields', { requestId: context.requestId, removed });
    }
    return sanitized;
  }

  async processOutgoing(response: UnknownObject): Promise<UnknownObject> {
    return response;
  }

  private stripUnsupportedFields(payload: UnknownObject): { sanitized: UnknownObject; removed: string[] } {
    if (!payload || typeof payload !== 'object') {
      return { sanitized: payload, removed: [] };
    }
    const removed: string[] = [];
    const clone = Array.isArray(payload)
      ? (payload.map(item => this.stripUnsupportedFields(item as UnknownObject).sanitized) as unknown as UnknownObject)
      : { ...(payload as Record<string, unknown>) };

    const dropKeys = ['max_tokens', 'maxTokens', 'max_output_tokens', 'maxOutputTokens'];
    for (const key of dropKeys) {
      if (key in clone) {
        delete (clone as Record<string, unknown>)[key as keyof typeof clone];
        removed.push(key);
      }
    }
    if ((clone as Record<string, unknown>).data && typeof (clone as Record<string, unknown>).data === 'object') {
      const inner = this.stripUnsupportedFields((clone as Record<string, unknown>).data as UnknownObject);
      (clone as Record<string, unknown>).data = inner.sanitized;
      removed.push(...inner.removed);
    }
    return { sanitized: clone, removed };
  }
}

export default ResponsesC4MCompatibility;
