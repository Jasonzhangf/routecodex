/**
 * V2协议转换测试
 * 测试OpenAI ↔ Anthropic ↔ Responses协议转换
 */

import * as fs from 'fs/promises';
import * as path from 'path';

interface ConversionTestSample {
  id: string;
  sourceProtocol: string;
  targetProtocol: string;
  input: any;
  expectedOutput?: any;
  conversionPath: string;
}

interface ConversionResult {
  inputSample: ConversionTestSample;
  output: any;
  conversionTime: number;
  errors: string[];
  success: boolean;
}

class V2ProtocolConversionTest {
  private samplesDir = path.join(process.env.HOME || '', '.routecodex/codex-samples');
  private results: ConversionResult[] = [];
  private failedTests: Array<{sample: string; error: string}> = [];

  /**
   * 获取不同协议的样本
   */
  private async getProtocolSamples(): Promise<ConversionTestSample[]> {
    const samples: ConversionTestSample[] = [];
    
    // OpenAI Chat样本
    const openaiSamples = await this.getOpenAISamples(3);
    samples.push(...openaiSamples);
    
    // Anthropic Messages样本
    const anthropicSamples = await this.getAnthropicSamples(2);
    samples.push(...anthropicSamples);
    
    // Responses样本
    const responsesSamples = await this.getResponsesSamples(2);
    samples.push(...responsesSamples);
    
    return samples;
  }

  private async getOpenAISamples(limit: number): Promise<ConversionTestSample[]> {
    const openaiChatDir = path.join(this.samplesDir, 'openai-chat');
    const files = await fs.readdir(openaiChatDir);
    const responseFiles = files.filter(f => f.endsWith('_provider-response.json'));
    const samples: ConversionTestSample[] = [];
    
    for (const responseFile of responseFiles.slice(0, limit)) {
      try {
        const responsePath = path.join(openaiChatDir, responseFile);
        const responseContent = await fs.readFile(responsePath, 'utf-8');
        const response = JSON.parse(responseContent);
        
        const baseName = responseFile.replace('_provider-response.json', '');
        
        samples.push({
          id: baseName,
          sourceProtocol: 'openai-chat',
          targetProtocol: 'anthropic-messages',
          input: response.body?.data || {},
          conversionPath: 'openai->anthropic'
        });
        
        samples.push({
          id: baseName,
          sourceProtocol: 'openai-chat',
          targetProtocol: 'openai-responses',
          input: response.body?.data || {},
          conversionPath: 'openai->responses'
        });
      } catch (error) {
        console.warn(`Failed to load OpenAI sample: ${responseFile}`);
      }
    }
    
    return samples;
  }

  private async getAnthropicSamples(limit: number): Promise<ConversionTestSample[]> {
    const anthropicDir = path.join(this.samplesDir, 'anthropic-messages');
    
    try {
      const subdirs = await fs.readdir(anthropicDir);
      const samples: ConversionTestSample[] = [];
      
      for (const subdir of subdirs.slice(0, limit)) {
        const subdirPath = path.join(anthropicDir, subdir);
        const stat = await fs.stat(subdirPath);
        
        if (stat.isDirectory()) {
          try {
            const files = await fs.readdir(subdirPath);
            const responseFile = files.find(f => f.includes('response'));
            
            if (responseFile) {
              const responsePath = path.join(subdirPath, responseFile);
              const responseContent = await fs.readFile(responsePath, 'utf-8');
              const response = JSON.parse(responseContent);
              
              samples.push({
                id: subdir,
                sourceProtocol: 'anthropic-messages',
                targetProtocol: 'openai-chat',
                input: response,
                conversionPath: 'anthropic->openai'
              });
            }
          } catch (error) {
            console.warn(`Failed to load Anthropic sample: ${subdir}`);
          }
        }
      }
      
      return samples;
    } catch (error) {
      console.warn('Anthropic directory not accessible');
      return [];
    }
  }

