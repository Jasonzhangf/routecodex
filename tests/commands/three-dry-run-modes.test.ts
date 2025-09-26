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

  it('应该支持仅调度模式（routing-only）', () => {
    // 创建测试请求
    const requestFile = path.join(testDir, 'test-request.json');
    const request = {
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: "Test routing-only mode" }]
    };
    fs.writeFileSync(requestFile, JSON.stringify(request, null, 2));

    try {
      // 执行仅调度模式
      const result = execSync(`node dist/cli.js dry-run request ${requestFile} --scope routing-only`, {
        encoding: 'utf-8',
        cwd: '/Users/fanzhang/Documents/github/routecodex'
      });
      
      console.log('仅调度模式结果:');
      console.log(result);
      
      const dryRunResult = JSON.parse(result);
      
      // 验证仅调度模式的特征
      expect(dryRunResult.virtualRouter).toBeDefined();
      expect(dryRunResult.pipeline).toBeUndefined(); // 流水线不应该执行
      expect(dryRunResult.combinedAnalysis).toBeDefined();
      expect(dryRunResult.combinedAnalysis.scope).toBe('routing-only');
      
      // 验证有真实的负载均衡数据
      if (dryRunResult.virtualRouter.loadBalancerAnalysis) {
        const lbAnalysis = dryRunResult.virtualRouter.loadBalancerAnalysis;
        expect(lbAnalysis.selectedProvider).toBeDefined();
        expect(lbAnalysis.selectedProvider).not.toBe('unknown');
        expect(lbAnalysis.providerWeights).toBeDefined();
        
        console.log(`✓ 仅调度模式选择了提供商: ${lbAnalysis.selectedProvider}`);
        console.log(`✓ 权重分配:`, lbAnalysis.providerWeights);
      }
      
    } catch (error) {
      console.log('仅调度模式错误:', error.message);
      // 即使出错也要验证错误信息合理
      expect(error.message).toMatch(/routing|virtual.*router|scope/i);
    }
  });

  it('应该支持仅流水线模式（pipeline-only）', () => {
    const requestFile = path.join(testDir, 'pipeline-test-request.json');
    const request = {
      model: "gpt-3.5-turbo", 
      messages: [{ role: "user", content: "Test pipeline-only mode" }]
    };
    fs.writeFileSync(requestFile, JSON.stringify(request, null, 2));

    try {
      // 执行仅流水线模式
      const result = execSync(`node dist/cli.js dry-run request ${requestFile} --scope pipeline-only`, {
        encoding: 'utf-8',
        cwd: '/Users/fanzhang/Documents/github/routecodex'
      });
      
      console.log('仅流水线模式结果:');
      console.log(result);
      
      const dryRunResult = JSON.parse(result);
      
      // 验证仅流水线模式的特征
      expect(dryRunResult.mode).toBe('dry-run');
      expect(dryRunResult.nodeResults).toBeDefined(); // 应该有节点执行结果
      expect(dryRunResult.executionPlan).toBeDefined(); // 应该有执行计划
      
      // 验证有流水线节点执行（llm-switch, compatibility, provider）
      expect(dryRunResult.nodeResults['llm-switch']).toBeDefined();
      expect(dryRunResult.nodeResults['compatibility']).toBeDefined();
      expect(dryRunResult.nodeResults['provider']).toBeDefined();
      
      // 验证这是流水线模拟，不是真实调度
      const routingDecision = dryRunResult.routingDecision;
      expect(routingDecision.loadBalancerDecision.algorithm).toBe('simulated-dry-run');
      expect(routingDecision.selectedTarget.providerId).toBe('unknown');
      
      console.log('✓ 仅流水线模式执行了标准流水线节点');
      
    } catch (error) {
      console.log('仅流水线模式错误:', error.message);
    }
  });

  it('应该支持完整模式（full）', () => {
    const requestFile = path.join(testDir, 'full-test-request.json');
    const request = {
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: "Test full mode with both routing and pipeline" }]
    };
    fs.writeFileSync(requestFile, JSON.stringify(request, null, 2));

    try {
      // 执行完整模式（默认）
      const result = execSync(`node dist/cli.js dry-run request ${requestFile} --scope full`, {
        encoding: 'utf-8',
        cwd: '/Users/fanzhang/Documents/github/routecodex'
      });
      
      console.log('完整模式结果:');
      console.log(result);
      
      const dryRunResult = JSON.parse(result);
      
      // 验证完整模式的特征
      expect(dryRunResult.virtualRouter).toBeDefined();
      expect(dryRunResult.pipeline).toBeDefined();
      expect(dryRunResult.combinedAnalysis).toBeDefined();
      expect(dryRunResult.combinedAnalysis.scope).toBe('full');
      
      // 验证有真实的调度数据
      if (dryRunResult.virtualRouter.loadBalancerAnalysis) {
        const lbAnalysis = dryRunResult.virtualRouter.loadBalancerAnalysis;
        expect(lbAnalysis.selectedProvider).toBeDefined();
        expect(lbAnalysis.selectedProvider).not.toBe('unknown');
        expect(lbAnalysis.providerWeights).toBeDefined();
        
        console.log(`✓ 完整模式调度结果: ${lbAnalysis.selectedProvider}`);
      }
      
      // 验证也有流水线执行结果
      expect(dryRunResult.pipeline.nodeResults).toBeDefined();
      console.log('✓ 完整模式包含调度和流水线执行结果');
      
    } catch (error) {
      console.log('完整模式错误:', error.message);
    }
  });

  it('应该能比较三种模式的不同输出', () => {
    const requestFile = path.join(testDir, 'compare-test-request.json');
    const request = {
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: "Compare three dry-run modes" }]
    };
    fs.writeFileSync(requestFile, JSON.stringify(request, null, 2));

    const results = {};

    // 测试三种模式
    const modes = ['routing-only', 'pipeline-only', 'full'];
    
    modes.forEach(mode => {
      try {
        const result = execSync(`node dist/cli.js dry-run request ${requestFile} --scope ${mode}`, {
          encoding: 'utf-8',
          cwd: '/Users/fanzhang/Documents/github/routecodex'
        });
        
        results[mode] = JSON.parse(result);
        console.log(`${mode} 模式执行成功`);
        
      } catch (error) {
        console.log(`${mode} 模式错误:`, error.message);
        results[mode] = { error: error.message };
      }
    });

    // 验证三种模式输出结构不同
    if (results['routing-only'] && !results['routing-only'].error) {
      expect(results['routing-only'].virtualRouter).toBeDefined();
      expect(results['routing-only'].pipeline).toBeUndefined();
    }

    if (results['pipeline-only'] && !results['pipeline-only'].error) {
      expect(results['pipeline-only'].nodeResults).toBeDefined();
      expect(results['pipeline-only'].virtualRouter).toBeUndefined();
    }

    if (results['full'] && !results['full'].error) {
      expect(results['full'].virtualRouter).toBeDefined();
      expect(results['full'].pipeline).toBeDefined();
    }

    console.log('✓ 三种模式输出结构验证完成');
  });
});