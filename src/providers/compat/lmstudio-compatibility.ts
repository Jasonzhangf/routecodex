/**
 * LM Studio Compatibility Module
 *
 * Adapts OpenAI-style requests and responses to LM Studio's expectations.
 * This slimmer implementation focuses on strict typing and the minimal
 * transformation logic still in use today (tool choice normalization and
 * response metadata patching) so we can remove the legacy `any` usage.
 */

import type {
  ModuleConfig,
  TransformationRule
} from '../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { ModuleDependencies } from '../../modules/pipeline/types/module.types.js';
import type { UnknownObject } from '../../modules/pipeline/types/common-types.js';
import type { CompatibilityContext, CompatibilityModule } from './compatibility-interface.js';
import {
  TransformationEngine,
  type TransformationResult
} from '../../modules/pipeline/utils/transformation-engine.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export class LMStudioCompatibility implements CompatibilityModule {
  readonly id: string;
  readonly type = 'lmstudio-compatibility';
  readonly providerType = 'lmstudio';

  private readonly dependencies: ModuleDependencies;
  private _config: ModuleConfig = {
    type: 'lmstudio-compatibility',
    config: {}
  };
  private transformationEngine: TransformationEngine | null = null;
  private rules: TransformationRule[] = [];
  private isInitialized = false;

  constructor(dependencies: ModuleDependencies) {
    this.dependencies = dependencies;
    this.id = `lmstudio-compatibility-${Date.now()}`;
  }

  get config(): ModuleConfig {
    return this._config;
  }

  setConfig(config: ModuleConfig): void {
    this._config = config;
    this.rules = this.initializeTransformationRules();
    this.dependencies.logger?.logModule(this.id, 'config-updated', {
      hasCustomRules: Array.isArray((config.config as Record<string, unknown> | undefined)?.customRules)
    });
  }

  async initialize(): Promise<void> {
    this.dependencies.logger?.logModule(this.id, 'initializing', {
      config: this._config
    });

    this.transformationEngine = new TransformationEngine();
    await this.transformationEngine.initialize();
    this.rules = this.initializeTransformationRules();
    this.isInitialized = true;

    this.dependencies.logger?.logModule(this.id, 'initialized', {
      ruleCount: this.rules.length
    });
  }

  async processIncoming(request: UnknownObject, _context: CompatibilityContext): Promise<UnknownObject> {
    this.ensureInitialized();
    const payload = { ...request };

    // Normalize tool_choice shapes: LM Studio expects a string flag
    const toolChoice = payload.tool_choice;
    if (toolChoice && typeof toolChoice === 'object' && !Array.isArray(toolChoice)) {
      payload.tool_choice = 'required';
      this.dependencies.logger?.logModule(this.id, 'normalized-tool_choice', {
        from: 'object',
        to: 'required'
      });
    }

    const transformed = await this.applyRules(payload, this.getRequestTransformationRules());
    this.dependencies.logger?.logModule(this.id, 'process-incoming-complete', {
      ruleCount: this.rules.length
    });
    return transformed;
  }

  async processOutgoing(response: UnknownObject, _context: CompatibilityContext): Promise<UnknownObject> {
    this.ensureInitialized();
    const payload = { ...response };

    const transformed = await this.applyRules(payload, this.getResponseTransformationRules());
    this.patchResponseMetadata(transformed);

    this.dependencies.logger?.logModule(this.id, 'process-outgoing-complete', {
      ruleCount: this.rules.length
    });
    return transformed;
  }

  async cleanup(): Promise<void> {
    if (!this.isInitialized) {
      return;
    }
    await this.transformationEngine?.cleanup();
    this.transformationEngine = null;
    this.isInitialized = false;
    this.dependencies.logger?.logModule(this.id, 'cleanup-complete');
  }

  getStatus(): {
    id: string;
    type: string;
    isInitialized: boolean;
    ruleCount: number;
    lastActivity: number;
  } {
    return {
      id: this.id,
      type: this.type,
      isInitialized: this.isInitialized,
      ruleCount: this.rules.length,
      lastActivity: Date.now()
    };
  }

  async applyTransformations(data: UnknownObject, rules: TransformationRule[]): Promise<UnknownObject> {
    this.ensureInitialized();
    if (!rules.length) {
      return data;
    }
    return this.applyRules(data, rules);
  }

  // Helpers ----------------------------------------------------------------

  private ensureInitialized(): void {
    if (!this.isInitialized || !this.transformationEngine) {
      throw new Error('LM Studio Compatibility module is not initialized');
    }
  }

  private initializeTransformationRules(): TransformationRule[] {
    const moduleConfig = isRecord(this._config.config) ? this._config.config : {};
    const rules: TransformationRule[] = [];

    if (Array.isArray(moduleConfig.customRules)) {
      rules.push(...moduleConfig.customRules as TransformationRule[]);
    }

    rules.push(
      {
        id: 'tools-conversion',
        transform: 'mapping',
        sourcePath: 'tools',
        targetPath: 'tools',
        mapping: { type: 'type', function: 'function' }
      },
      {
        id: 'message-format',
        transform: 'rename',
        sourcePath: 'messages',
        targetPath: 'messages'
      }
    );

    return rules;
  }

  private getRequestTransformationRules(): TransformationRule[] {
    const moduleConfig = isRecord(this._config.config) ? this._config.config : {};
    const requestRules = [...this.rules];

    if (moduleConfig.toolsEnabled === true) {
      requestRules.push({
        id: 'tools-request-conversion',
        transform: 'mapping',
        sourcePath: 'tools',
        targetPath: 'tools',
        mapping: { type: 'type', function: 'function' }
      });
    }

    return requestRules;
  }

  private getResponseTransformationRules(): TransformationRule[] {
    return [
      ...this.rules,
      {
        id: 'response-object-mapping',
        transform: 'mapping',
        sourcePath: 'object',
        targetPath: 'object',
        mapping: {
          'chat.completion': 'chat.completion',
          'chat.completion.chunk': 'chat.completion.chunk'
        }
      },
      {
        id: 'tool-calls-response',
        transform: 'mapping',
        sourcePath: 'choices.*.message.tool_calls',
        targetPath: 'choices.*.message.tool_calls',
        mapping: { id: 'id', type: 'type', function: 'function' }
      }
    ];
  }

  private async applyRules(data: UnknownObject, rules: TransformationRule[]): Promise<UnknownObject> {
    if (!this.transformationEngine) {
      return data;
    }
    const result = await this.transformationEngine.transform<UnknownObject>(data, rules);
    return this.extractTransformationResult(result);
  }

  private extractTransformationResult(result: TransformationResult<UnknownObject> | UnknownObject): UnknownObject {
    if (isRecord(result) && 'data' in result && isRecord(result.data)) {
      return result.data;
    }
    return isRecord(result) ? result : {};
  }

  private patchResponseMetadata(response: UnknownObject): void {
    const choices = Array.isArray(response.choices) ? response.choices : [];
    if (!response.object && choices.length > 0) {
      response.object = 'chat.completion';
    }
    if (!response.id && choices.length > 0) {
      response.id = `chatcmpl_${Math.random().toString(36).slice(2)}`;
    }
    if (!response.created) {
      response.created = Math.floor(Date.now() / 1000);
    }
    if (!response.model) {
      response.model = 'unknown';
    }
  }
}
