import type { CompatibilityModule, CompatibilityContext } from '../compatibility-interface.js';
import type { ModuleDependencies } from '../../../modules/pipeline/types/module.types.js';
import type { UnknownObject } from '../../../modules/pipeline/types/common-types.js';

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

  async processOutgoing(response: UnknownObject, context: CompatibilityContext): Promise<UnknownObject> {
    const rateLimitMessage = this.detectRateLimitNotice(response);
    if (rateLimitMessage) {
      const error = new Error(rateLimitMessage);
      const enriched = error as Error & {
        statusCode?: number;
        code?: string;
        details?: Record<string, unknown>;
      };
      enriched.statusCode = 429;
      enriched.code = 'HTTP_429';
      enriched.details = {
        requestId: context.requestId,
        profileId: context.profileId,
        providerType: context.providerType
      };
      throw enriched;
    }
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

    if (typeof (clone as Record<string, unknown>).instructions === 'string') {
      const rawInstruction = ((clone as Record<string, unknown>).instructions as string).trim();
      if (rawInstruction) {
        const {
          sanitized,
          mutations
        } = this.sanitizeInstructions(rawInstruction);
        const moved = this.injectInstructionsIntoInput(clone as Record<string, unknown>, sanitized);
        delete (clone as Record<string, unknown>).instructions;
        removed.push(moved ? 'instructions:moved-to-input' : 'instructions:removed');
        if (mutations.length) {
          removed.push(...mutations.map(flag => `instructions:${flag}`));
        }
      } else {
        delete (clone as Record<string, unknown>).instructions;
        removed.push('instructions:empty');
      }
    }

    if ((clone as Record<string, unknown>).data && typeof (clone as Record<string, unknown>).data === 'object') {
      const inner = this.stripUnsupportedFields((clone as Record<string, unknown>).data as UnknownObject);
      (clone as Record<string, unknown>).data = inner.sanitized;
      removed.push(...inner.removed);
    }
    return { sanitized: clone, removed };
  }

  private detectRateLimitNotice(response: UnknownObject): string | null {
    const candidates: string[] = [];
    const pushText = (value: unknown) => {
      if (typeof value === 'string' && value.trim()) {
        candidates.push(value.trim());
      }
    };
    pushText((response as Record<string, unknown>)?.message);
    const errorNode = (response as Record<string, unknown>)?.error;
    if (errorNode && typeof errorNode === 'object') {
      pushText((errorNode as Record<string, unknown>).message);
    }
    const output = (response as Record<string, unknown>)?.output;
    if (Array.isArray(output)) {
      for (const item of output) {
        if (!item || typeof item !== 'object') {
          continue;
        }
        const content = (item as Record<string, unknown>).content;
        if (typeof content === 'string') {
          pushText(content);
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block && typeof block === 'object') {
              pushText((block as Record<string, unknown>).text);
              pushText((block as Record<string, unknown>).message);
            }
          }
        }
      }
    }
    for (const value of candidates) {
      if (this.isCodexRateLimitNotice(value)) {
        return value;
      }
    }
    return null;
  }

  private isCodexRateLimitNotice(value: string): boolean {
    const normalized = value.toLowerCase();
    return normalized.includes('codex-for.me') && normalized.includes('request limit');
  }

  private injectInstructionsIntoInput(container: Record<string, unknown>, instructions: string): boolean {
    if (!instructions.trim()) {
      return false;
    }
    const messageBlock = {
      type: 'message',
      role: 'system',
      content: [
        {
          type: 'input_text',
          text: instructions
        }
      ]
    };
    if (!Array.isArray(container.input)) {
      container.input = [];
    }
    try {
      (container.input as Array<unknown>).unshift(messageBlock);
      return true;
    } catch {
      container.input = [messageBlock];
      return true;
    }
  }

  private sanitizeInstructions(input: string): { sanitized: string; mutations: string[] } {
    const mutations: string[] = [];
    let sanitized = input;
    const stripped = sanitized.replace(/<\/?[A-Za-z][^>]*>/g, '');
    if (stripped !== sanitized) {
      sanitized = stripped;
      mutations.push('angle-brackets');
    }
    const envLimitRaw =
      process.env.ROUTECODEX_C4M_INSTRUCTIONS_MAX ??
      process.env.RCC_C4M_INSTRUCTIONS_MAX ??
      process.env.ROUTECODEX_COMPAT_INSTRUCTIONS_MAX;
    const maxLength = typeof envLimitRaw === 'string' ? Number(envLimitRaw) : NaN;
    if (Number.isFinite(maxLength) && maxLength > 0 && sanitized.length > maxLength) {
      sanitized = sanitized.slice(0, Math.floor(maxLength));
      mutations.push('trimmed');
    }
    return { sanitized, mutations };
  }
}

export default ResponsesC4MCompatibility;
