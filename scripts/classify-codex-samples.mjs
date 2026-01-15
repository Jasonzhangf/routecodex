#!/usr/bin/env node
// classify-codex-samples.mjs
// 按照 Virtual Router classifier 分类 codex 样本
// 支持 providerKey、工具类型、tool_calls 结构识别

import { readdir, readFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES_ROOT = join(__dirname, '..', 'samples', 'mock-provider');

// Virtual Router classifier 规则
const PROVIDER_KEYS = {
  'glm.default': 'glm',
  'glm.key1': 'glm',
  'gemini.default': 'gemini',
  'openai.default': 'openai',
  'anthropic.default': 'anthropic',
  'kimi.key1': 'kimi',
  'qwen.key1': 'qwen',
  'iflow.key1': 'iflow',
  'tab.key1': 'tab',
  'crs.key1': 'crs',
  'fai.key1': 'fai',
  'modelscope.default': 'modelscope',
  'unknown': 'unknown'
};

const TOOL_TYPES = {
  'apply_patch': 'apply_patch',
  'shell': 'shell_command',
  'submit_tool_outputs': 'tool_loop',
  'list_files': 'file_operation',
  'write_file': 'file_operation',
  'read_file': 'file_operation'
};

// 样本分类结果
class SampleClassifier {
  constructor() {
    this.samples = [];
    this.stats = {
      total: 0,
      byProvider: {},
      byToolType: {},
      withToolCalls: 0,
      errors: 0
    };
  }

  // 从路径提取 provider key
  extractProviderKey(filePath) {
    const parts = filePath.split('/');
    const providerPart = parts.find(part => Object.keys(PROVIDER_KEYS).some(key => part.includes(key)));
    
    if (!providerPart) return 'unknown';
    
    for (const [key, value] of Object.entries(PROVIDER_KEYS)) {
      if (providerPart.includes(key)) return value;
    }
    return 'unknown';
  }

  // 识别工具类型
  identifyToolType(toolCall) {
    const funcName = toolCall.function?.name || '';
    
    // 检查已知工具名称
    for (const [pattern, type] of Object.entries(TOOL_TYPES)) {
      if (funcName.toLowerCase().includes(pattern)) return type;
    }
    
    // 默认分类
    if (funcName.includes('patch')) return 'apply_patch';
    if (funcName.includes('shell')) return 'shell_command';
    if (funcName.includes('file')) return 'file_operation';
    
    return 'unknown_tool';
  }

  // 分析单个样本
  async analyzeSample(filePath) {
    try {
      const content = await readFile(filePath, 'utf-8');
      const data = JSON.parse(content);
      
      const providerKey = this.extractProviderKey(filePath);
      const sampleId = basename(dirname(filePath)) + '/' + basename(filePath, '.json');
      
      let toolCalls = [];
      
      // 提取 tool_calls
      if (data.tool_calls) {
        toolCalls = data.tool_calls;
      } else if (data.choices?.[0]?.message?.tool_calls) {
        toolCalls = data.choices[0].message.tool_calls;
      } else if (data.messages) {
        // 查找最后一条用户消息中的工具调用
        const lastMessage = data.messages[data.messages.length - 1];
        if (lastMessage.tool_calls) {
          toolCalls = lastMessage.tool_calls;
        }
      }
      
      // 分析工具调用
      const toolTypes = [];
      for (const toolCall of toolCalls) {
        const toolType = this.identifyToolType(toolCall);
        toolTypes.push(toolType);
        
        // 更新统计
        this.stats.byToolType[toolType] = (this.stats.byToolType[toolType] || 0) + 1;
      }
      
      const sample = {
        id: sampleId,
        provider: providerKey,
        filePath,
        hasToolCalls: toolCalls.length > 0,
        toolTypes,
        toolCallCount: toolCalls.length
      };
      
      this.samples.push(sample);
      
      // 更新统计
      this.stats.total++;
      this.stats.byProvider[providerKey] = (this.stats.byProvider[providerKey] || 0) + 1;
      if (toolCalls.length > 0) this.stats.withToolCalls++;
      
    } catch (error) {
      console.error(`Error analyzing ${filePath}:`, error.message);
      this.stats.errors++;
    }
  }

  // 递归查找 JSON 文件
  async findJsonFiles(dir) {
    const files = [];
    const entries = await readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...await this.findJsonFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        files.push(fullPath);
      }
    }
    
    return files;
  }

  // 运行分类
  async run() {
    console.log('🔍 开始分析 samples/mock-provider 目录...');
    
    const jsonFiles = await this.findJsonFiles(SAMPLES_ROOT);
    console.log(`📁 找到 ${jsonFiles.length} 个 JSON 文件`);
    
    for (const file of jsonFiles) {
      await this.analyzeSample(file);
    }
    
    this.printResults();
  }

  // 打印结果
  printResults() {
    console.log('\n📊 分类结果统计:');
    console.log('==================');
    
    console.log(`总样本数: ${this.stats.total}`);
    console.log(`包含工具调用: ${this.stats.withToolCalls}`);
    console.log(`错误数: ${this.stats.errors}`);
    
    console.log('\n按 Provider 分布:');
    for (const [provider, count] of Object.entries(this.stats.byProvider)) {
      console.log(`  ${provider}: ${count}`);
    }
    
    console.log('\n按工具类型分布:');
    for (const [toolType, count] of Object.entries(this.stats.byToolType)) {
      console.log(`  ${toolType}: ${count}`);
    }
    
    // 详细样本列表
    console.log('\n📋 详细样本分类:');
    console.log('==================');
    
    for (const sample of this.samples) {
      if (sample.hasToolCalls) {
        console.log(`${sample.provider.padEnd(12)} | ${sample.toolTypes.join(', ').padEnd(20)} | ${sample.id}`);
      }
    }
    
    // 识别未覆盖场景
    console.log('\n⚠️  未覆盖场景:');
    console.log('==================');
    
    const hasApplyPatch = this.stats.byToolType['apply_patch'] > 0;
    const hasShell = this.stats.byToolType['shell_command'] > 0;
    
    if (!hasApplyPatch) console.log('  - 缺少 apply_patch 样本');
    if (!hasShell) console.log('  - 缺少 shell command 样本');
  }
}

// 主函数
async function main() {
  const classifier = new SampleClassifier();
  await classifier.run();
}

main().catch(console.error);
