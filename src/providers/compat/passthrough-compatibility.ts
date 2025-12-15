/**
 * Passthrough Compatibility Module
 *
 * Minimal compatibility layer that simply returns the payload without
 * modification. The new implementation keeps the previous hooks (tool metadata
 * patching) that ensured OpenAI clients can consume the response, but does so
 * with explicit typing to avoid `any`.
 */

import type { ModuleConfig } from '../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { ModuleDependencies } from '../../modules/pipeline/types/module.types.js';
import type { UnknownObject } from '../../modules/pipeline/types/common-types.js';
import type { CompatibilityContext, CompatibilityModule } from './compatibility-interface.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export class PassthroughCompatibility implements CompatibilityModule {
  readonly id: string;
  readonly type = 'compat:passthrough';
  readonly providerType = 'passthrough';

  private readonly dependencies: ModuleDependencies;
  private _config: ModuleConfig = {
    type: 'compat:passthrough',
    config: {}
  };
  private isInitialized = false;

  constructor(dependencies: ModuleDependencies) {
    this.dependencies = dependencies;
    this.id = `compat-passthrough-${Date.now()}`;
  }

  get config(): ModuleConfig {
    return this._config;
  }

  setConfig(config: ModuleConfig): void {
    this._config = config;
  }

  async initialize(): Promise<void> {
    this.dependencies.logger?.logModule(this.id, 'initialization-start');
    this.validateConfig();
    this.isInitialized = true;
    this.dependencies.logger?.logModule(this.id, 'initialization-complete');
  }

  async processIncoming(request: UnknownObject, _context: CompatibilityContext): Promise<UnknownObject> {
    this.ensureInitialized();
    this.dependencies.logger?.logModule(this.id, 'process-incoming', {
      hasModel: typeof request.model === 'string'
    });
    return { ...request };
  }

  async processOutgoing(response: UnknownObject, _context: CompatibilityContext): Promise<UnknownObject> {
    this.ensureInitialized();
    const payload = { ...response };

    if (isRecord(payload.choices)) {
      // legacy responses shouldn’t have choices as object; keep semantics
      payload.choices = Object.values(payload.choices);
    }

    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    if (choices.length > 0 && !payload.object) {
      payload.object = 'chat.completion';
    }
    if (choices.length > 0 && !payload.id) {
      payload.id = `chatcmpl_${Math.random().toString(36).slice(2)}`;
    }
    if (!payload.created) {
      payload.created = Math.floor(Date.now() / 1000);
    }
    if (!payload.model) {
      payload.model = 'unknown';
    }

    this.dependencies.logger?.logModule(this.id, 'process-outgoing', {
      choiceCount: choices.length
    });

    return payload;
  }

  async cleanup(): Promise<void> {
    this.isInitialized = false;
    this.dependencies.logger?.logModule(this.id, 'cleanup-complete');
  }

  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new Error('Passthrough Compatibility module is not initialized');
    }
  }

  private validateConfig(): void {
    if (this._config.type !== 'passthrough-compatibility') {
      throw new Error('Invalid passthrough compatibility type');
    }
  }
}
