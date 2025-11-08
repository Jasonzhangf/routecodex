/**
 * 一致性验证工具
 */

import { ConsistencyCheck, ConsistencyDifference, V1ProcessingData, V2ProcessingData } from './consistency-types.js';

export class ConsistencyValidator {
  private ignoreFields: string[] = [
    'created',
    'created_at', 
    'timestamp',
    'request_id',
    'id',
    'meta.buildTime',
    'meta.version'
  ];

  private tolerance = {
    timeDifference: 5000, // 5秒
    numericPrecision: 6   // 6位小数
  };

  /**
   * 验证V1和V2数据的一致性
   */
  async validateConsistency(
    v1Data: V1ProcessingData,
    v2Data: V2ProcessingData
  ): Promise<ConsistencyCheck[]> {
    const checks: ConsistencyCheck[] = [];

    // Provider请求一致性检查
    const providerRequestCheck = this.validateProviderRequest(v1Data, v2Data);
    checks.push(providerRequestCheck);

    // Provider响应一致性检查
    const providerResponseCheck = this.validateProviderResponse(v1Data, v2Data);
    checks.push(providerResponseCheck);

    // 工具处理一致性检查
    const toolProcessingCheck = this.validateToolProcessing(v1Data, v2Data);
    checks.push(toolProcessingCheck);

    // 最终响应一致性检查
    const finalResponseCheck = this.validateFinalResponse(v1Data, v2Data);
    checks.push(finalResponseCheck);

    return checks;
  }

  /**
   * 验证Provider请求一致性
   */
  private validateProviderRequest(
    v1Data: V1ProcessingData,
    v2Data: V2ProcessingData
  ): ConsistencyCheck {
    const differences: ConsistencyDifference[] = [];

    // 检查URL
    if (v1Data.compatPre && v2Data.providerRequest) {
      // V1的compat-pre应该包含V2的provider request信息
      const v1Request = this.extractProviderRequestFromV1(v1Data.compatPre);
      const v2Request = v2Data.providerRequest;

      if (v1Request && v2Request) {
        this.compareObjects(
          v1Request,
          v2Request,
          'provider-request',
          differences
        );
      }
    }

    return {
      category: 'provider-request',
      passed: differences.length === 0,
      details: differences.length === 0 
        ? 'Provider request structures are consistent'
        : `Found ${differences.length} differences in provider request`,
      differences
    };
  }

  /**
   * 验证Provider响应一致性
   */
  private validateProviderResponse(
    v1Data: V1ProcessingData,
    v2Data: V2ProcessingData
  ): ConsistencyCheck {
    const differences: ConsistencyDifference[] = [];

    if (v1Data.providerResponse && v2Data.providerResponse) {
      this.compareObjects(
        this.normalizeResponse(v1Data.providerResponse),
        this.normalizeResponse(v2Data.providerResponse),
        'provider-response',
        differences
      );
    }

    return {
      category: 'provider-response',
      passed: differences.length === 0,
      details: differences.length === 0
        ? 'Provider response structures are consistent'
        : `Found ${differences.length} differences in provider response`,
      differences
    };
  }

  /**
   * 验证工具处理一致性
   */
  private validateToolProcessing(
    v1Data: V1ProcessingData,
    v2Data: V2ProcessingData
  ): ConsistencyCheck {
    const differences: ConsistencyDifference[] = [];

    // 检查工具调用数量
    const v1ToolCalls = this.extractToolCalls(v1Data);
    const v2ToolCalls = this.extractToolCalls(v2Data);

    if (v1ToolCalls.length !== v2ToolCalls.length) {
      differences.push({
        path: 'tool_calls.length',
        v1Value: v1ToolCalls.length,
        v2Value: v2ToolCalls.length,
        severity: 'critical',
        reason: 'Tool call count mismatch'
      });
    } else {
      // 比较每个工具调用
      for (let i = 0; i < v1ToolCalls.length; i++) {
        this.compareObjects(
          v1ToolCalls[i],
          v2ToolCalls[i],
          `tool_calls[${i}]`,
          differences
        );
      }
    }

    return {
      category: 'tool-processing',
      passed: differences.length === 0,
      details: differences.length === 0
        ? 'Tool processing is consistent'
        : `Found ${differences.length} differences in tool processing`,
      differences
    };
  }

  /**
   * 验证最终响应一致性
   */
  private validateFinalResponse(
    v1Data: V1ProcessingData,
    v2Data: V2ProcessingData
  ): ConsistencyCheck {
    const differences: ConsistencyDifference[] = [];

    if (v1Data.compatPost && v2Data.finalResponse) {
      this.compareObjects(
        this.normalizeResponse(v1Data.compatPost),
        this.normalizeResponse(v2Data.finalResponse),
        'final-response',
        differences
      );
    }

    return {
      category: 'final-response',
      passed: differences.length === 0,
      details: differences.length === 0
        ? 'Final response structures are consistent'
        : `Found ${differences.length} differences in final response`,
      differences
    };
  }

