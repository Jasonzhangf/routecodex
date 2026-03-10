/**
 * Codex样本分析工具
 *
 * 分析现有的codex-samples，了解请求模式和转换结果
 */

import * as fs from 'fs/promises';
import * as path from 'path';

interface SampleAnalysis {
  sampleId: string;
  requestType: 'chat' | 'responses' | 'messages';
  requestFeatures: {
    hasTools: boolean;
    hasSystemMessage: boolean;
    messageCount: number;
    toolCount: number;
    model: string;
    stream: boolean;
    hasTemperature: boolean;
    hasMaxTokens: boolean;
  };
  availableFiles: string[];
  hasProviderData: boolean;
  hasTransformationData: boolean;
}

/**
 * Codex样本分析器
 */
export class CodexSamplesAnalyzer {
  private samplesDir: string;

  constructor(samplesDir: string = '~/.routecodex/codex-samples') {
    this.samplesDir = samplesDir.replace('~', process.env.HOME || '');
  }

  /**
   * 分析所有样本
   */
  async analyzeAllSamples(): Promise<SampleAnalysis[]> {
    console.log('🔍 开始分析Codex样本...');

    const analyses: SampleAnalysis[] = [];

    // 分析openai-chat样本
    const chatAnalyses = await this.analyzeOpenAIChatSamples();
    analyses.push(...chatAnalyses);

    // 分析openai-responses样本
    const responsesAnalyses = await this.analyzeOpenAIResponsesSamples();
    analyses.push(...responsesAnalyses);

    // 分析anthropic-messages样本
    const messagesAnalyses = await this.analyzeAnthropicMessagesSamples();
    analyses.push(...messagesAnalyses);

    // 生成分析报告
    this.generateAnalysisReport(analyses);

    return analyses;
  }

  /**
   * 分析OpenAI Chat样本
   */
  private async analyzeOpenAIChatSamples(): Promise<SampleAnalysis[]> {
    const analyses: SampleAnalysis[] = [];
    const chatDir = path.join(this.samplesDir, 'openai-chat');

    try {
      const files = await fs.readdir(chatDir);
      const sampleGroups = this.groupFilesBySampleId(files);

      for (const [sampleId, sampleFiles] of Object.entries(sampleGroups).slice(0, 10)) {
        const analysis = await this.analyzeSample(sampleId, sampleFiles, 'chat', chatDir);
        if (analysis) {
          analyses.push(analysis);
        }
      }
    } catch (error) {
      console.warn('⚠️  无法分析OpenAI Chat样本:', error);
    }

    return analyses;
  }

  /**
   * 分析OpenAI Responses样本
   */
  private async analyzeOpenAIResponsesSamples(): Promise<SampleAnalysis[]> {
    const analyses: SampleAnalysis[] = [];
    const responsesDir = path.join(this.samplesDir, 'openai-responses');

    try {
      const files = await fs.readdir(responsesDir);
      const sampleGroups = this.groupFilesBySampleId(files);

      for (const [sampleId, sampleFiles] of Object.entries(sampleGroups).slice(0, 5)) {
        const analysis = await this.analyzeSample(sampleId, sampleFiles, 'responses', responsesDir);
        if (analysis) {
          analyses.push(analysis);
        }
      }
    } catch (error) {
      console.warn('⚠️  无法分析OpenAI Responses样本:', error);
    }

    return analyses;
  }

  /**
   * 分析Anthropic Messages样本
   */
  private async analyzeAnthropicMessagesSamples(): Promise<SampleAnalysis[]> {
    const analyses: SampleAnalysis[] = [];
    const messagesDir = path.join(this.samplesDir, 'anthropic-messages');

    try {
      const files = await fs.readdir(messagesDir);
      const sampleGroups = this.groupFilesBySampleId(files);

      for (const [sampleId, sampleFiles] of Object.entries(sampleGroups).slice(0, 5)) {
        const analysis = await this.analyzeSample(sampleId, sampleFiles, 'messages', messagesDir);
        if (analysis) {
          analyses.push(analysis);
        }
      }
    } catch (error) {
      console.warn('⚠️  无法分析Anthropic Messages样本:', error);
    }

    return analyses;
  }

