import type { UnknownObject } from '../../../../modules/pipeline/types/common-types.js';
import type { ModuleDependencies } from '../../../../modules/pipeline/types/module.types.js';
import * as fs from 'fs/promises';
import * as path from 'path';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

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
 * iFlow字段映射处理器
 * 负责OpenAI格式与iFlow格式之间的字段转换
 */
export class iFlowFieldMappingProcessor {
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

      this.dependencies.logger?.logModule('iflow-field-mapping', 'initialized', {
        incomingMappings: this.config?.incomingMappings.length || 0,
        outgoingMappings: this.config?.outgoingMappings.length || 0
      });
    } catch (error) {
      this.dependencies.logger?.logError?.(error as Error, {
        component: 'iFlowFieldMappingProcessor',
        stage: 'initialize'
      });
      throw error;
    }
  }

  async mapIncoming(request: UnknownObject): Promise<UnknownObject> {
    if (!this.isInitialized || !this.config) {
      throw new Error('iFlowFieldMappingProcessor not initialized');
    }

    this.dependencies.logger?.logModule('iflow-field-mapping', 'mapIncoming-start', {
      mappingsCount: this.config.incomingMappings.length
    });

    try {
      // Provider-specific: sanitize iFlow tools schema to avoid unsupported JSON Schema features (e.g., oneOf)
      this.sanitizeiFlowToolsSchema(request);
      const result = this.applyMappings(request, this.config.incomingMappings);

      this.dependencies.logger?.logModule('iflow-field-mapping', 'mapIncoming-success', {
        appliedMappings: this.config.incomingMappings.length
      });

      return result;
    } catch (error) {
      this.dependencies.logger?.logError?.(error as Error, {
        component: 'iFlowFieldMappingProcessor',
        stage: 'mapIncoming'
      });
      throw error;
    }
  }

  async mapOutgoing(response: UnknownObject): Promise<UnknownObject> {
    if (!this.isInitialized || !this.config) {
      throw new Error('iFlowFieldMappingProcessor not initialized');
    }

    this.dependencies.logger?.logModule('iflow-field-mapping', 'mapOutgoing-start', {
      mappingsCount: this.config.outgoingMappings.length
    });

    try {
      const result = this.applyMappings(response, this.config.outgoingMappings);

      this.dependencies.logger?.logModule('iflow-field-mapping', 'mapOutgoing-success', {
        appliedMappings: this.config.outgoingMappings.length
      });

      return result;
    } catch (error) {
      this.dependencies.logger?.logError?.(error as Error, {
        component: 'iFlowFieldMappingProcessor',
        stage: 'mapOutgoing'
      });
      throw error;
    }
  }

  async cleanup(): Promise<void> {
    this.config = null;
    this.isInitialized = false;

    this.dependencies.logger?.logModule('iflow-field-mapping', 'cleanup-complete', {});
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
      this.dependencies.logger?.logModule('iflow-field-mapping', 'using-default-config', {});
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
        // iFlow格式 -> OpenAI格式的映射
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
        // OpenAI格式 -> iFlow格式的映射
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
    const result: UnknownObject = { ...data };

    for (const mapping of mappings) {
      this.applyMapping(result, mapping);
    }

    return result;
  }

  /**
   * iFlow 接受的工具 schema 比较保守：去掉 oneOf，使用明确的类型定义。
   * 这里对 shell 工具的 parameters.properties.command 统一为 { type: 'array', items: { type: 'string' } }。
   * 注意：这是 provider 层的 schema 约束标准化，不涉及工具调用的语义转换。
   */
  private sanitizeiFlowToolsSchema(data: UnknownObject): void {
    try {
      const toolsCandidate = (data as { tools?: unknown }).tools;
      if (!Array.isArray(toolsCandidate)) {
        return;
      }

      for (const toolItem of toolsCandidate) {
        if (!isRecord(toolItem)) {
          continue;
        }
        const fnCandidate = toolItem['function'];
        const fn = isRecord(fnCandidate) ? fnCandidate : undefined;
        if (!fn) {
          continue;
        }

        if ('strict' in fn) {
          delete (fn as Record<string, unknown>).strict;
        }

        const name = typeof fn.name === 'string' ? fn.name : undefined;
        const params = isRecord(fn.parameters) ? fn.parameters : undefined;
        if (!params || !name) {
          continue;
        }

        const props = isRecord(params.properties) ? (params.properties as Record<string, unknown>) : undefined;
        if (!props) {
          continue;
        }

        if (name === 'shell') {
          const existingCommand = props.command;
          if (isRecord(existingCommand)) {
            delete existingCommand.oneOf;
            existingCommand.type = 'array';
            existingCommand.items = { type: 'string' };
            if (typeof existingCommand.description !== 'string' || existingCommand.description.length === 0) {
              existingCommand.description = 'Shell command argv tokens. Use ["bash","-lc","<cmd>"] form.';
            }
          } else {
            props.command = {
              description: 'Shell command argv tokens. Use ["bash","-lc","<cmd>"] form.',
              type: 'array',
              items: { type: 'string' }
            };
          }

          if (!Array.isArray(params.required)) {
            params.required = [];
          }
          const required = params.required as unknown[];
          if (!required.includes('command')) {
            required.push('command');
          }

          if (typeof params.type !== 'string') {
            params.type = 'object';
          }

          if (typeof params.additionalProperties !== 'boolean') {
            params.additionalProperties = false;
          }
        }
      }
    } catch {
      // 非关键路径，保守忽略
    }
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

  private getNestedProperty(obj: UnknownObject, path: string): unknown {
    const keys = path.split('.');

    // 处理通配符路径，如 choices[*].message.tool_calls
    if (path.includes('[*]')) {
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

      if (key.includes('[*]')) {
        const baseKey = key.replace('[*]', '');
        const target = baseKey ? (isRecord(current) ? current[baseKey] : undefined) : current;
        if (Array.isArray(target)) {
          target.forEach(item => {
            processWildcard(item, keyIndex + 1);
          });
        }
      } else if (isRecord(current) && current[key] !== undefined) {
        processWildcard(current[key], keyIndex + 1);
      }
    };

    processWildcard(obj, 0);
    return results;
  }

  private setNestedProperty(obj: UnknownObject, path: string, value: unknown): void {
    const keys = path.split('.');

    // 处理通配符路径，如 choices[*].message.tool_calls
    if (path.includes('[*]')) {
      this.setWildcardProperty(obj, keys, value);
      return;
    }

    const lastKey = keys.pop()!;

    const target = keys.reduce<UnknownObject>((current, key) => {
      if (!isRecord(current[key])) {
        current[key] = {};
      }
      return current[key] as UnknownObject;
    }, obj);

    target[lastKey] = value;
  }

  private setWildcardProperty(obj: UnknownObject, keys: string[], value: unknown): void {
    const processSetWildcard = (current: unknown, keyIndex: number, valueToSet: unknown): void => {
      if (keyIndex >= keys.length - 1) {
        const lastKey = keys[keyIndex].replace('[*]', '');
        if (Array.isArray(current)) {
          current.forEach(item => {
            if (isRecord(item)) {
              item[lastKey] = valueToSet;
            }
          });
        }
        return;
      }

      const key = keys[keyIndex];

      if (key.includes('[*]')) {
        const baseKey = key.replace('[*]', '');
        const target = baseKey ? (isRecord(current) ? current[baseKey] : undefined) : current;
        if (Array.isArray(target)) {
          target.forEach(item => {
            processSetWildcard(item, keyIndex + 1, valueToSet);
          });
        }
      } else if (isRecord(current)) {
        processSetWildcard(current[key], keyIndex + 1, valueToSet);
      }
    };

    processSetWildcard(obj, 0, value);
  }

  private convertType(value: unknown, targetType: FieldMapping['type']): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    switch (targetType) {
      case 'string':
        return String(value);
      case 'number':
        {
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
        return typeof value === 'string' ? value.replace(/^gpt-/, 'iflow-') : value;
      case 'extractReasoningBlocks':
        return typeof value === 'string' ? this.extractReasoningBlocks(value) : value;
      case 'normalizeFinishReason':
        return typeof value === 'string' ? this.normalizeFinishReason(value) : value;
      default:
        return value;
    }
  }

  private extractReasoningBlocks(content: string): string {
    const reasoningPatterns = [
      /<reasoning>([\s\S]*?)<\/reasoning>/i,
      /<thinking>([\s\S]*?)<\/thinking>/i,
      /\[REASONING\]([\s\S]*?)\[\/REASONING\]/i,
      /\[THINKING\]([\s\S]*?)\[\/THINKING\]/i
    ];

    for (const pattern of reasoningPatterns) {
      const match = pattern.exec(content);
      if (match?.[1]) {
        pattern.lastIndex = 0;
        return match[1].trim();
      }
      pattern.lastIndex = 0;
    }
    return content;
  }

  private normalizeFinishReason(reason: string): string {
    // 标准化结束原因
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
