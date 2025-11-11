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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((v1Data as any).compatPre && (v2Data as any).providerRequest) {
      // V1的compat-pre应该包含V2的provider request信息
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const v1Request = this.extractProviderRequestFromV1((v1Data as any).compatPre);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const v2Request = (v2Data as any).providerRequest;

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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((v1Data as any).providerResponse && (v2Data as any).providerResponse) {
      this.compareObjects(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.normalizeResponse((v1Data as any).providerResponse),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.normalizeResponse((v2Data as any).providerResponse),
        'provider-response',
        differences
      );
    }

    return {
      category: 'provider-response',
      passed: differences.length === 0,
      details: differences.length === 0
        ? 'Provider responses are consistent'
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((v1Data as any).compatPost && (v2Data as any).finalResponse) {
      this.compareObjects(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.normalizeResponse((v1Data as any).compatPost),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.normalizeResponse((v2Data as any).finalResponse),
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
        severity: 'major',
        reason: 'Type mismatch'
      });
      return;
    }

    if (obj1 === null || obj2 === null || typeof obj1 !== 'object') {
      if (obj1 !== obj2) {
        differences.push({
          path: basePath,
          v1Value: obj1,
          v2Value: obj2,
          severity: 'major',
          reason: 'Value mismatch'
        });
      }
      return;
    }

    // 比较对象的键
    const keys1 = Object.keys(obj1).sort();
    const keys2 = Object.keys(obj2).sort();

    if (JSON.stringify(keys1) !== JSON.stringify(keys2)) {
      differences.push({
        path: basePath,
        v1Value: keys1,
        v2Value: keys2,
        severity: 'major',
        reason: 'Object keys mismatch'
      });
    }

    // 比较每个键的值
    for (const key of keys1) {
      if (keys2.includes(key)) {
        const path = basePath === '' ? key : `${basePath}.${key}`;
        
        // 跳过忽略的字段
        if (this.ignoreFields.some(field => path.includes(field))) {
          continue;
        }

        this.compareObjects(obj1[key], obj2[key], path, differences);
      }
    }
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
    const sources: any[] = [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (data as any).compatPre,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (data as any).compatPost,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (data as any).providerRequest,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (data as any).providerResponse,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (data as any).finalResponse
    ];

    for (const source of sources) {
      if (source) {
        // OpenAI格式
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((source as any).choices?.[0]?.message?.tool_calls) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          toolCalls.push(...(source as any).choices[0].message.tool_calls);
        }
        // Anthropic格式
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((source as any).content && Array.isArray((source as any).content)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const toolUses = (source as any).content.filter((c: any) => c.type === 'tool_use');
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
   * 递归移除指定字段
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