  private async getResponsesSamples(limit: number): Promise<ConversionTestSample[]> {
    const responsesDir = path.join(this.samplesDir, 'openai-responses');
    
    try {
      const entries = await fs.readdir(responsesDir, { withFileTypes: true });
      const samples: ConversionTestSample[] = [];

      // New layout: openai-responses/<requestId>/*.json
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        if (!entry.name.includes('responses') && !entry.name.startsWith('req_')) {
          continue;
        }
        try {
          const requestDir = path.join(responsesDir, entry.name);
          const files = await fs.readdir(requestDir);
          const responseFile = files.find((f) => f.endsWith('.json') && f.includes('response'));
          if (!responseFile) {
            continue;
          }
          const responsePath = path.join(requestDir, responseFile);
          const responseContent = await fs.readFile(responsePath, 'utf-8');
          const response = JSON.parse(responseContent);
          samples.push({
            id: entry.name,
            sourceProtocol: 'openai-responses',
            targetProtocol: 'openai-chat',
            input: response,
            conversionPath: 'responses->openai'
          });
          if (samples.length >= limit) {
            break;
          }
        } catch (error) {
          console.warn(`Failed to load Responses sample directory: ${entry.name}`);
        }
      }

      // Legacy layout: openai-responses/*.json
      if (samples.length < limit) {
        const files = entries.filter((e) => e.isFile()).map((e) => e.name);
        const responseFiles = files.filter(f => f.includes('response'));
        for (const responseFile of responseFiles.slice(0, limit - samples.length)) {
          try {
            const responsePath = path.join(responsesDir, responseFile);
            const responseContent = await fs.readFile(responsePath, 'utf-8');
            const response = JSON.parse(responseContent);
            const baseName = responseFile.replace(/_response.*$/, '');
            samples.push({
              id: baseName,
              sourceProtocol: 'openai-responses',
              targetProtocol: 'openai-chat',
              input: response,
              conversionPath: 'responses->openai'
            });
          } catch (error) {
            console.warn(`Failed to load Responses sample: ${responseFile}`);
          }
        }
      }

      return samples;
    } catch (error) {
      console.warn('Responses directory not accessible');
      return [];
    }
  }

  /**
   * 模拟协议转换
   */
  private simulateConversion(sample: ConversionTestSample): any {
    const { input, sourceProtocol, targetProtocol } = sample;
    
    // 基于协议类型进行模拟转换
    switch (sample.conversionPath) {
      case 'openai->anthropic':
        return this.convertOpenAIToAnthropic(input);
      case 'openai->responses':
        return this.convertOpenAIToResponses(input);
      case 'anthropic->openai':
        return this.convertAnthropicToOpenAI(input);
      case 'responses->openai':
        return this.convertResponsesToOpenAI(input);
      default:
        throw new Error(`Unsupported conversion path: ${sample.conversionPath}`);
    }
  }

  private convertOpenAIToAnthropic(input: any): any {
    const messages = input.choices?.[0]?.message;
    
    return {
      id: input.id,
      type: 'message',
      role: 'assistant',
      content: messages?.content || [],
      model: input.model,
      stop_reason: this.mapFinishReason(messages?.finish_reason),
      usage: input.usage
    };
  }

  private convertOpenAIToResponses(input: any): any {
    const messages = input.choices?.[0]?.message;
    
    return {
      id: input.id,
      status: 'completed',
      output: messages?.content || '',
      tool_calls: messages?.tool_calls || [],
      usage: input.usage
    };
  }

  private convertAnthropicToOpenAI(input: any): any {
    return {
      id: input.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: input.model,
      choices: [{
        index: 0,
        message: {
          role: input.role,
          content: Array.isArray(input.content) ? input.content.map(c => c.text).join('') : input.content,
          tool_calls: input.content?.filter((c: any) => c.type === 'tool_use').map((tool: any) => ({
            id: tool.id,
            type: 'function',
            function: {
              name: tool.name,
              arguments: JSON.stringify(tool.input)
            }
          })) || []
        },
        finish_reason: this.mapAnthropicFinishReason(input.stop_reason)
      }],
      usage: input.usage
    };
  }

  private convertResponsesToOpenAI(input: any): any {
    return {
      id: input.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: input.model || 'unknown',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: input.output || '',
          tool_calls: input.tool_calls || []
        },
        finish_reason: input.status === 'completed' ? 'stop' : 'length'
      }],
      usage: input.usage
    };
  }

  private mapFinishReason(reason: string): string {
    const mapping: Record<string, string> = {
      'stop': 'end_turn',
      'tool_calls': 'tool_use',
      'length': 'max_tokens',
      'content_filter': 'stop_sequence'
    };
    return mapping[reason] || 'end_turn';
  }

  private mapAnthropicFinishReason(reason: string): string {
    const mapping: Record<string, string> = {
      'end_turn': 'stop',
      'tool_use': 'tool_calls',
      'max_tokens': 'length',
      'stop_sequence': 'stop'
    };
    return mapping[reason] || 'stop';
  }

  /**
   * 运行单个转换测试
   */
  private async runConversionTest(sample: ConversionTestSample): Promise<ConversionResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    
    try {
      const output = this.simulateConversion(sample);
      const conversionTime = Date.now() - startTime;
      
      return {
        inputSample: sample,
        output,
        conversionTime,
        errors,
        success: true
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      errors.push(`Conversion error: ${errorMsg}`);
      
      return {
        inputSample: sample,
        output: null,
        conversionTime: Date.now() - startTime,
        errors,
        success: false
      };
    }
  }

  /**
   * 运行所有转换测试
   */
  async runTests(): Promise<void> {
    console.log('🔄 开始V2协议转换测试');
    console.log('===================================');
    
    const samples = await this.getProtocolSamples();
    console.log(`📋 找到 ${samples.length} 个协议转换样本`);
    
    for (const sample of samples) {
      console.log(`\n🧪 测试转换: ${sample.conversionPath} (${sample.id})`);
      
      try {
        const result = await this.runConversionTest(sample);
        this.results.push(result);
        
        if (result.success) {
          console.log(`  ✅ 转换成功: ${result.conversionTime}ms`);
          
          // 验证输出结构
          if (result.output) {
            const hasContent = result.output.content !== undefined || result.output.choices || result.output.output !== undefined;
            const hasTools = result.output.tool_calls || (result.output.choices?.[0]?.message?.tool_calls);
            
            console.log(`  📄 内容存在: ${hasContent ? '是' : '否'}`);
            console.log(`  🔧 工具调用: ${hasTools ? '是' : '否'}`);
          }
        } else {
          console.log(`  ❌ 转换失败: ${result.errors.join(', ')}`);
          this.failedTests.push({ sample: sample.id, error: result.errors.join(', ') });
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.log(`  ❌ 测试失败: ${errorMsg}`);
        this.failedTests.push({ sample: sample.id, error: errorMsg });
      }
    }
    
    this.printSummary();
  }

  /**
   * 打印测试摘要
   */
  private printSummary(): void {
    console.log('\n📊 协议转换测试摘要');
    console.log('====================');
    console.log(`✅ 成功转换: ${this.results.filter(r => r.success).length}`);
    console.log(`❌ 失败转换: ${this.results.filter(r => !r.success).length}`);
    
    // 按转换路径统计
    const pathStats: Record<string, number> = {};
    this.results.forEach(r => {
      const path = r.inputSample.conversionPath;
      pathStats[path] = (pathStats[path] || 0) + 1;
    });
    
    console.log('\n🔄 转换路径统计:');
    Object.entries(pathStats).forEach(([path, count]) => {
      console.log(`  ${path}: ${count}`);
    });
    
    if (this.results.length > 0) {
      const avgTime = Math.round(
        this.results.reduce((sum, r) => sum + r.conversionTime, 0) / this.results.length
      );
      console.log(`\n⏱️ 平均转换时间: ${avgTime}ms`);
    }
    
    if (this.failedTests.length > 0) {
      console.log('\n❌ 失败的转换:');
      this.failedTests.forEach(f => console.log(`  - ${f.sample}: ${f.error}`));
    }
  }
}

// 运行测试
const test = new V2ProtocolConversionTest();
test.runTests().catch(console.error);

export { V2ProtocolConversionTest };
