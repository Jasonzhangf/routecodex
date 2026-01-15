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
      const entries = await fs.readdir(openaiChatDir, { withFileTypes: true });
      const flatFiles = entries.filter((e) => e.isFile()).map((e) => e.name);

      // New layout: openai-chat/<requestId>/*.json
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const requestId = entry.name;
        if (!this.isLikelyRequestId(requestId)) {
          continue;
        }
        const dirPath = path.join(openaiChatDir, requestId);
        const files = (await fs.readdir(dirPath)).filter((f) => f.endsWith('.json'));
        const testCase = await this.buildTestCaseFromFiles(requestId, 'openai-chat', files, dirPath);
        if (testCase) {
          testCases.push(testCase);
        }
      }

      // Legacy layout: openai-chat/*.json
      const compatFiles = flatFiles.filter(f => f.includes('compat'));
      const providerFiles = flatFiles.filter(f => f.includes('provider'));
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
      const subdirs = await fs.readdir(anthropicDir, { withFileTypes: true });
      
      const dirs = subdirs.filter((e) => e.isDirectory()).map((e) => e.name);
      for (const subdir of dirs.slice(0, 10)) { // 限制数量
        const subdirPath = path.join(anthropicDir, subdir);
        const files = await fs.readdir(subdirPath);
        const relevantFiles = files.filter(f =>
          f.endsWith('.json') && (f.includes('request') || f.includes('response') || f.includes('provider'))
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
      const entries = await fs.readdir(responsesDir, { withFileTypes: true });
      const flatFiles = entries.filter((e) => e.isFile()).map((e) => e.name);

      // New layout: openai-responses/<requestId>/*.json
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const requestId = entry.name;
        if (!this.isLikelyRequestId(requestId)) {
          continue;
        }
        const dirPath = path.join(responsesDir, requestId);
        const files = (await fs.readdir(dirPath)).filter((f) => f.endsWith('.json'));
        const testCase = await this.buildTestCaseFromFiles(requestId, 'openai-responses', files, dirPath);
        if (testCase) {
          testCases.push(testCase);
        }
      }

      // Legacy layout: openai-responses/*.json
      const relevantFiles = flatFiles.filter(f =>
        f.includes('request') || f.includes('response') || f.includes('provider')
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

  private isLikelyRequestId(value: string): boolean {
    return (
      value.startsWith('req_') ||
      value.startsWith('req-') ||
      value.startsWith('openai-chat') ||
      value.startsWith('openai-responses') ||
      value.startsWith('anthropic')
    );
  }

  /**
   * 按请求ID分组文件
   */
  private groupFilesByRequestId(files: string[]): Record<string, string[]> {
    const groups: Record<string, string[]> = {};
    
    for (const file of files) {
      const requestId = this.extractRequestIdFromName(file);
      if (!requestId) {
        continue;
      }
      if (!groups[requestId]) {
        groups[requestId] = [];
      }
      groups[requestId].push(file);
    }
    
    return groups;
  }

  private extractRequestIdFromName(fileName: string): string | null {
    const match = fileName.match(/^(req_\d+(?:_[a-zA-Z0-9]+)?)_/) || fileName.match(/^(req-\d+-[a-zA-Z0-9]+)_/);
    if (match && match[1]) {
      return match[1];
    }
    const idx = fileName.indexOf('_');
    if (idx > 0) {
      return fileName.slice(0, idx);
    }
    return null;
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
        const stage =
          (data as any)?.meta && typeof (data as any).meta === 'object' && typeof (data as any).meta.stage === 'string'
            ? (data as any).meta.stage
            : file;
        
        // 提取时间戳
        if (!timestamp) {
          const timestampMatch = file.match(/(\d{10,13})/) || requestId.match(/(\d{10,13})/);
          if (timestampMatch) {
            timestamp = timestampMatch[1];
          }
        }
        
        // 分类数据
        if (String(stage).includes('compat-pre') || file.includes('compat-pre')) {
          v1Data.compatPre = data.data || data;
        } else if (String(stage).includes('compat-post') || file.includes('compat-post')) {
          v1Data.compatPost = data.data || data;
        } else if (String(stage).includes('provider-request') || file.includes('provider-request')) {
          v2Data.providerRequest = {
            url: data.url,
            headers: data.headers,
            body: data.body
          };
          if (!inputRequest) {
            inputRequest = data.body;
          }
        } else if (String(stage).includes('provider-response') || file.includes('provider-response')) {
          v2Data.providerResponse = data.data || data;
        } else if (String(stage).includes('request') || file.includes('request')) {
          if (!inputRequest) {
            inputRequest = data.data || data;
          }
        } else if (String(stage).includes('response') || file.includes('response')) {
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
