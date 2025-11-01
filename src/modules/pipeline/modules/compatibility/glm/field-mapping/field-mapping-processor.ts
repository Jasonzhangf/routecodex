import type { UnknownObject } from '../../../../../../types/common-types.js';
import type { ModuleDependencies } from '../../../../../../types/module.types.js';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * 字段映射配置接口
 */
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

/**
 * GLM字段映射处理器
 * 负责OpenAI格式与GLM格式之间的字段转换
 */
export class GLMFieldMappingProcessor {
  private dependencies: ModuleDependencies;
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

      // 验证配置
      this.validateConfig();
    } catch (error) {
      // 如果配置文件不存在，使用默认配置
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

    // 验证每个映射配置
    for (const mapping of [...this.config.incomingMappings, ...this.config.outgoingMappings]) {
      if (!mapping.sourcePath || !mapping.targetPath) {
        throw new Error('Mapping must have sourcePath and targetPath');
      }
    }
  }

  private getDefaultConfig(): FieldMappingConfig {
    return {
      incomingMappings: [
        // GLM格式 -> OpenAI格式的映射
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
        },
        {
          sourcePath: 'reasoning_content',
          targetPath: 'reasoning',
          type: 'string',
          direction: 'incoming',
          transform: 'extract_blocks'
        }
      ],
      outgoingMappings: [
        // OpenAI格式 -> GLM格式的映射
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
        },
        {
          sourcePath: 'reasoning',
          targetPath: 'reasoning_content',
          type: 'string',
          direction: 'outgoing',
          transform: 'wrap_blocks'
        }
      ]
    };
  }

  private applyMappings(data: UnknownObject, mappings: FieldMapping[]): UnknownObject {
    const result = { ...data };

    for (const mapping of mappings) {
      this.applyMapping(result, mapping);
    }

    return result;
  }

  private applyMapping(data: UnknownObject, mapping: FieldMapping): void {
    const sourceValue = this.getNestedProperty(data, mapping.sourcePath);

    if (sourceValue !== undefined) {
      let transformedValue = sourceValue;

      // 应用类型转换
      transformedValue = this.convertType(transformedValue, mapping.type);

      // 应用自定义转换
      if (mapping.transform) {
        transformedValue = this.applyTransform(transformedValue, mapping.transform);
      }

      this.setNestedProperty(data, mapping.targetPath, transformedValue);
    }
  }

  private getNestedProperty(obj: UnknownObject, path: string): any {
    return path.split('.').reduce((current, key) => {
      return current && current[key] !== undefined ? current[key] : undefined;
    }, obj as any);
  }

  private setNestedProperty(obj: UnknownObject, path: string, value: any): void {
    const keys = path.split('.');
    const lastKey = keys.pop()!;

    const target = keys.reduce((current, key) => {
      if (current[key] === undefined) {
        current[key] = {};
      }
      return current[key];
    }, obj as any);

    target[lastKey] = value;
  }

  private convertType(value: any, targetType: string): any {
    if (value === null || value === undefined) {
      return value;
    }

    switch (targetType) {
      case 'string':
        return String(value);
      case 'number':
        const num = Number(value);
        return isNaN(num) ? 0 : num;
      case 'boolean':
        return Boolean(value);
      case 'object':
        return typeof value === 'object' ? value : {};
      case 'array':
        return Array.isArray(value) ? value : [value];
      default:
        return value;
    }
  }

  private applyTransform(value: any, transform: string): any {
    switch (transform) {
      case 'timestamp':
        return typeof value === 'number' ? value : Date.now();
      case 'lowercase':
        return typeof value === 'string' ? value.toLowerCase() : value;
      case 'uppercase':
        return typeof value === 'string' ? value.toUpperCase() : value;
      default:
        return value;
    }
  }
}