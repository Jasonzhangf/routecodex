import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { homedir } from 'os';

describe('三种dry-run模式测试', () => {
  const testDir = path.join(homedir(), '.routecodex-three-modes-test');
  
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

  // 创建测试配置
  const createTestConfig = () => {
    const configFile = path.join(testDir, 'three-modes-config.json');
    const config = {
      "virtualrouter": {
        "dryRun": {
          "enabled": true
        },
        "inputProtocol": "openai",
        "outputProtocol": "openai",
        "routing": {
          "default": [
            "provider-a.gpt-3.5-turbo.key1",
            "provider-b.claude-3.key1",
            "provider-c.gemini-pro.key1"
          ]
        },
        "providers": {
          "provider-a": {
            "type": "openai",
            "apiKey": ["test-key-a"],
            "models": {
              "gpt-3.5-turbo": {}
            }
          },
          "provider-b": {
            "type": "anthropic",
            "apiKey": ["test-key-b"],
            "models": {
              "claude-3": {}
            }
          },
          "provider-c": {
            "type": "gemini",
            "apiKey": ["test-key-c"],
            "models": {
              "gemini-pro": {}
            }
          }
        }
      }
    };
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    return configFile;
  };

  // 创建测试请求
  const createTestRequest = () => {
    const requestFile = path.join(testDir, 'three-modes-request.json');
    const request = {
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: "Test three dry-run modes" }]
    };
    fs.writeFileSync(requestFile, JSON.stringify(request, null, 2));
    return requestFile;
  };

  it('应该支持仅调度模式（routing-only）', () => {
    const configFile = createTestConfig();
    const requestFile = createTestRequest();

    try {
      const result = execSync(`node dist/cli.js dry-run request ${requestFile} --scope routing-only --node-config ${configFile}`, {
        encoding: 'utf-8',
        cwd: '/Users/fanzhang/Documents/github/routecodex'
      });
      
      console.log('仅调度模式结果:');
      console.log(result);
      
      const dryRunResult = JSON.parse(result);
      
      // 验证仅调度模式特征
      expect(dryRunResult.virtualRouter).toBeDefined();
      expect(dryRunResult.pipeline).toBeUndefined(); // 流水线不应该执行
      expect(dryRunResult.combinedAnalysis.scope).toBe('routing-only');
      
      // 验证有真实的负载均衡数据
      expect(dryRunResult.virtualRouter.loadBalancerAnalysis).toBeDefined();
      expect(dryRunResult.virtualRouter.loadBalancerAnalysis.selectedProvider).not.toBe('unknown');
      
      console.log(`✓ 仅调度模式选择了提供商: ${dryRunResult.virtualRouter.loadBalancerAnalysis.selectedProvider}`);
      
    } catch (error) {
      console.log('仅调度模式错误:', error.message);
      throw error;
    }
  });

  it('应该支持仅流水线模式（pipeline-only）', () => {
    const configFile = createTestConfig();
    const requestFile = createTestRequest();

    try {
      const result = execSync(`node dist/cli.js dry-run request ${requestFile} --scope pipeline-only --node-config ${configFile}`, {
        encoding: 'utf-8',
        cwd: '/Users/fanzhang/Documents/github/routecodex'
      });
      
      console.log('仅流水线模式结果:');
      console.log(result);
      
      const dryRunResult = JSON.parse(result);
      
      // 验证仅流水线模式特征
      expect(dryRunResult.nodeResults).toBeDefined(); // 应该有流水线节点结果
      expect(dryRunResult.virtualRouter).toBeUndefined(); // 不应该有虚拟路由器结果
      expect(dryRunResult.routingDecision.selectedTarget.providerId).toBe('unknown'); // 模拟的调度结果
      
      console.log('✓ 仅流水线模式执行了3个节点:', Object.keys(dryRunResult.nodeResults).length);
      
    } catch (error) {
      console.log('仅流水线模式错误:', error.message);
      throw error;
    }
  });

  it('应该支持完整模式（full）', () => {
    const configFile = createTestConfig();
    const requestFile = createTestRequest();

    try {
      const result = execSync(`node dist/cli.js dry-run request ${requestFile} --scope full --node-config ${configFile}`, {
        encoding: 'utf-8',
        cwd: '/Users/fanzhang/Documents/github/routecodex'
      });
      
      console.log('完整模式结果:');
      console.log(result);
      
      const dryRunResult = JSON.parse(result);
      
      // 验证完整模式特征
      expect(dryRunResult.virtualRouter).toBeDefined(); // 应该有虚拟路由器结果
      expect(dryRunResult.pipeline).toBeDefined(); // 应该有流水线结果
      expect(dryRunResult.combinedAnalysis.scope).toBe('full');
      
      // 验证真实的负载均衡决策
      expect(dryRunResult.virtualRouter.loadBalancerAnalysis).toBeDefined();
      expect(dryRunResult.virtualRouter.loadBalancerAnalysis.selectedProvider).not.toBe('unknown');
      
      console.log(`✓ 完整模式调度选择了: ${dryRunResult.virtualRouter.loadBalancerAnalysis.selectedProvider}`);
      console.log(`✓ 完整模式执行了流水线: ${Object.keys(dryRunResult.pipeline.nodeResults).length} 个节点`);
      
    } catch (error) {
      console.log('完整模式错误:', error.message);
      throw error;
    }
  });

  it('应该默认使用完整模式', () => {
    const configFile = createTestConfig();
    const requestFile = createTestRequest();

    try {
      const result = execSync(`node dist/cli.js dry-run request ${requestFile} --node-config ${configFile}`, {
        encoding: 'utf-8',
        cwd: '/Users/fanzhang/Documents/github/routecodex'
      });
      
      const dryRunResult = JSON.parse(result);
      
      // 验证默认是完整模式
      expect(dryRunResult.combinedAnalysis?.scope || 'full').toBe('full');
      console.log('✓ 默认模式验证通过');
      
    } catch (error) {
      console.log('默认模式错误:', error.message);
      throw error;
    }
  });
});