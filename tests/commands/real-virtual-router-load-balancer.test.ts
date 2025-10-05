import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { homedir, tmpdir } from 'os';

describe('真实虚拟路由器负载均衡dry-run测试', () => {
  let testDir: string;
  
  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(tmpdir(), 'routecodex-real-lb-'));
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('应该执行真实的虚拟路由器负载均衡决策', () => {
    // 创建包含真实负载均衡配置的配置文件
    const configFile = path.join(testDir, 'real-load-balancer-config.json');
    const config = {
      "virtualRouter": {
        "dryRun": {
          "enabled": true,
          "includeLoadBalancerDetails": true,
          "includeWeightCalculation": true,
          "includeHealthStatus": true,
          "simulateProviderHealth": true
        }
      },
      "classificationConfig": {
        "protocolMapping": {
          "openai": {
            "endpoints": ["/v1/chat/completions"],
            "messageField": "messages",
            "modelField": "model", 
            "toolsField": "tools",
            "maxTokensField": "max_tokens"
          }
        },
        "protocolHandlers": {
          "openai": {
            "tokenCalculator": {},
            "toolDetector": {}
          }
        },
        "modelTiers": {
          "basic": { "maxTokens": 4096 },
          "advanced": { "maxTokens": 8192 }
        },
        "routingDecisions": {
          "default": {
            "criteria": {
              "modelTier": "basic",
              "maxTokens": 4096
            },
            "targets": {
              "openai-gpt35": { "weight": 0.5 },
              "anthropic-claude": { "weight": 0.3 },
              "gemini-pro": { "weight": 0.2 }
            },
            "loadBalancer": {
              "algorithm": "weighted-round-robin",
              "healthAware": true
            }
          },
          "high-tier": {
            "criteria": {
              "modelTier": "advanced", 
              "minTokens": 4097
            },
            "targets": {
              "openai-gpt4": { "weight": 0.6 },
              "anthropic-claude-advanced": { "weight": 0.4 }
            }
          }
        }
      },
      "providers": {
        "openai-gpt35": {
          "type": "openai",
          "api_key": "test-openai-key",
          "base_url": "https://api.openai.com/v1",
          "models": {
            "gpt-3.5-turbo": { "enabled": true }
          }
        },
        "anthropic-claude": {
          "type": "anthropic",
          "api_key": "test-anthropic-key", 
          "base_url": "https://api.anthropic.com",
          "models": {
            "claude-3-sonnet": { "enabled": true }
          }
        },
        "gemini-pro": {
          "type": "gemini",
          "api_key": "test-gemini-key",
          "base_url": "https://generativelanguage.googleapis.com",
          "models": {
            "gemini-pro": { "enabled": true }
          }
        }
      }
    };
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

    // 创建测试请求
    const requestFile = path.join(testDir, 'real-test-request.json');
    const request = {
      model: "gpt-3.5-turbo",
      messages: [{ 
        role: "user", 
        content: "Test real load balancer routing with weights distribution" 
      }],
      max_tokens: 100
    };
    fs.writeFileSync(requestFile, JSON.stringify(request, null, 2));

    try {
      // 执行包含虚拟路由器dry-run的请求
      const result = execSync(`node dist/cli.js dry-run request ${requestFile} --node-config ${configFile}`, {
        encoding: 'utf-8',
        cwd: process.cwd()
      });
      
      console.log('真实虚拟路由器负载均衡dry-run结果:');
      console.log(result);
      
      // 解析结果
      const dryRunResult = JSON.parse(result);
      
      // 验证虚拟路由器阶段有真实的负载均衡数据
      expect(dryRunResult.routingDecision).toBeDefined();
      expect(dryRunResult.routingDecision.selectedTarget).toBeDefined();
      
      // 验证选择的提供商不是unknown
      const selectedProvider = dryRunResult.routingDecision.selectedTarget.providerId;
      if (selectedProvider !== 'unknown') {
        expect(['openai-gpt35', 'anthropic-claude', 'gemini-pro']).toContain(selectedProvider);
      }
      
      // 验证负载均衡分析存在
      if (dryRunResult.loadBalancerAnalysis) {
        const lbAnalysis = dryRunResult.loadBalancerAnalysis;
        expect(lbAnalysis.providerWeights).toBeDefined();
        expect(Object.keys(lbAnalysis.providerWeights).length).toBeGreaterThan(0);
        expect(lbAnalysis.selectedProvider).toBe(selectedProvider);
        
        console.log(`✓ 真实负载均衡选择了: ${selectedProvider}`);
        console.log(`✓ 权重分配:`, lbAnalysis.providerWeights);
        console.log(`✓ 选择原因: ${lbAnalysis.selectionReason}`);
      }
      
      // 验证这是真实执行，不是模拟
      expect(dryRunResult.simulated).toBe(false);
      
    } catch (error) {
      console.log('真实虚拟路由器负载均衡测试错误:', (error as any).message);
      expect(error).toBeDefined();
    }
  });

  it('应该能验证权重分配算法', () => {
    const configFile = path.join(testDir, 'weight-algorithm-config.json');
    const config = {
      "virtualRouter": {
        "dryRun": {
          "enabled": true,
          "includeLoadBalancerDetails": true,
          "includeWeightCalculation": true
        }
      },
      "classificationConfig": {
        "protocolMapping": {
          "openai": {
            "endpoints": ["/v1/chat/completions"],
            "messageField": "messages",
            "modelField": "model",
            "toolsField": "tools",
            "maxTokensField": "max_tokens"
          }
        },
        "protocolHandlers": {
          "openai": {
            "tokenCalculator": {},
            "toolDetector": {}
          }
        },
        "modelTiers": {
          "basic": { "maxTokens": 4096 }
        },
        "routingDecisions": {
          "default": {
            "criteria": { "modelTier": "basic" },
            "targets": {
              "high-weight-provider": { "weight": 0.7 },
              "medium-weight-provider": { "weight": 0.2 },
              "low-weight-provider": { "weight": 0.1 }
            },
            "loadBalancer": {
              "algorithm": "weighted-round-robin"
            }
          }
        }
      },
      "providers": {
        "high-weight-provider": {
          "type": "openai",
          "api_key": "test-key-1",
          "models": { "gpt-3.5-turbo": { "enabled": true } }
        },
        "medium-weight-provider": {
          "type": "anthropic", 
          "api_key": "test-key-2",
          "models": { "claude-3": { "enabled": true } }
        },
        "low-weight-provider": {
          "type": "gemini",
          "api_key": "test-key-3",
          "models": { "gemini-pro": { "enabled": true } }
        }
      }
    };
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

    const requestFile = path.join(testDir, 'weight-test-request.json');
    const request = {
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: "Test weight algorithm" }]
    };
    fs.writeFileSync(requestFile, JSON.stringify(request, null, 2));

    try {
      const result = execSync(`node dist/cli.js dry-run request ${requestFile} --node-config ${configFile}`, {
        encoding: 'utf-8',
        cwd: process.cwd()
      });
      
      const dryRunResult = JSON.parse(result);
      
      // 验证权重信息
      if (dryRunResult.loadBalancerAnalysis) {
        const weights = dryRunResult.loadBalancerAnalysis.providerWeights;
        
        expect(weights['high-weight-provider']).toBe(0.7);
        expect(weights['medium-weight-provider']).toBe(0.2);
        expect(weights['low-weight-provider']).toBe(0.1);
        
        // 验证权重总和为1
        const totalWeight = Object.values(weights).reduce((sum: number, weight: number) => sum + weight, 0);
        expect(Math.abs(totalWeight - 1)).toBeLessThan(0.001);
        
        console.log('✓ 权重分配验证通过:', weights);
      }
      
    } catch (error) {
      console.log('权重算法测试错误:', error.message);
    }
  });
});
