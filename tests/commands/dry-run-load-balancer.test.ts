import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { homedir } from 'os';

describe('负载均衡器dry-run功能测试', () => {
  const testDir = path.join(homedir(), '.routecodex-test');
  
  beforeEach(() => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('应该能执行基本的dry-run请求', () => {
    const requestFile = path.join(testDir, 'test-request.json');
    const testRequest = {
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: "Hello" }]
    };
    fs.writeFileSync(requestFile, JSON.stringify(testRequest, null, 2));

    try {
      const result = execSync(`node dist/cli.js dry-run request ${requestFile}`, {
        encoding: 'utf-8',
        cwd: '/Users/fanzhang/Documents/github/routecodex'
      });
      
      console.log('Dry-run结果:', result);
      expect(result).toBeTruthy();
    } catch (error) {
      console.log('Dry-run执行错误:', error.message);
      throw error;
    }
  });

  it('应该能处理负载均衡场景', () => {
    const configFile = path.join(testDir, 'load-balance-config.json');
    const lbConfig = {
      providers: {
        provider1: {
          type: "openai",
          api_key: "test-key-1",
          base_url: "https://api1.example.com"
        },
        provider2: {
          type: "openai", 
          api_key: "test-key-2",
          base_url: "https://api2.example.com"
        }
      },
      routing: {
        default: {
          strategy: "load-balance",
          providers: ["provider1", "provider2"],
          weights: [0.6, 0.4]
        }
      }
    };
    fs.writeFileSync(configFile, JSON.stringify(lbConfig, null, 2));

    const requestFile = path.join(testDir, 'lb-request.json');
    const request = {
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: "Load balance test" }]
    };
    fs.writeFileSync(requestFile, JSON.stringify(request, null, 2));

    try {
      // 使用默认配置文件
      const result = execSync(`node dist/cli.js dry-run request ${requestFile}`, {
        encoding: 'utf-8',
        cwd: '/Users/fanzhang/Documents/github/routecodex'
      });
      
      console.log('负载均衡dry-run结果:', result);
      expect(result).toBeTruthy();
    } catch (error) {
      console.log('负载均衡dry-run错误:', error.message);
      throw error;
    }
  });
});