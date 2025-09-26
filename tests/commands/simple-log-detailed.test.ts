import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { homedir } from 'os';

describe('简化日志系统详细测试', () => {
  const testDir = path.join(homedir(), '.routecodex-simple-log-test');
  const configPath = path.join(testDir, 'simple-log-config.json');
  
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

  it('应该支持一键开启简单日志功能', () => {
    try {
      // 测试开启命令
      const result = execSync('node dist/cli.js simple-log on --level debug --output console', {
        encoding: 'utf-8',
        cwd: '/Users/fanzhang/Documents/github/routecodex'
      });
      
      console.log('开启简单日志结果:', result);
      
      // 验证输出包含成功信息
      expect(result).toContain('简单日志功能已开启');
      expect(result).toContain('日志级别: debug');
      expect(result).toContain('输出方式: console');
      
      // 验证配置文件被创建
      const configFile = path.join(homedir(), '.routecodex', 'simple-log-config.json');
      expect(fs.existsSync(configFile)).toBe(true);
      
      if (fs.existsSync(configFile)) {
        const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
        expect(config.enabled).toBe(true);
        expect(config.logLevel).toBe('debug');
        expect(config.output).toBe('console');
        expect(config.autoStart).toBe(true);
      }
      
    } catch (error) {
      console.log('开启简单日志错误:', error.message);
      throw error;
    }
  });

  it('应该支持一键关闭简单日志功能', () => {
    try {
      // 先开启
      execSync('node dist/cli.js simple-log on', {
        encoding: 'utf-8',
        cwd: '/Users/fanzhang/Documents/github/routecodex'
      });
      
      // 再关闭
      const result = execSync('node dist/cli.js simple-log off', {
        encoding: 'utf-8',
        cwd: '/Users/fanzhang/Documents/github/routecodex'
      });
      
      console.log('关闭简单日志结果:', result);
      
      expect(result).toContain('简单日志功能已关闭');
      expect(result).toContain('除非主动关闭，否则会一直保持开启状态');
      
      // 验证配置文件被更新
      const configFile = path.join(homedir(), '.routecodex', 'simple-log-config.json');
      if (fs.existsSync(configFile)) {
        const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
        expect(config.enabled).toBe(false);
      }
      
    } catch (error) {
      console.log('关闭简单日志错误:', error.message);
      throw error;
    }
  });

  it('应该支持查看日志状态', () => {
    try {
      // 先开启日志
      execSync('node dist/cli.js simple-log on --level info --output file', {
        encoding: 'utf-8',
        cwd: '/Users/fanzhang/Documents/github/routecodex'
      });
      
      // 查看状态
      const result = execSync('node dist/cli.js simple-log status', {
        encoding: 'utf-8',
        cwd: '/Users/fanzhang/Documents/github/routecodex'
      });
      
      console.log('查看日志状态结果:', result);
      
      expect(result).toContain('简单日志状态');
      expect(result).toContain('启用状态: ✅ 已开启');
      expect(result).toContain('日志级别: info');
      expect(result).toContain('输出方式: file');
      expect(result).toContain('日志目录:');
      expect(result).toContain('日志功能正在运行中');
      expect(result).toContain('除非主动关闭，否则会一直保持开启状态');
      
    } catch (error) {
      console.log('查看日志状态错误:', error.message);
      throw error;
    }
  });

  it('应该支持设置不同的日志级别', () => {
    const levels = ['error', 'warn', 'info', 'debug'];
    
    levels.forEach(level => {
      try {
        const result = execSync(`node dist/cli.js simple-log level ${level}`, {
          encoding: 'utf-8',
          cwd: '/Users/fanzhang/Documents/github/routecodex'
        });
        
        console.log(`设置日志级别为${level}结果:`, result);
        
        expect(result).toContain(`日志级别已设置为: ${level}`);
        expect(result).toContain('设置将在下次运行时生效');
        
      } catch (error) {
        console.log(`设置日志级别${level}错误:`, error.message);
        throw error;
      }
    });
  });

  it('应该支持不同的输出方式', () => {
    const outputs = ['console', 'file', 'both'];
    
    outputs.forEach(output => {
      try {
        const result = execSync(`node dist/cli.js simple-log output ${output}`, {
          encoding: 'utf-8',
          cwd: '/Users/fanzhang/Documents/github/routecodex'
        });
        
        console.log(`设置输出方式为${output}结果:`, result);
        
        expect(result).toContain(`输出方式已设置为: ${output}`);
        
        if (output === 'file' || output === 'both') {
          expect(result).toContain('日志将保存到:');
        }
        
        expect(result).toContain('设置将在下次运行时生效');
        
      } catch (error) {
        console.log(`设置输出方式${output}错误:`, error.message);
        throw error;
      }
    });
  });

  it('应该处理无效的输入并提供友好提示', () => {
    try {
      // 测试无效的日志级别
      const levelResult = execSync('node dist/cli.js simple-log level invalid-level', {
        encoding: 'utf-8',
        cwd: '/Users/fanzhang/Documents/github/routecodex'
      });
      
      console.log('无效日志级别测试结果:', levelResult);
      
      expect(levelResult).toContain('无效的日志级别: invalid-level');
      expect(levelResult).toContain('有效级别: error, warn, info, debug');
      
    } catch (error) {
      // 预期会失败，验证错误信息
      expect(error.message).toMatch(/无效的日志级别/);
    }
    
    try {
      // 测试无效的输出方式
      const outputResult = execSync('node dist/cli.js simple-log output invalid-output', {
        encoding: 'utf-8',
        cwd: '/Users/fanzhang/Documents/github/routecodex'
      });
      
      console.log('无效输出方式测试结果:', outputResult);
      
      expect(outputResult).toContain('无效的输出方式: invalid-output');
      expect(outputResult).toContain('有效方式: console, file, both');
      
    } catch (error) {
      // 预期会失败，验证错误信息
      expect(error.message).toMatch(/无效的输出方式/);
    }
  });

  it('应该验证简化后的日志系统行为', () => {
    try {
      // 测试简化后的UnifiedLogger行为
      const testFile = path.join(testDir, 'test-simple-logger.js');
      
      const testCode = `
const { UnifiedModuleLogger } = require('./dist/logging/UnifiedLogger.js');
const { LogLevel } = require('./dist/logging/types.js');

const logger = new UnifiedModuleLogger({
  moduleId: 'test-module',
  moduleType: 'test',
  logLevel: LogLevel.INFO,
  enableConsole: true,
  enableFile: false,
  maxHistory: 0 // 禁用历史记录
});

// 测试日志写入
logger.info('测试信息日志');
logger.debug('测试调试日志'); // 应该被过滤
logger.warn('测试警告日志');
logger.error('测试错误日志');

// 测试历史记录（应该为空）
const history = logger.getHistory();
console.log('历史记录数量:', history.length);

// 测试查询（应该返回空结果）
logger.queryLogs({}).then(result => {
  console.log('查询结果:', JSON.stringify(result));
});
`;
      
      fs.writeFileSync(testFile, testCode);
      
      const result = execSync(`node ${testFile}`, {
        encoding: 'utf-8',
        cwd: '/Users/fanzhang/Documents/github/routecodex'
      });
      
      console.log('简化日志系统行为测试结果:', result);
      
      // 验证简化后的行为
      expect(result).toContain('历史记录数量: 0'); // 历史记录被禁用
      expect(result).toContain('查询结果:'); // 查询功能存在但返回空结果
      
      // 清理测试文件
      if (fs.existsSync(testFile)) {
        fs.unlinkSync(testFile);
      }
      
    } catch (error) {
      console.log('简化日志系统行为测试错误:', error.message);
      throw error;
    }
  });
});