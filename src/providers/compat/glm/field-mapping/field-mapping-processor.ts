import type { UnknownObject } from '../../../../modules/pipeline/types/common-types.js';
import type { ModuleDependencies } from '../../../../modules/pipeline/types/module.types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { sanitizeGLMToolsSchemaInPlace } from '../utils/tool-schema-helpers.js';

interface FieldMapping {
  sourcePath: string;
  targetPath: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  direction: 'incoming' | 'outgoing' | 'bidirectional';
  transform?: string;
}

interface FieldMappingConfig {
  incomingMappings: FieldMapping[];
  outgoingMappings: FieldMapping[];
}

const isRecord = (value: unknown): value is UnknownObject => typeof value === 'object' && value !== null;

const cloneObject = (value: UnknownObject): UnknownObject => ({ ...value });

/**
 * GLM字段映射处理器
 * 负责OpenAI格式与GLM格式之间的字段转换
 */
export class GLMFieldMappingProcessor {
  private readonly dependencies: ModuleDependencies;
  private config: FieldMappingConfig | null = null;
  private isInitialized = false;

  constructor(dependencies: ModuleDependencies) {
    this.dependencies = dependencies;
  }

  async initialize(): Promise<void> {
    try {
      await this.loadConfig();
      this.isInitialized = true;

      this.dependencies.logger?.logModule('glm-field-mapping', 'initialized', {
        incomingMappings: this.config?.incomingMappings.length || 0,
        outgoingMappings: this.config?.outgoingMappings.length || 0
      });
    } catch (error) {
      this.dependencies.logger?.logError?.(error as Error, {
        component: 'GLMFieldMappingProcessor',
        stage: 'initialize'
      });
      throw error;
    }
  }

  async mapIncoming(request: UnknownObject): Promise<UnknownObject> {
    if (!this.isInitialized || !this.config) {
      throw new Error('GLMFieldMappingProcessor not initialized');
    }

    this.dependencies.logger?.logModule('glm-field-mapping', 'mapIncoming-start', {
      mappingsCount: this.config.incomingMappings.length
    });

    try {
      sanitizeGLMToolsSchemaInPlace(request);
      const result = this.applyMappings(request, this.config.incomingMappings);

      this.dependencies.logger?.logModule('glm-field-mapping', 'mapIncoming-success', {
        appliedMappings: this.config.incomingMappings.length
      });

      return result;
    } catch (error) {
      this.dependencies.logger?.logError?.(error as Error, {
        component: 'GLMFieldMappingProcessor',
        stage: 'mapIncoming'
      });
      throw error;
    }
  }

  async mapOutgoing(response: UnknownObject): Promise<UnknownObject> {
    if (!this.isInitialized || !this.config) {
      throw new Error('GLMFieldMappingProcessor not initialized');
    }

    this.dependencies.logger?.logModule('glm-field-mapping', 'mapOutgoing-start', {
      mappingsCount: this.config.outgoingMappings.length
    });

    try {
      const result = this.applyMappings(response, this.config.outgoingMappings);

      this.dependencies.logger?.logModule('glm-field-mapping', 'mapOutgoing-success', {
        appliedMappings: this.config.outgoingMappings.length
      });

      return result;
    } catch (error) {
      this.dependencies.logger?.logError?.(error as Error, {
        component: 'GLMFieldMappingProcessor',
        stage: 'mapOutgoing'
      });
      throw error;
    }
  }

  async cleanup(): Promise<void> {
    this.config = null;
    this.isInitialized = false;

    this.dependencies.logger?.logModule('glm-field-mapping', 'cleanup-complete', {});
  }

  private async loadConfig(): Promise<void> {
    try {
      const configPath = path.join(__dirname, '../config/field-mappings.json');
      const configData = await fs.readFile(configPath, 'utf-8');
      this.config = JSON.parse(configData) as FieldMappingConfig;

      this.validateConfig();
    } catch (error) {
      this.config = this.getDefaultConfig();
      this.dependencies.logger?.logModule('glm-field-mapping', 'using-default-config', {});
    }
  }

  private validateConfig(): void {
    if (!this.config) {
      throw new Error('Field mapping config is null');
    }

    if (!Array.isArray(this.config.incomingMappings)) {
      throw new Error('incomingMappings must be an array');
    }

    if (!Array.isArray(this.config.outgoingMappings)) {
      throw new Error('outgoingMappings must be an array');
    }

    for (const mapping of [...this.config.incomingMappings, ...this.config.outgoingMappings]) {
      if (!mapping.sourcePath || !mapping.targetPath) {
        throw new Error('Mapping must have sourcePath and targetPath');
      }
    }
  }

