/**
 * 快照数据加载工具
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { SnapshotData, ConsistencyTestCase } from './consistency-types.js';

export class SnapshotLoader {
  private samplesDir: string;

  constructor(samplesDir: string = path.join(process.env.HOME || '', '.routecodex/codex-samples')) {
    this.samplesDir = samplesDir;
  }

  /**
   * 加载所有可用的快照数据
   */
  async loadAllSnapshots(): Promise<ConsistencyTestCase[]> {
    const testCases: ConsistencyTestCase[] = [];
    
    // 加载OpenAI Chat数据
    const openaiChatCases = await this.loadOpenAIChatCases();
    testCases.push(...openaiChatCases);
    
    // 加载Anthropic Messages数据
    const anthropicCases = await this.loadAnthropicCases();
    testCases.push(...anthropicCases);
    
    // 加载Responses数据
    const responsesCases = await this.loadResponsesCases();
    testCases.push(...responsesCases);
    
    return testCases;
  }

  /**
   * 加载OpenAI Chat测试用例
   */
  private async loadOpenAIChatCases(): Promise<ConsistencyTestCase[]> {
    const openaiChatDir = path.join(this.samplesDir, 'openai-chat');
    const testCases: ConsistencyTestCase[] = [];
    
    try {
      const files = await fs.readdir(openaiChatDir);
      const compatFiles = files.filter(f => f.includes('compat'));
      const providerFiles = files.filter(f => f.includes('provider'));
      
      // 按请求ID分组
      const groups = this.groupFilesByRequestId([...compatFiles, ...providerFiles]);
      
      for (const [requestId, groupFiles] of Object.entries(groups)) {
        const testCase = await this.buildTestCaseFromFiles(requestId, 'openai-chat', groupFiles, openaiChatDir);
        if (testCase) {
          testCases.push(testCase);
        }
      }
    } catch (error) {
      console.warn('Failed to load OpenAI Chat cases:', error);
    }
    
    return testCases;
  }

  /**
   * 加载Anthropic Messages测试用例
   */
  private async loadAnthropicCases(): Promise<ConsistencyTestCase[]> {
    const anthropicDir = path.join(this.samplesDir, 'anthropic-messages');
    const testCases: ConsistencyTestCase[] = [];
    
    try {
      const subdirs = await fs.readdir(anthropicDir);
      
      for (const subdir of subdirs.slice(0, 10)) { // 限制数量
        const subdirPath = path.join(anthropicDir, subdir);
        const stat = await fs.stat(subdirPath);
        
        if (stat.isDirectory()) {
          const files = await fs.readdir(subdirPath);
          const relevantFiles = files.filter(f => 
            f.includes('request') || f.includes('response')
          );
          
          const testCase = await this.buildTestCaseFromFiles(
            subdir, 
            'anthropic-messages', 
            relevantFiles, 
            subdirPath
          );
          
          if (testCase) {
            testCases.push(testCase);
          }
        }
      }
    } catch (error) {
      console.warn('Failed to load Anthropic cases:', error);
    }
    
    return testCases;
  }

  /**
   * 加载Responses测试用例
   */
  private async loadResponsesCases(): Promise<ConsistencyTestCase[]> {
    const responsesDir = path.join(this.samplesDir, 'openai-responses');
    const testCases: ConsistencyTestCase[] = [];
    
    try {
      const files = await fs.readdir(responsesDir);
      const relevantFiles = files.filter(f => 
        f.includes('request') || f.includes('response')
      );
      
      const groups = this.groupFilesByRequestId(relevantFiles);
      
      for (const [requestId, groupFiles] of Object.entries(groups)) {
        const testCase = await this.buildTestCaseFromFiles(
          requestId, 
          'openai-responses', 
          groupFiles, 
          responsesDir
        );
        
        if (testCase) {
          testCases.push(testCase);
        }
      }
    } catch (error) {
      console.warn('Failed to load Responses cases:', error);
    }
    
    return testCases;
  }

  /**
   * 按请求ID分组文件
   */
  private groupFilesByRequestId(files: string[]): Record<string, string[]> {
    const groups: Record<string, string[]> = {};
    
    for (const file of files) {
      // 提取请求ID模式
      const match = file.match(/(req_\d+_[a-zA-Z0-9]+)/) || file.match(/(req-\d+-[a-zA-Z0-9]+)/);
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
   * 从文件构建测试用例
   */
  private async buildTestCaseFromFiles(
    requestId: string,
    protocol: 'openai-chat' | 'anthropic-messages' | 'openai-responses',
    files: string[],
    dirPath: string
  ): Promise<ConsistencyTestCase | null> {
    try {
      const v1Data: any = {};
      const v2Data: any = {};
      let inputRequest: any = null;
      let timestamp = '';
      
      // 加载并分类文件
      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const data: SnapshotData = JSON.parse(content);
        
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
        v2Data
      };
    } catch (error) {
      console.warn(`Failed to build test case from ${requestId}:`, error);
      return null;
    }
  }

  /**
   * 保存测试报告
   */
  async saveReport(report: any, outputPath: string): Promise<void> {
    await fs.writeFile(outputPath, JSON.stringify(report, null, 2));
  }
}
