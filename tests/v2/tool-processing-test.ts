/**
 * V2工具处理链路测试
 * 测试tool-harvester → tool-canonicalizer → tool-governor的完整流程
 */

import * as fs from 'fs/promises';
import * as path from 'path';

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

  private harvestTools(content: string): any[] {
    const tools: any[] = [];
    
    // 检测unified diff
    const beginIdx = content.indexOf('*** Begin Patch');
    const endIdx = content.indexOf('*** End Patch');
    if (beginIdx >= 0 && endIdx > beginIdx) {
      const patchText = content.slice(beginIdx, endIdx + '*** End Patch'.length);
      tools.push({
        type: 'function',
        function: {
          name: 'apply_patch',
          arguments: JSON.stringify({ patch: patchText })
        },
        id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      });
    }
    
    // 检测<function=execute>
    const execRe = /<function=execute>[\s\S]*?<parameter=command>([\s\S]*?)<\/parameter>[\s\S]*?<\/function=execute>/i;
    const execMatch = execRe.exec(content);
    if (execMatch && execMatch[1]) {
      const cmdRaw = execMatch[1].trim();
      tools.push({
        type: 'function',
        function: {
          name: 'shell',
          arguments: JSON.stringify({ command: [cmdRaw] })
        },
        id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      });
    }
    
    return tools;
  }

  private canonicalizeTools(tools: any[]): any[] {
    return tools.map((tool, index) => ({
      index,
      id: tool.id || `call_${Date.now()}_${index}`,
      type: 'function',
      function: {
        name: tool.function?.name || tool.name || 'unknown',
        arguments: typeof tool.function?.arguments === 'string' 
          ? tool.function.arguments 
          : JSON.stringify(tool.function?.arguments || {})
      }
    }));
  }

  private governTools(tools: any[]): any[] {
    return tools.map(tool => ({
      ...tool,
      function: {
        ...tool.function,
        arguments: tool.function.arguments || '{}'
      }
    }));
  }

  private async processSample(sample: TestSample): Promise<ToolProcessingResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    
    try {
      const responseMessage = sample.response.body?.data?.choices?.[0]?.message;
      const content = responseMessage?.content || '';
      
      const harvestedTools = this.harvestTools(content);
      const canonicalizedTools = this.canonicalizeTools(harvestedTools);
      const governedTools = this.governTools(canonicalizedTools);
      
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