  /**
   * 按样本ID分组文件
   */
  private groupFilesBySampleId(files: string[]): Record<string, string[]> {
    const groups: Record<string, string[]> = {};

    for (const file of files) {
      const match = file.match(/^(req_[^_]+)/);
      if (match) {
        const sampleId = match[1];
        if (!groups[sampleId]) {
          groups[sampleId] = [];
        }
        groups[sampleId].push(file);
      }
    }

    return groups;
  }

  /**
   * 分析单个样本
   */
  private async analyzeSample(
    sampleId: string,
    files: string[],
    requestType: 'chat' | 'responses' | 'messages',
    baseDir: string
  ): Promise<SampleAnalysis | null> {
    try {
      const rawRequestFile = files.find(f => f.endsWith('_raw-request.json'));
      if (!rawRequestFile) {
        return null;
      }

      const rawRequestPath = path.join(baseDir, rawRequestFile);
      const rawRequest = JSON.parse(await fs.readFile(rawRequestPath, 'utf-8'));

      const analysis: SampleAnalysis = {
        sampleId,
        requestType,
        requestFeatures: this.analyzeRequestFeatures(rawRequest, requestType),
        availableFiles: files,
        hasProviderData: files.some(f => f.includes('provider')),
        hasTransformationData: files.some(f => f.includes('pre-') || f.includes('post-'))
      };

      return analysis;
    } catch (error) {
      console.warn(`⚠️  无法分析样本 ${sampleId}:`, error);
      return null;
    }
  }

  /**
   * 分析请求特征
   */
  private analyzeRequestFeatures(request: any, requestType: string): SampleAnalysis['requestFeatures'] {
    const features = {
      hasTools: false,
      hasSystemMessage: false,
      messageCount: 0,
      toolCount: 0,
      model: '',
      stream: false,
      hasTemperature: false,
      hasMaxTokens: false
    };

    // 检查工具调用
    if (request.tools || request.tool_calls) {
      features.hasTools = true;
      features.toolCount = (request.tools || request.tool_calls || []).length;
    }

    // 检查消息
    if (requestType === 'chat' || requestType === 'messages') {
      if (request.messages && Array.isArray(request.messages)) {
        features.messageCount = request.messages.length;
        features.hasSystemMessage = request.messages.some((m: any) => m && m.role === 'system');
      }
    } else if (requestType === 'responses') {
      features.messageCount = 1; // Responses通常有input
    }

    // 检查模型
    if (request.model) {
      features.model = request.model;
    }

    // 检查流式
    if (request.stream === true) {
      features.stream = true;
    }

    // 检查参数
    if (request.temperature !== undefined) {
      features.hasTemperature = true;
    }
    if (request.max_tokens !== undefined) {
      features.hasMaxTokens = true;
    }

    return features;
  }

