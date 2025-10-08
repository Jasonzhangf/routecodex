/**
 * Protocol Analyzer Service
 * 协议分析和字段统计服务
 */

import { v4 as uuidv4 } from 'uuid';

export interface FieldInfo {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  size: number;
  frequency: number;
  samples: any[];
  depth: number;
  path: string;
}

export interface FieldAnalysis {
  fields: Map<string, FieldInfo>;
  totalFields: number;
  estimatedTokens: number;
  contentType: string;
  hasTools: boolean;
  hasStreaming: boolean;
  dataSize: number;
  complexity: 'simple' | 'medium' | 'complex';
}

export interface ProtocolRecord {
  id: string;
  timestamp: Date;
  protocol: string;
  direction: 'request' | 'response';
  data: any;
  analysis: FieldAnalysis;
  metadata: {
    size: number;
    processingTime: number;
    route: string;
    provider: string;
    requestId?: string;
  };
}

export class ProtocolAnalyzer {
  private fieldStats = new Map<string, FieldInfo>();
  private records: ProtocolRecord[] = [];
  private maxRecords = 1000; // 内存中最多保存1000条记录

  /**
   * 分析请求协议
   */
  analyzeRequest(data: any, protocol: string, metadata: Partial<ProtocolRecord['metadata']> = {}): FieldAnalysis {
    const startTime = Date.now();
    const analysis = this.analyzeObject(data, '', 0);

    // 添加协议特定分析
    this.addProtocolSpecificAnalysis(analysis, data, protocol, 'request');

    // 记录数据
    this.recordData(data, protocol, 'request', analysis, {
      ...metadata,
      size: JSON.stringify(data).length,
      processingTime: Date.now() - startTime
    });

    return analysis;
  }

  /**
   * 分析响应协议
   */
  analyzeResponse(data: any, protocol: string, metadata: Partial<ProtocolRecord['metadata']> = {}): FieldAnalysis {
    const startTime = Date.now();
    const analysis = this.analyzeObject(data, '', 0);

    // 添加协议特定分析
    this.addProtocolSpecificAnalysis(analysis, data, protocol, 'response');

    // 记录数据
    this.recordData(data, protocol, 'response', analysis, {
      ...metadata,
      size: JSON.stringify(data).length,
      processingTime: Date.now() - startTime
    });

    return analysis;
  }

  /**
   * 递归分析对象结构
   */
  private analyzeObject(obj: any, path: string = '', depth: number = 0): FieldAnalysis {
    const fields = new Map<string, FieldInfo>();
    let totalFields = 0;
    let estimatedTokens = 0;
    let dataSize = 0;

    if (obj === null || obj === undefined) {
      return {
        fields,
        totalFields: 0,
        estimatedTokens: 0,
        contentType: 'null',
        hasTools: false,
        hasStreaming: false,
        dataSize: 0,
        complexity: 'simple'
      };
    }

    const objStr = JSON.stringify(obj);
    dataSize = objStr.length;
    estimatedTokens = this.estimateTokens(objStr);

    if (typeof obj !== 'object') {
      // 基本类型
      const fieldName = path || 'value';
      const fieldType = this.getFieldType(obj);
      fields.set(fieldName, {
        name: fieldName,
        type: fieldType,
        size: objStr.length,
        frequency: 1,
        samples: [obj],
        depth,
        path
      });
      totalFields = 1;
    } else {
      // 对象类型
      for (const [key, value] of Object.entries(obj)) {
        const currentPath = path ? `${path}.${key}` : key;

        if (typeof value === 'object' && value !== null) {
          const nestedAnalysis = this.analyzeObject(value, currentPath, depth + 1);

          // 合并嵌套字段
          nestedAnalysis.fields.forEach((fieldInfo, fieldName) => {
            fields.set(fieldName, fieldInfo);
          });

          totalFields += nestedAnalysis.totalFields;
        } else {
          const fieldType = this.getFieldType(value);
          fields.set(currentPath, {
            name: currentPath,
            type: fieldType,
            size: JSON.stringify(value).length,
            frequency: 1,
            samples: [value],
            depth,
            path: currentPath
          });
          totalFields++;
        }
      }
    }

    // 更新全局统计
    this.updateFieldStats(fields);

    // 计算复杂度
    const complexity = this.calculateComplexity(fields, depth);

    return {
      fields,
      totalFields,
      estimatedTokens,
      contentType: this.detectContentType(obj),
      hasTools: this.detectTools(obj),
      hasStreaming: this.detectStreaming(obj),
      dataSize,
      complexity
    };
  }

  /**
   * 添加协议特定分析
   */
  private addProtocolSpecificAnalysis(analysis: FieldAnalysis, data: any, protocol: string, direction: 'request' | 'response') {
    if (protocol === 'openai') {
      this.analyzeOpenAIProtocol(analysis, data, direction);
    } else if (protocol === 'anthropic') {
      this.analyzeAnthropicProtocol(analysis, data, direction);
    }
  }

  /**
   * OpenAI协议特定分析
   */
  private analyzeOpenAIProtocol(analysis: FieldAnalysis, data: any, direction: 'request' | 'response') {
    // 检测模型特定字段
    if (direction === 'request' && data.model) {
      analysis.fields.set('model', {
        ...analysis.fields.get('model')!,
        type: 'string',
        samples: [data.model]
      });
    }

    // 检测工具调用
    if (data.tools && Array.isArray(data.tools)) {
      analysis.hasTools = true;
      analysis.complexity = 'complex';
    }

    // 检测流式响应
    if (data.stream === true || (data.choices && data.choices[0]?.delta)) {
      analysis.hasStreaming = true;
    }
  }

