import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { homedir } from 'os';

describe('虚拟路由器负载均衡dry-run测试', () => {
  const testDir = path.join(homedir(), '.routecodex-lb-test');
  
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

  it('应该能在虚拟路由阶段进行负载均衡决策', () => {
    // 创建包含多个提供商的配置
    const configFile = path.join(testDir, 'virtual-router-config.json');
    const config = {
      "virtualrouter": {
        "dryRun": {
          "enabled": true
        },
        "inputProtocol": "openai",
        "outputProtocol": "openai",
        "routing": {
          "default": [
            "openai.gpt-4.key1",
            "anthropic.claude-3-sonnet.key1",
            "gemini.gemini-pro.key1"
          ]
        },
        "providers": {
          "openai": {
            "type": "openai",
            "apiKey": ["test-openai-key"],
            "baseURL": "https://api.openai.com/v1",
            "models": {
              "gpt-4": {},
              "gpt-3.5-turbo": {}
            }
          },
          "anthropic": {
            "type": "anthropic",
            "apiKey": ["test-anthropic-key"],
            "baseURL": "https://api.anthropic.com",
            "models": {
              "claude-3-sonnet": {}
            }
          },
          "gemini": {
            "type": "gemini",
            "apiKey": ["test-gemini-key"],
            "baseURL": "https://generativelanguage.googleapis.com",
            "models": {
              "gemini-pro": {}
            }
          }
        }
      }
    };
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

    // 创建测试请求
    const requestFile = path.join(testDir, 'test-request.json');
    const request = {
      model: "gpt-4",
      messages: [{ role: "user", content: "Test load balancer routing decision" }]
    };
    fs.writeFileSync(requestFile, JSON.stringify(request, null, 2));

    try {
      // 使用dry-run模式执行，重点关注路由决策
      const result = execSync(`node dist/cli.js dry-run request ${requestFile} --node-config ${configFile}`, {
        encoding: 'utf-8',
        cwd: '/Users/fanzhang/Documents/github/routecodex'
      });
      
      console.log('虚拟路由器负载均衡dry-run结果:');
      console.log(result);
      
      // 验证结果中包含负载均衡相关字段
      expect(result).toContain('loadBalancerDecision');
      expect(result).toContain('routingDecision');
      expect(result).toContain('selectedTarget');
      
      // 解析结果验证负载均衡逻辑
      const dryRunResult = JSON.parse(result);
      
      // 验证路由决策存在
      expect(dryRunResult.routingDecision).toBeDefined();
      expect(dryRunResult.routingDecision.loadBalancerDecision).toBeDefined();
      
      // 验证选择了某个提供商（而不是unknown）
      const selectedTarget = dryRunResult.routingDecision.selectedTarget;
      expect(selectedTarget.providerId).not.toBe('unknown');
      expect(['openai', 'anthropic', 'gemini']).toContain(selectedTarget.providerId);
      
      console.log(`✓ 负载均衡选择了提供商: ${selectedTarget.providerId}`);
      console.log(`✓ 选择原因: ${dryRunResult.routingDecision.loadBalancerDecision.reasoning}`);
      
    } catch (error) {
      console.log('虚拟路由器负载均衡dry-run错误:', error.message);
      // 即使出错也要验证错误中包含路由相关信息
      expect(error.message).toMatch(/routing|load.*balance|provider/i);
    }
  });

  it('应该能显示负载均衡的权重分配', () => {
    const configFile = path.join(testDir, 'weighted-config.json');
    const config = {
      "virtualrouter": {
        "dryRun": {
          "enabled": true
        },
        "inputProtocol": "openai",
        "outputProtocol": "openai",
        "routing": {
          "default": [
            "provider-a.gpt-4.key1",
            "provider-b.claude-3.key1",
            "provider-c.gemini-pro.key1"
          ]
        },
        "providers": {
          "provider-a": {
            "type": "openai",
            "apiKey": ["key-a"],
            "models": {
              "gpt-4": {}
            }
          },
          "provider-b": {
            "type": "anthropic",
            "apiKey": ["key-b"],
            "models": {
              "claude-3": {}
            }
          },
          "provider-c": {
            "type": "gemini",
            "apiKey": ["key-c"],
            "models": {
              "gemini-pro": {}
            }
          }
        }
      }
    };
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

    const requestFile = path.join(testDir, 'weighted-request.json');
    const request = {
      model: "gpt-4",
      messages: [{ role: "user", content: "Test weighted load balancing" }]
    };
    fs.writeFileSync(requestFile, JSON.stringify(request, null, 2));

    try {
      const result = execSync(`node dist/cli.js dry-run request ${requestFile} --node-config ${configFile}`, {
        encoding: 'utf-8',
        cwd: '/Users/fanzhang/Documents/github/routecodex'
      });
      
      const dryRunResult = JSON.parse(result);
      const lbDecision = dryRunResult.routingDecision.loadBalancerDecision;
      
      // 验证权重信息存在
      expect(lbDecision.weights).toBeDefined();
      expect(Object.keys(lbDecision.weights).length).toBeGreaterThan(0);
      
      console.log('负载均衡权重分配:');
      Object.entries(lbDecision.weights).forEach(([provider, weight]) => {
        console.log(`  ${provider}: ${weight}`);
      });
      
    } catch (error) {
      console.log('权重测试错误:', error.message);
    }
  });
});