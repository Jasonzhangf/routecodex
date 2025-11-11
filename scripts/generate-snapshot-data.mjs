#!/usr/bin/env node

/**
 * 生成V1/V2快照数据脚本
 * 用于创建一致性测试的输入数据
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

// 配置
const SAMPLES_DIR = path.join(process.env.HOME || '', '.routecodex/codex-samples');
const OUTPUT_DIR = path.join(projectRoot, 'test-results', 'snapshots');
const MAX_SAMPLES = 10; // 每个协议的最大样本数

class SnapshotDataGenerator {
  constructor() {
    this.samplesGenerated = 0;
  }

  /**
   * 生成所有协议的快照数据
   */
  async generateAllSnapshots() {
    console.log('🚀 开始生成V1/V2快照数据');
    console.log('================================');
    
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    
    // 生成OpenAI Chat快照
    await this.generateOpenAIChatSnapshots();
    
    // 生成Anthropic Messages快照
    await this.generateAnthropicMessagesSnapshots();
    
    // 生成Responses快照
    await this.generateResponsesSnapshots();
    
    console.log(`\n✅ 快照生成完成! 总计: ${this.samplesGenerated} 个样本`);
    console.log(`📁 输出目录: ${OUTPUT_DIR}`);
  }

  /**
   * 生成OpenAI Chat快照
   */
  async generateOpenAIChatSnapshots() {
    console.log('\n📋 生成OpenAI Chat快照...');
    
    const openaiDir = path.join(SAMPLES_DIR, 'openai-chat');
    const outputDir = path.join(OUTPUT_DIR, 'openai-chat');
    
    try {
      await fs.mkdir(outputDir, { recursive: true });
      const files = await fs.readdir(openaiDir);
      
      // 按请求ID分组
      const groups = this.groupFilesByRequestId(files);
      let count = 0;
      
      for (const [requestId, groupFiles] of Object.entries(groups)) {
        if (count >= MAX_SAMPLES) break;
        
        const snapshot = await this.buildSnapshotFromFiles(
          requestId, 
          'openai-chat', 
          groupFiles, 
          openaiDir
        );
        
        if (snapshot) {
          const outputPath = path.join(outputDir, `${requestId}.json`);
          await fs.writeFile(outputPath, JSON.stringify(snapshot, null, 2));
          console.log(`  ✅ 生成快照: ${requestId}`);
          count++;
          this.samplesGenerated++;
        }
      }
      
      console.log(`  📊 OpenAI Chat: ${count} 个快照`);
    } catch (error) {
      console.warn('  ⚠️ 生成OpenAI Chat快照失败:', error.message);
    }
  }

  /**
   * 生成Anthropic Messages快照
   */
  async generateAnthropicMessagesSnapshots() {
    console.log('\n📋 生成Anthropic Messages快照...');
    
    const anthropicDir = path.join(SAMPLES_DIR, 'anthropic-messages');
    const outputDir = path.join(OUTPUT_DIR, 'anthropic-messages');
    
    try {
      await fs.mkdir(outputDir, { recursive: true });
      const subdirs = await fs.readdir(anthropicDir);
      
      let count = 0;
      for (const subdir of subdirs) {
        if (count >= MAX_SAMPLES) break;
        
        const subdirPath = path.join(anthropicDir, subdir);
        const stat = await fs.stat(subdirPath);
        
        if (stat.isDirectory()) {
          const files = await fs.readdir(subdirPath);
          const relevantFiles = files.filter(f => 
            f.includes('request') || f.includes('response')
          );
          
          const snapshot = await this.buildSnapshotFromFiles(
            subdir, 
            'anthropic-messages', 
            relevantFiles, 
            subdirPath
          );
          
          if (snapshot) {
            const outputPath = path.join(outputDir, `${subdir}.json`);
            await fs.writeFile(outputPath, JSON.stringify(snapshot, null, 2));
            console.log(`  ✅ 生成快照: ${subdir}`);
            count++;
            this.samplesGenerated++;
          }
        }
      }
      
      console.log(`  📊 Anthropic Messages: ${count} 个快照`);
    } catch (error) {
      console.warn('  ⚠️ 生成Anthropic Messages快照失败:', error.message);
    }
  }

  /**
   * 生成Responses快照
   */
  async generateResponsesSnapshots() {
    console.log('\n📋 生成Responses快照...');
    
    const responsesDir = path.join(SAMPLES_DIR, 'openai-responses');
    const outputDir = path.join(OUTPUT_DIR, 'openai-responses');
    
    try {
      await fs.mkdir(outputDir, { recursive: true });
      const files = await fs.readdir(responsesDir);
      
      const groups = this.groupFilesByRequestId(files);
      let count = 0;
      
      for (const [requestId, groupFiles] of Object.entries(groups)) {
        if (count >= MAX_SAMPLES) break;
        
        const snapshot = await this.buildSnapshotFromFiles(
          requestId, 
          'openai-responses', 
          groupFiles, 
          responsesDir
        );
        
        if (snapshot) {
          const outputPath = path.join(outputDir, `${requestId}.json`);
          await fs.writeFile(outputPath, JSON.stringify(snapshot, null, 2));
          console.log(`  ✅ 生成快照: ${requestId}`);
          count++;
          this.samplesGenerated++;
        }
      }
      
      console.log(`  📊 Responses: ${count} 个快照`);
    } catch (error) {
      console.warn('  ⚠️ 生成Responses快照失败:', error.message);
    }
  }

  /**
   * 按请求ID分组文件
   */
  groupFilesByRequestId(files) {
    const groups = {};
    
    for (const file of files) {
      const match = file.match(/^(req[^_]+)_/); // 匹配请求ID
      if (match) {
        const requestId = match[1];
        if (!groups[requestId]) {
          groups[requestId] = [];
        }
        groups[requestId].push(file);
      }
    }
    
    return groups;
  }

  /**
   * 从文件构建快照数据
   */
  async buildSnapshotFromFiles(requestId, protocol, files, dirPath) {
    try {
      const v1Data = {};
      const v2Data = {};
      let inputRequest = null;
      let timestamp = '';
      
      // 加载并分类文件
      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const data = JSON.parse(content);
        
        // 提取时间戳
        if (!timestamp) {
          const timestampMatch = file.match(/(\d{10,13})/);
          if (timestampMatch) {
            timestamp = timestampMatch[1];
          }
        }
        
        // 分类数据
        if (file.includes('compat-pre')) {
          v1Data.compatPre = data.data || data;
        } else if (file.includes('compat-post')) {
          v1Data.compatPost = data.data || data;
        } else if (file.includes('provider-request')) {
          v2Data.providerRequest = {
            url: data.url,
            headers: data.headers,
            body: data.body
          };
          if (!inputRequest) {
            inputRequest = data.body;
          }
        } else if (file.includes('provider-response')) {
          v2Data.providerResponse = data.data || data;
        } else if (file.includes('request')) {
          if (!inputRequest) {
            inputRequest = data.data || data;
          }
        } else if (file.includes('response')) {
          v1Data.finalResponse = data.data || data;
        }
      }
      
      return {
        id: requestId,
        timestamp,
        protocol,
        inputRequest,
        v1Data,
        v2Data,
        metadata: {
          generatedAt: new Date().toISOString(),
          generator: 'generate-snapshot-data.mjs',
          version: '1.0.0'
        }
      };
    } catch (error) {
      console.warn(`    ⚠️ 构建快照失败 ${requestId}:`, error.message);
      return null;
    }
  }
}

// 主函数
async function main() {
  const generator = new SnapshotDataGenerator();
  await generator.generateAllSnapshots();
}

// 运行
if (import.meta.url === `file://\${process.argv[1]}`) {
  main().catch(console.error);
}

export { SnapshotDataGenerator };
