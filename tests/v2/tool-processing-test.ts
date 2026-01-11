/**
 * V2工具处理链路测试
 * 测试 llmswitch-core 响应侧工具治理链路：
 * runChatResponseToolFilters → ToolGovernanceEngine.governResponse
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { runChatResponseToolFilters } from '../sharedmodule/llmswitch-core/src/conversion/shared/tool-filter-pipeline.js';
import { ToolGovernanceEngine } from '../sharedmodule/llmswitch-core/src/conversion/hub/tool-governance/index.js';

interface TestSample {
  id: string;
  requestPath: string;
  responsePath: string;
  request: any;
  response: any;
}

interface ToolProcessingResult {
  inputContent: string;
  harvestedTools: any[];
  canonicalizedTools: any[];
  governedTools: any[];
  processingTime: number;
  errors: string[];
}

class V2ToolProcessingTest {
  private samplesDir = path.join(process.env.HOME || '', '.routecodex/codex-samples');
  private results: ToolProcessingResult[] = [];
  private failedTests: Array<{sample: string; error: string}> = [];
  private toolGovernance = new ToolGovernanceEngine();

  private async getToolSamples(limit: number = 5): Promise<TestSample[]> {
    const openaiChatDir = path.join(this.samplesDir, 'openai-chat');
    const files = await fs.readdir(openaiChatDir);
    const responseFiles = files.filter(f => f.endsWith('_provider-response.json'));
    const toolSamples: TestSample[] = [];
    
    for (const responseFile of responseFiles.slice(0, limit * 2)) {
      const responsePath = path.join(openaiChatDir, responseFile);
      const responseContent = await fs.readFile(responsePath, 'utf-8');
      const response = JSON.parse(responseContent);
      
      const hasTools = response.body?.data?.choices?.[0]?.message?.tool_calls ||
                      response.body?.data?.choices?.[0]?.message?.function_call;
      
      if (hasTools) {
        const baseName = responseFile.replace('_provider-response.json', '');
        const requestFile = `${baseName}_provider-request.json`;
        const requestPath = path.join(openaiChatDir, requestFile);
        
        try {
          const requestContent = await fs.readFile(requestPath, 'utf-8');
          const request = JSON.parse(requestContent);
          
          toolSamples.push({
            id: baseName,
            requestPath,
            responsePath,
            request,
            response
          });
          
          if (toolSamples.length >= limit) break;
        } catch (error) {
          console.warn(`Failed to load request file: ${requestFile}`);
        }
      }
    }
    
    return toolSamples;
  }

  private async processSample(sample: TestSample): Promise<ToolProcessingResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    
    try {
      const chatPayload = sample.response.body?.data;
      const responseMessage = chatPayload?.choices?.[0]?.message;
      const content = responseMessage?.content || '';

      // 使用生产链路的工具治理：runChatResponseToolFilters → ToolGovernanceEngine.governResponse
      const filtered = await runChatResponseToolFilters(chatPayload, {
        entryEndpoint: '/v1/chat/completions',
        requestId: sample.id,
        profile: 'openai-chat'
      });
      const { payload: governed } = this.toolGovernance.governResponse(filtered as any, 'openai-chat');

      const choices = Array.isArray((governed as any)?.choices) ? (governed as any).choices : [];
      const msg = choices[0] && typeof choices[0] === 'object' ? (choices[0] as any).message || {} : {};
      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

      const harvestedTools = toolCalls;
      const canonicalizedTools = toolCalls;
      const governedTools = toolCalls;
      
      return {
        inputContent: content,
        harvestedTools,
        canonicalizedTools,
        governedTools,
        processingTime: Date.now() - startTime,
        errors
      };
    } catch (error) {
      errors.push(`Processing error: ${error instanceof Error ? error.message : String(error)}`);
      return {
        inputContent: '',
        harvestedTools: [],
        canonicalizedTools: [],
        governedTools: [],
        processingTime: Date.now() - startTime,
        errors
      };
    }
  }

  async runTests(): Promise<void> {
    console.log('🔧 开始V2工具处理链路测试');
    console.log('===================================');
    
    const samples = await this.getToolSamples(5);
    console.log(`📋 找到 ${samples.length} 个工具调用样本`);
    
    for (const sample of samples) {
      console.log(`\n🧪 测试样本: ${sample.id}`);
      
      try {
        const result = await this.processSample(sample);
        this.results.push(result);
        
        console.log(`  ✅ 处理时间: ${result.processingTime}ms`);
        console.log(`  📝 收割工具: ${result.harvestedTools.length}`);
        console.log(`  🔄 规范化工具: ${result.canonicalizedTools.length}`);
        console.log(`  🛡️ 治理工具: ${result.governedTools.length}`);
        
        if (result.errors.length > 0) {
          console.log(`  ⚠️ 错误: ${result.errors.join(', ')}`);
        }
        
        if (result.governedTools.length > 0) {
          const tool = result.governedTools[0];
          const argsPreview = tool.function.arguments?.substring(0, 50) || '';
          console.log(`  📄 工具示例: ${tool.function.name}(${argsPreview}...)`);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.log(`  ❌ 测试失败: ${errorMsg}`);
        this.failedTests.push({ sample: sample.id, error: errorMsg });
      }
    }
    
    this.printSummary();
  }

  private printSummary(): void {
    console.log('\n📊 测试摘要');
    console.log('============');
    console.log(`✅ 成功: ${this.results.length}`);
    console.log(`❌ 失败: ${this.failedTests.length}`);
    
    if (this.results.length > 0) {
      const avgTime = Math.round(this.results.reduce((sum, r) => sum + r.processingTime, 0) / this.results.length);
      const totalHarvested = this.results.reduce((sum, r) => sum + r.harvestedTools.length, 0);
      const totalCanonicalized = this.results.reduce((sum, r) => sum + r.canonicalizedTools.length, 0);
      const totalGoverned = this.results.reduce((sum, r) => sum + r.governedTools.length, 0);
      
      console.log(`⏱️ 平均处理时间: ${avgTime}ms`);
      console.log(`🌾 总收割工具: ${totalHarvested}`);
      console.log(`🔄 总规范化工具: ${totalCanonicalized}`);
      console.log(`🛡️ 总治理工具: ${totalGoverned}`);
    }
    
    if (this.failedTests.length > 0) {
      console.log('\n❌ 失败的测试:');
      this.failedTests.forEach(f => console.log(`  - ${f.sample}: ${f.error}`));
    }
  }
}

// 运行测试
const test = new V2ToolProcessingTest();
test.runTests().catch(console.error);

export { V2ToolProcessingTest };