  /**
   * 生成分析报告
   */
  private generateAnalysisReport(analyses: SampleAnalysis[]): void {
    console.log('\n' + '='.repeat(60));
    console.log('📊 Codex样本分析报告');
    console.log('='.repeat(60));
    console.log(`总样本数: ${analyses.length}`);

    // 按类型统计
    const typeStats = analyses.reduce((stats, analysis) => {
      stats[analysis.requestType] = (stats[analysis.requestType] || 0) + 1;
      return stats;
    }, {} as Record<string, number>);

    console.log('\n📋 按请求类型分布:');
    Object.entries(typeStats).forEach(([type, count]) => {
      console.log(`  ${type}: ${count} 个样本`);
    });

    // 特征统计
    const featuresSummary = analyses.reduce((summary, analysis) => {
      summary.totalSamples++;
      summary.samplesWithTools += analysis.requestFeatures.hasTools ? 1 : 0;
      summary.samplesWithSystem += analysis.requestFeatures.hasSystemMessage ? 1 : 0;
      summary.streamingSamples += analysis.requestFeatures.stream ? 1 : 0;
      summary.totalMessages += analysis.requestFeatures.messageCount;
      summary.totalTools += analysis.requestFeatures.toolCount;
      return summary;
    }, {
      totalSamples: 0,
      samplesWithTools: 0,
      samplesWithSystem: 0,
      streamingSamples: 0,
      totalMessages: 0,
      totalTools: 0
    });

    console.log('\n📈 样本特征统计:');
    console.log(`  包含工具调用: ${featuresSummary.samplesWithTools}/${featuresSummary.totalSamples} (${((featuresSummary.samplesWithTools/featuresSummary.totalSamples)*100).toFixed(1)}%)`);
    console.log(`  包含系统消息: ${featuresSummary.samplesWithSystem}/${featuresSummary.totalSamples} (${((featuresSummary.samplesWithSystem/featuresSummary.totalSamples)*100).toFixed(1)}%)`);
    console.log(`  流式请求: ${featuresSummary.streamingSamples}/${featuresSummary.totalSamples} (${((featuresSummary.streamingSamples/featuresSummary.totalSamples)*100).toFixed(1)}%)`);
    console.log(`  总消息数: ${featuresSummary.totalMessages}`);
    console.log(`  总工具数: ${featuresSummary.totalTools}`);

    // 模型分布
    const modelStats = analyses.reduce((stats, analysis) => {
      const model = analysis.requestFeatures.model || 'unknown';
      stats[model] = (stats[model] || 0) + 1;
      return stats;
    }, {} as Record<string, number>);

    console.log('\n🤖 模型使用分布:');
    Object.entries(modelStats)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 10)
      .forEach(([model, count]) => {
        console.log(`  ${model}: ${count} 次`);
      });

    // 数据完整性检查
    const samplesWithProviderData = analyses.filter(a => a.hasProviderData).length;
    const samplesWithTransformationData = analyses.filter(a => a.hasTransformationData).length;

    console.log('\n📁 数据完整性:');
    console.log(`  包含Provider数据: ${samplesWithProviderData}/${analyses.length} (${((samplesWithProviderData/analyses.length)*100).toFixed(1)}%)`);
    console.log(`  包含转换数据: ${samplesWithTransformationData}/${analyses.length} (${((samplesWithTransformationData/analyses.length)*100).toFixed(1)}%)`);

    // 样本详情（前5个）
    console.log('\n📋 样本详情 (前5个):');
    analyses.slice(0, 5).forEach(analysis => {
      console.log(`\n🔍 ${analysis.sampleId} (${analysis.requestType}):`);
      console.log(`  工具: ${analysis.requestFeatures.hasTools ? '✓' : '✗'} (${analysis.requestFeatures.toolCount}个)`);
      console.log(`  消息: ${analysis.requestFeatures.messageCount}条 ${analysis.requestFeatures.hasSystemMessage ? '(含系统)' : ''}`);
      console.log(`  模型: ${analysis.requestFeatures.model}`);
      console.log(`  流式: ${analysis.requestFeatures.stream ? '✓' : '✗'}`);
      console.log(`  文件: ${analysis.availableFiles.length}个`);
    });

    // 转换验证建议
    console.log('\n💡 转换验证建议:');
    if (featuresSummary.samplesWithTools > 0) {
      console.log('✅ 有工具调用样本，可以验证工具规范化功能');
    }
    if (featuresSummary.samplesWithSystem > 0) {
      console.log('✅ 有系统消息样本，可以验证消息转换功能');
    }
    if (samplesWithTransformationData > 0) {
      console.log('✅ 有转换数据样本，可以进行前后对比验证');
    }
    if (typeStats.responses > 0) {
      console.log('✅ 有Responses样本，可以验证协议转换功能');
    }
  }
}

/**
 * 运行分析的主函数
 */
export async function runCodexSamplesAnalysis(): Promise<SampleAnalysis[]> {
  const analyzer = new CodexSamplesAnalyzer();
  return await analyzer.analyzeAllSamples();
}