  private getDefaultConfig(): FieldMappingConfig {
    return {
      incomingMappings: [
        {
          sourcePath: 'usage.prompt_tokens',
          targetPath: 'usage.input_tokens',
          type: 'number',
          direction: 'incoming'
        },
        {
          sourcePath: 'usage.completion_tokens',
          targetPath: 'usage.completion_tokens',
          type: 'number',
          direction: 'incoming'
        },
        {
          sourcePath: 'usage.output_tokens',
          targetPath: 'usage.completion_tokens',
          type: 'number',
          direction: 'incoming'
        },
        {
          sourcePath: 'created_at',
          targetPath: 'created',
          type: 'number',
          direction: 'incoming'
        }
      ],
      outgoingMappings: [
        {
          sourcePath: 'usage.input_tokens',
          targetPath: 'usage.prompt_tokens',
          type: 'number',
          direction: 'outgoing'
        },
        {
          sourcePath: 'usage.completion_tokens',
          targetPath: 'usage.output_tokens',
          type: 'number',
          direction: 'outgoing'
        },
        {
          sourcePath: 'created',
          targetPath: 'created_at',
          type: 'number',
          direction: 'outgoing'
        }
      ]
    };
  }

  private applyMappings(data: UnknownObject, mappings: FieldMapping[]): UnknownObject {
    const result = cloneObject(data);

    for (const mapping of mappings) {
      this.applyMapping(result, mapping);
    }

    return result;
  }

  private applyMapping(data: UnknownObject, mapping: FieldMapping): void {
    const sourceValue = this.getNestedProperty(data, mapping.sourcePath);

    if (sourceValue === undefined) {
      return;
    }

    let transformedValue: unknown = sourceValue;

    if (mapping.transform) {
      transformedValue = this.applyTransform(transformedValue, mapping.transform);
    }

    transformedValue = this.convertType(transformedValue, mapping.type);

    this.setNestedProperty(data, mapping.targetPath, transformedValue);
  }

  private getNestedProperty(obj: UnknownObject, pathExpression: string): unknown {
    const keys = pathExpression.split('.');

    if (pathExpression.includes('[*]')) {
      return this.getWildcardProperty(obj, keys);
    }

    return keys.reduce<unknown>((current, key) => {
      if (!isRecord(current)) {
        return undefined;
      }
      return current[key];
    }, obj);
  }

  private getWildcardProperty(obj: UnknownObject, keys: string[]): unknown[] {
    const results: unknown[] = [];
    const processWildcard = (current: unknown, keyIndex: number): void => {
      if (keyIndex >= keys.length) {
        results.push(current);
        return;
      }

      const key = keys[keyIndex];

      if (key === '[*]') {
        if (Array.isArray(current)) {
          current.forEach(item => processWildcard(item, keyIndex + 1));
        }
        return;
      }

      if (isRecord(current) && current[key] !== undefined) {
        processWildcard(current[key], keyIndex + 1);
      }
    };

    processWildcard(obj, 0);
    return results;
  }

  private setNestedProperty(obj: UnknownObject, pathExpression: string, value: unknown): void {
    const keys = pathExpression.split('.');

    if (pathExpression.includes('[*]')) {
      this.setWildcardProperty(obj, keys, value);
      return;
    }

    const lastKey = keys.pop();
    if (!lastKey) {
      return;
    }

    const target = keys.reduce<UnknownObject>((current, key) => {
      if (!isRecord(current[key])) {
        current[key] = {};
      }
      return current[key] as UnknownObject;
    }, obj);

    target[lastKey] = value as unknown;
  }

  private setWildcardProperty(obj: UnknownObject, keys: string[], value: unknown): void {
    const processSetWildcard = (current: unknown, keyIndex: number): void => {
      if (keyIndex >= keys.length - 1) {
        const lastKey = keys[keys.length - 1].replace('[*]', '');
        if (Array.isArray(current)) {
          current.forEach(item => {
            if (isRecord(item)) {
              item[lastKey] = value as unknown;
            }
          });
        }
        return;
      }

      const key = keys[keyIndex];

      if (key === '[*]') {
        if (Array.isArray(current)) {
          current.forEach(item => processSetWildcard(item, keyIndex + 1));
        }
        return;
      }

      if (isRecord(current)) {
        processSetWildcard(current[key], keyIndex + 1);
      }
    };

    processSetWildcard(obj, 0);
  }

  private convertType(value: unknown, targetType: FieldMapping['type']): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    switch (targetType) {
      case 'string':
        return String(value);
      case 'number': {
        const num = Number(value);
        return Number.isNaN(num) ? 0 : num;
      }
      case 'boolean':
        return Boolean(value);
      case 'object':
        return isRecord(value) ? value : {};
      case 'array':
        return Array.isArray(value) ? value : [value];
      default:
        return value;
    }
  }

  private applyTransform(value: unknown, transform: string): unknown {
    switch (transform) {
      case 'timestamp':
        return typeof value === 'number' ? value : Date.now();
      case 'lowercase':
        return typeof value === 'string' ? value.toLowerCase() : value;
      case 'uppercase':
        return typeof value === 'string' ? value.toUpperCase() : value;
      case 'normalizeModelName':
        return typeof value === 'string' ? value.replace(/^gpt-/, 'glm-') : value;
      case 'normalizeFinishReason':
        return typeof value === 'string' ? this.normalizeFinishReason(value) : value;
      default:
        return value;
    }
  }

  private normalizeFinishReason(reason: string): string {
    const reasonMap: Record<string, string> = {
      'tool_calls': 'tool_calls',
      'stop': 'stop',
      'length': 'length',
      'sensitive': 'content_filter',
      'network_error': 'error'
    };
    return reasonMap[reason] || reason;
  }
}
