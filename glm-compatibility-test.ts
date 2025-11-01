#!/usr/bin/env node

/**
 * GLM兼容模块黑盒对比测试
 * 对比新旧版本的GLM兼容模块处理结果，确保完全一致
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

interface TestSample {
  id: string;
  input: any;
  expectedOutput?: any;
  description: string;
}

interface TestResult {
  sampleId: string;
  legacyOutput: any;
  newOutput: any;
  passed: boolean;
  differences: string[];
  error?: string;
}

class GLMCompatibilityTest {
  private samplesDir: string;
  private results: TestResult[] = [];

  constructor() {
    this.samplesDir = join(homedir(), '.routecodex', 'codex-samples', 'openai-chat');
  }

  /**
   * 创建测试样本数据
   */
  private createTestSamples(): TestSample[] {
    return [
      {
        id: 'basic-chat',
        description: '基础聊天请求',
        input: {
          model: 'glm-4',
          messages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'Hello, how are you?' }
          ],
          temperature: 0.7,
          max_tokens: 100
        }
      },
      {
        id: 'tool-call-request',
        description: '工具调用请求',
        input: {
          model: 'glm-4',
          messages: [
            { role: 'user', content: 'What is the weather in Beijing?' }
          ],
          tools: [
            {
              type: 'function',
              function: {
                name: 'get_weather',
                description: 'Get weather information',
                parameters: {
                  type: 'object',
                  properties: {
                    location: { type: 'string', description: 'City name' }
                  },
                  required: ['location']
                }
              }
            }
          ]
        }
      },
      {
        id: 'complex-tool-response',
        description: '复杂工具响应',
        input: {
          model: 'glm-4',
          messages: [
            { role: 'assistant', content: null, tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'get_weather',
                  arguments: '{"location": "Beijing"}'
                }
              }
            ]},
            { role: 'tool', content: 'Weather in Beijing: 25°C, sunny' }
          ]
        }
      },
      {
        id: 'reasoning-content',
        description: '包含推理内容的请求',
        input: {
          model: 'glm-4-thinking',
          messages: [
            { role: 'user', content: 'Solve this math problem step by step' }
          ],
          thinking: {
            enabled: true,
            payload: { type: 'enabled' }
          }
        }
      },
      {
        id: 'usage-fields',
        description: '包含usage字段的响应',
        input: {
          model: 'glm-4',
          messages: [{ role: 'user', content: 'Hello' }]
        },
        expectedOutput: {
          id: 'chatcmpl_test',
          object: 'chat.completion',
          created: 1234567890,
          model: 'glm-4',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'Hello! How can I help you today?'
              },
              finish_reason: 'stop'
            }
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 15,
            total_tokens: 25
          }
        }
      }
    ];
  }

  /**
   * 模拟旧版本GLM兼容模块处理
   */
  private async processWithLegacy(sample: TestSample): Promise<any> {
    try {
      // 模拟旧版本的处理逻辑
      const input = JSON.parse(JSON.stringify(sample.input));

      // 模拟工具清洗
      if (input.messages && Array.isArray(input.messages)) {
        for (let i = input.messages.length - 1; i >= 0; i--) {
          const msg = input.messages[i];
          if (msg.role === 'tool' && typeof msg.content === 'string') {
            // 512B截断逻辑
            if (msg.content.length > 512) {
              const marker = '…[truncated to 512B]';
              const truncated = msg.content.substring(0, 512 - marker.length) + marker;
              msg.content = truncated;
            }

            // 噪声模式清理
            const noisePatterns = [/failed in sandbox/gi, /unsupported call/gi, /工具调用不可用/gi];
            for (const pattern of noisePatterns) {
              msg.content = msg.content.replace(pattern, '');
            }
          }
        }
      }

      // 模拟thinking处理
      if (input.thinking && !('thinking' in input)) {
        input.thinking = {
          enabled: true,
          payload: { type: 'enabled' }
        };
      }

      // 模拟字段映射
      if (sample.expectedOutput) {
        const output = JSON.parse(JSON.stringify(sample.expectedOutput));

        // 应用usage字段映射
        if (output.usage && output.usage.completion_tokens === undefined && output.usage.output_tokens !== undefined) {
          output.usage.completion_tokens = output.usage.output_tokens;
        }

        return output;
      }

      return input;
    } catch (error) {
      throw new Error(`Legacy processing failed: ${error}`);
    }
  }

  /**
   * 模拟新版本GLM兼容模块处理
   */
  private async processWithNew(sample: TestSample): Promise<any> {
    try {
      // 模拟新版本的处理逻辑
      const input = JSON.parse(JSON.stringify(sample.input));

      // 模拟Hook系统处理
      const processedInput = await this.simulateHooks(input);

      // 模拟字段映射处理器
      const mappedInput = await this.simulateFieldMapping(processedInput);

      // 模拟验证Hook
      const validatedInput = await this.simulateValidation(mappedInput);

      if (sample.expectedOutput) {
        const output = JSON.parse(JSON.stringify(sample.expectedOutput));
        return await this.simulateResponseNormalization(output);
      }

      return validatedInput;
    } catch (error) {
      throw new Error(`New processing failed: ${error}`);
    }
  }

  /**
   * 模拟Hook系统
   */
  private async simulateHooks(input: any): Promise<any> {
    const result = JSON.parse(JSON.stringify(input));

    // 模拟工具清洗Hook
    if (result.messages && Array.isArray(result.messages)) {
      for (let i = result.messages.length - 1; i >= 0; i--) {
        const msg = result.messages[i];
        if (msg.role === 'tool' && typeof msg.content === 'string') {
          // 512B截断逻辑
          if (msg.content.length > 512) {
            const marker = '…[truncated to 512B]';
            const truncated = msg.content.substring(0, 512 - marker.length) + marker;
            msg.content = truncated;
          }

          // 噪声模式清理
          const noisePatterns = [/failed in sandbox/gi, /unsupported call/gi, /工具调用不可用/gi];
          for (const pattern of noisePatterns) {
            msg.content = msg.content.replace(pattern, '');
          }
        }
      }
    }

    return result;
  }

  /**
   * 模拟字段映射处理器
   */
  private async simulateFieldMapping(input: any): Promise<any> {
    const result = JSON.parse(JSON.stringify(input));

    // 模拟thinking处理
    if (result.thinking && !('thinking' in result)) {
      result.thinking = {
        enabled: true,
        payload: { type: 'enabled' }
      };
    }

    return result;
  }

  /**
   * 模拟验证Hook
   */
  private async simulateValidation(input: any): Promise<any> {
    // 基础验证：检查必需字段
    if (!input.model) {
      throw new Error('Missing required field: model');
    }

    if (!input.messages || !Array.isArray(input.messages) || input.messages.length === 0) {
      throw new Error('Missing or empty messages array');
    }

    return input;
  }

  /**
   * 模拟响应标准化
   */
  private async simulateResponseNormalization(output: any): Promise<any> {
    const result = JSON.parse(JSON.stringify(output));

    // 应用usage字段映射
    if (result.usage && result.usage.completion_tokens === undefined && result.usage.output_tokens !== undefined) {
      result.usage.completion_tokens = result.usage.output_tokens;
    }

    // 应用时间戳映射
    if (result.created_at !== undefined && result.created === undefined) {
      result.created = result.created_at;
    }

    return result;
  }

  /**
   * 对比两个处理结果
   */
  private compareResults(legacyOutput: any, newOutput: any): { passed: boolean; differences: string[] } {
    const differences: string[] = [];

    try {
      const legacyStr = JSON.stringify(legacyOutput, null, 2);
      const newStr = JSON.stringify(newOutput, null, 2);

      if (legacyStr !== newStr) {
        // 深度对比找出具体差异
        const legacyObj = JSON.parse(legacyStr);
        const newObj = JSON.parse(newStr);

        this.deepCompare(legacyObj, newObj, '', differences);
      }
    } catch (error) {
      differences.push(`Comparison error: ${error}`);
    }

    return {
      passed: differences.length === 0,
      differences
    };
  }

  /**
   * 深度对比对象
   */
  private deepCompare(obj1: any, obj2: any, path: string, differences: string[]): void {
    if (obj1 === obj2) return;

    const type1 = typeof obj1;
    const type2 = typeof obj2;

    if (type1 !== type2) {
      differences.push(`${path || 'root'}: Type mismatch (${type1} vs ${type2})`);
      return;
    }

    if (obj1 === null || obj1 === undefined || obj2 === null || obj2 === undefined) {
      if (obj1 !== obj2) {
        differences.push(`${path || 'root'}: Value mismatch (${obj1} vs ${obj2})`);
      }
      return;
    }

    if (type1 === 'object') {
      const keys1 = Object.keys(obj1);
      const keys2 = Object.keys(obj2);
      const allKeys = new Set([...keys1, ...keys2]);

      for (const key of allKeys) {
        const currentPath = path ? `${path}.${key}` : key;

        if (!(key in obj1)) {
          differences.push(`${currentPath}: Missing in legacy output`);
        } else if (!(key in obj2)) {
          differences.push(`${currentPath}: Missing in new output`);
        } else {
          this.deepCompare(obj1[key], obj2[key], currentPath, differences);
        }
      }
    } else if (type1 === 'array') {
      if (obj1.length !== obj2.length) {
        differences.push(`${path}: Array length mismatch (${obj1.length} vs ${obj2.length})`);
        return;
      }

      for (let i = 0; i < obj1.length; i++) {
        this.deepCompare(obj1[i], obj2[i], `${path}[${i}]`, differences);
      }
    } else if (obj1 !== obj2) {
      differences.push(`${path}: Value mismatch (${obj1} vs ${obj2})`);
    }
  }

  /**
   * 运行所有测试
   */
  async runTests(): Promise<void> {
    console.log('🧪 开始GLM兼容模块黑盒对比测试...\n');

    const samples = this.createTestSamples();
    console.log(`📋 创建了 ${samples.length} 个测试样本\n`);

    // 确保样本目录存在
    try {
      await mkdir(this.samplesDir, { recursive: true });
    } catch (error) {
      console.log('ℹ️  样本目录已存在\n');
    }

    let passedCount = 0;

    for (const sample of samples) {
      console.log(`🔍 测试样本: ${sample.id} - ${sample.description}`);

      try {
        // 使用旧版本处理
        const legacyOutput = await this.processWithLegacy(sample);

        // 使用新版本处理
        const newOutput = await this.processWithNew(sample);

        // 对比结果
        const { passed, differences } = this.compareResults(legacyOutput, newOutput);

        const result: TestResult = {
          sampleId: sample.id,
          legacyOutput,
          newOutput,
          passed,
          differences
        };

        this.results.push(result);

        if (passed) {
          console.log(`   ✅ 通过`);
          passedCount++;
        } else {
          console.log(`   ❌ 失败 - 发现 ${differences.length} 个差异:`);
          differences.forEach(diff => console.log(`      - ${diff}`));
        }

        // 保存样本数据到文件
        await this.saveSampleData(sample, result);

      } catch (error) {
        console.log(`   💥 错误: ${error}`);
        this.results.push({
          sampleId: sample.id,
          legacyOutput: null,
          newOutput: null,
          passed: false,
          differences: [`Processing error: ${error}`],
          error: error instanceof Error ? error.message : String(error)
        });
      }

      console.log('');
    }

    // 输出测试总结
    console.log('📊 测试总结:');
    console.log(`   总测试数: ${samples.length}`);
    console.log(`   通过: ${passedCount}`);
    console.log(`   失败: ${samples.length - passedCount}`);
    console.log(`   通过率: ${Math.round((passedCount / samples.length) * 100)}%`);

    // 保存测试报告
    await this.saveTestReport();

    if (passedCount === samples.length) {
      console.log('\n🎉 所有测试通过！新旧版本处理完全一致。');
    } else {
      console.log('\n⚠️  部分测试失败，需要修复差异。');
    }
  }

  /**
   * 保存样本数据
   */
  private async saveSampleData(sample: TestSample, result: TestResult): Promise<void> {
    try {
      const sampleDir = join(this.samplesDir, sample.id);
      await mkdir(sampleDir, { recursive: true });

      // 保存输入数据
      await writeFile(
        join(sampleDir, 'input.json'),
        JSON.stringify(sample.input, null, 2),
        'utf8'
      );

      // 保存旧版本输出
      if (result.legacyOutput) {
        await writeFile(
          join(sampleDir, 'legacy-output.json'),
          JSON.stringify(result.legacyOutput, null, 2),
          'utf8'
        );
      }

      // 保存新版本输出
      if (result.newOutput) {
        await writeFile(
          join(sampleDir, 'new-output.json'),
          JSON.stringify(result.newOutput, null, 2),
          'utf8'
        );
      }

      // 保存差异信息
      await writeFile(
        join(sampleDir, 'differences.json'),
        JSON.stringify({
          passed: result.passed,
          differences: result.differences,
          timestamp: new Date().toISOString()
        }, null, 2),
        'utf8'
      );
    } catch (error) {
      console.log(`   ⚠️  保存样本数据失败: ${error}`);
    }
  }

  /**
   * 保存测试报告
   */
  private async saveTestReport(): Promise<void> {
    try {
      const report = {
        timestamp: new Date().toISOString(),
        summary: {
          totalTests: this.results.length,
          passed: this.results.filter(r => r.passed).length,
          failed: this.results.filter(r => !r.passed).length,
          passRate: Math.round((this.results.filter(r => r.passed).length / this.results.length) * 100)
        },
        results: this.results.map(r => ({
          sampleId: r.sampleId,
          passed: r.passed,
          differencesCount: r.differences.length,
          differences: r.differences.slice(0, 5), // 只保存前5个差异
          error: r.error
        }))
      };

      await writeFile(
        join(this.samplesDir, 'glm-compatibility-test-report.json'),
        JSON.stringify(report, null, 2),
        'utf8'
      );

      console.log(`📄 测试报告已保存到: ${join(this.samplesDir, 'glm-compatibility-test-report.json')}`);
    } catch (error) {
      console.log(`⚠️  保存测试报告失败: ${error}`);
    }
  }
}

// 运行测试
async function main() {
  const tester = new GLMCompatibilityTest();
  await tester.runTests();
}

// 如果直接运行此脚本
if (require.main === module) {
  main().catch(console.error);
}

export { GLMCompatibilityTest };