  /**
   * 比较两个对象
   */
  private compareObjects(
    obj1: any,
    obj2: any,
    basePath: string,
    differences: ConsistencyDifference[]
  ): void {
    if (obj1 === null && obj2 === null) return;
    if (obj1 === undefined && obj2 === undefined) return;
    
    if (typeof obj1 !== typeof obj2) {
      differences.push({
        path: basePath,
        v1Value: obj1,
        v2Value: obj2,
        severity: 'critical',
        reason: 'Type mismatch'
      });
      return;
    }

    if (typeof obj1 === 'object' && obj1 !== null && obj2 !== null) {
      const keys1 = Object.keys(obj1);
      const keys2 = Object.keys(obj2);
      const allKeys = new Set([...keys1, ...keys2]);

      for (const key of allKeys) {
        const path = basePath ? `${basePath}.${key}` : key;
        
        // 跳过忽略的字段
        if (this.ignoreFields.some(field => path.includes(field))) {
          continue;
        }

        if (!(key in obj1)) {
          differences.push({
            path,
            v1Value: undefined,
            v2Value: obj2[key],
            severity: 'major',
            reason: 'Field missing in V1'
          });
        } else if (!(key in obj2)) {
          differences.push({
            path,
            v1Value: obj1[key],
            v2Value: undefined,
            severity: 'major',
            reason: 'Field missing in V2'
          });
        } else {
          this.compareObjects(obj1[key], obj2[key], path, differences);
        }
      }
    } else {
      // 基本类型比较
      const isEqual = this.compareBasicValues(obj1, obj2);
      if (!isEqual) {
        differences.push({
          path: basePath,
          v1Value: obj1,
          v2Value: obj2,
          severity: this.determineSeverity(basePath, obj1, obj2),
          reason: 'Value mismatch'
        });
      }
    }
  }

  /**
   * 比较基本值
   */
  private compareBasicValues(val1: any, val2: any): boolean {
    if (val1 === val2) return true;
    
    // 数值比较（带容差）
    if (typeof val1 === 'number' && typeof val2 === 'number') {
      return Math.abs(val1 - val2) < Math.pow(10, -this.tolerance.numericPrecision);
    }
    
    // 字符串比较（去除多余空格）
    if (typeof val1 === 'string' && typeof val2 === 'string') {
      return val1.trim() === val2.trim();
    }
    
    return false;
  }

  /**
   * 确定差异严重程度
   */
  private determineSeverity(path: string, val1: any, val2: any): 'critical' | 'major' | 'minor' {
    // 工具相关差异是关键的
    if (path.includes('tool') || path.includes('function')) {
      return 'critical';
    }
    
    // 内容相关差异是重要的
    if (path.includes('content') || path.includes('message')) {
      return 'major';
    }
    
    // 元数据差异是次要的
    if (path.includes('usage') || path.includes('model')) {
      return 'minor';
    }
    
    // 默认为重要
    return 'major';
  }

  /**
   * 从V1数据中提取Provider请求
   */
  private extractProviderRequestFromV1(compatPre: any): any {
    // V1的compat-pre应该包含发送给Provider的请求信息
    return compatPre;
  }

  /**
   * 提取工具调用
   */
  private extractToolCalls(data: V1ProcessingData | V2ProcessingData): any[] {
    const toolCalls: any[] = [];

    // 从各个阶段提取工具调用
    const sources = [
      data.compatPre,
      data.compatPost,
      data.providerRequest,
      data.providerResponse,
      data.finalResponse
    ];

    for (const source of sources) {
      if (source) {
        // OpenAI格式
        if (source.choices?.[0]?.message?.tool_calls) {
          toolCalls.push(...source.choices[0].message.tool_calls);
        }
        // Anthropic格式
        if (source.content && Array.isArray(source.content)) {
          const toolUses = source.content.filter((c: any) => c.type === 'tool_use');
          toolCalls.push(...toolUses);
        }
      }
    }

    return toolCalls;
  }

  /**
   * 标准化响应格式
   */
  private normalizeResponse(response: any): any {
    // 深拷贝以避免修改原始数据
    const normalized = JSON.parse(JSON.stringify(response));

    // 移除忽略的字段
    this.removeFields(normalized, this.ignoreFields);

    return normalized;
  }

  /**
   * 递归移除字段
   */
  private removeFields(obj: any, fields: string[]): void {
    if (typeof obj !== 'object' || obj === null) return;

    for (const field of fields) {
      if (field.includes('.')) {
        // 嵌套字段
        const parts = field.split('.');
        let current = obj;
        for (let i = 0; i < parts.length - 1; i++) {
          if (current[parts[i]]) {
            current = current[parts[i]];
          } else {
            break;
          }
        }
        delete current[parts[parts.length - 1]];
      } else {
        // 顶级字段
        delete obj[field];
      }
    }

    // 递归处理嵌套对象
    for (const key in obj) {
      if (typeof obj[key] === 'object' && obj[key] !== null) {
        this.removeFields(obj[key], fields);
      }
    }
  }
}