  /**
   * Anthropic协议特定分析
   */
  private analyzeAnthropicProtocol(analysis: FieldAnalysis, data: any, direction: 'request' | 'response') {
    // 检测Anthropic特定字段
    if (data.model) {
      analysis.fields.set('anthropic_model', {
        name: 'anthropic_model',
        type: 'string',
        size: data.model.length,
        frequency: 1,
        samples: [data.model],
        depth: 0,
        path: 'model'
      });
    }

    // 检测工具使用
    if (data.tools || data.tool_choice) {
      analysis.hasTools = true;
    }
  }

  /**
   * 获取字段类型
   */
  private getFieldType(value: any): FieldInfo['type'] {
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'object' && value !== null) return 'object';
    if (typeof value === 'string') return 'string';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    return 'object';
  }

  /**
   * 估算token数量
   */
  private estimateTokens(text: string): number {
    // 简单的token估算：大约4个字符 = 1个token
    return Math.ceil(text.length / 4);
  }

  /**
   * 检测内容类型
   */
  private detectContentType(obj: any): string {
    if (obj.messages && Array.isArray(obj.messages)) return 'chat_completion';
    if (obj.prompt) return 'completion';
    if (obj.embeddings) return 'embedding';
    if (obj.choices && Array.isArray(obj.choices)) return 'chat_response';
    if (obj.data && Array.isArray(obj.data)) return 'embedding_response';
    if (obj.model && obj.input) return 'vision_request';
    return 'unknown';
  }

  /**
   * 检测工具使用
   */
  private detectTools(obj: any): boolean {
    return !!(obj.tools || obj.tool_calls || obj.function_call);
  }

  /**
   * 检测流式传输
   */
  private detectStreaming(obj: any): boolean {
    return !!(obj.stream === true || obj.delta || obj.choices?.[0]?.delta);
  }

  /**
   * 计算复杂度
   */
  private calculateComplexity(fields: Map<string, FieldInfo>, maxDepth: number): 'simple' | 'medium' | 'complex' {
    const fieldCount = fields.size;

    if (fieldCount <= 5 && maxDepth <= 2) return 'simple';
    if (fieldCount <= 20 && maxDepth <= 4) return 'medium';
    return 'complex';
  }

  /**
   * 更新字段统计
   */
  private updateFieldStats(fields: Map<string, FieldInfo>) {
    fields.forEach((fieldInfo, fieldName) => {
      const existing = this.fieldStats.get(fieldName);
      if (existing) {
        existing.frequency++;
        if (existing.samples.length < 10) {
          existing.samples.push(fieldInfo.samples[0]);
        }
      } else {
        this.fieldStats.set(fieldName, { ...fieldInfo });
      }
    });
  }

  /**
   * 记录数据
   */
  private recordData(data: any, protocol: string, direction: 'request' | 'response', analysis: FieldAnalysis, metadata: any) {
    const record: ProtocolRecord = {
      id: uuidv4(),
      timestamp: new Date(),
      protocol,
      direction,
      data: this.sanitizeData(data),
      analysis,
      metadata
    };

    // 添加到记录列表
    this.records.unshift(record);

    // 限制记录数量
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(0, this.maxRecords);
    }
  }

  /**
   * 清理敏感数据
   */
  private sanitizeData(data: any): any {
    if (typeof data !== 'object' || data === null) {
      return data;
    }

    const sanitized = Array.isArray(data) ? [] : {};

    for (const [key, value] of Object.entries(data)) {
      // 清理可能的敏感字段
      if (this.isSensitiveField(key)) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = this.sanitizeData(value);
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  /**
   * 检测敏感字段
   */
  private isSensitiveField(key: string): boolean {
    const sensitiveKeys = ['api_key', 'authorization', 'token', 'password', 'secret'];
    return sensitiveKeys.some(sensitive => key.toLowerCase().includes(sensitive));
  }

  /**
   * 获取字段统计
   */
  getFieldStats(): Map<string, FieldInfo> {
    return new Map(this.fieldStats);
  }

  /**
   * 获取记录列表
   */
  getRecords(limit: number = 50): ProtocolRecord[] {
    return this.records.slice(0, limit);
  }

  /**
   * 获取协议统计
   */
  getProtocolStats() {
    const stats = {
      totalRequests: 0,
      totalResponses: 0,
      protocols: new Map<string, number>(),
      contentTypes: new Map<string, number>(),
      averageTokens: 0,
      totalDataSize: 0
    };

    this.records.forEach(record => {
      if (record.direction === 'request') {
        stats.totalRequests++;
      } else {
        stats.totalResponses++;
      }

      const protocolCount = stats.protocols.get(record.protocol) || 0;
      stats.protocols.set(record.protocol, protocolCount + 1);

      const contentTypeCount = stats.contentTypes.get(record.analysis.contentType) || 0;
      stats.contentTypes.set(record.analysis.contentType, contentTypeCount + 1);

      stats.totalDataSize += record.analysis.dataSize;
    });

    stats.averageTokens = this.records.reduce((sum, record) =>
      sum + record.analysis.estimatedTokens, 0) / this.records.length || 0;

    return stats;
  }

  /**
   * 清理数据
   */
  clear() {
    this.fieldStats.clear();
    this.records = [];
  }
}

// 导出单例
export const protocolAnalyzer = new ProtocolAnalyzer();