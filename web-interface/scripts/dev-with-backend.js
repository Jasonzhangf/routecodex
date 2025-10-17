#!/usr/bin/env node

/**
 * 一键启动开发环境脚本
 * 自动启动后端服务，然后启动前端开发服务器
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class DevelopmentServer {
  constructor() {
    this.backendProcess = null;
    this.frontendProcess = null;
    this.isShuttingDown = false;
  }

  /**
   * 查找配置文件
   */
  findConfigFile() {
    const possiblePaths = [
      `${process.env.HOME}/.route-claudecode/config/v4/single-provider/lmstudio-v4-5506.json`,
      `${process.env.HOME}/.routecodex/config/default.json`,
      join(__dirname, '../config/default.json'),
      './config/default.json'
    ];

    for (const path of possiblePaths) {
      if (existsSync(path)) {
        console.log(`✅ 找到配置文件: ${path}`);
        return path;
      }
    }

    console.log('⚠️  未找到配置文件，将使用默认配置');
    return null;
  }

  /**
   * 启动后端服务
   */
  async startBackend() {
    console.log('🚀 启动 RouteCodex 后端服务...');

    const configPath = this.findConfigFile();
    const args = ['start'];

    if (configPath) {
      args.push('--config', configPath);
    }
    args.push('--port', '5506');

    return new Promise((resolve, reject) => {
      this.backendProcess = spawn('routecodex', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env }
      });

      let startupTimeout;
      let hasResolved = false;

      const cleanup = () => {
        if (startupTimeout) clearTimeout(startupTimeout);
        if (!hasResolved) {
          hasResolved = true;
          resolve(this.backendProcess);
        }
      };

      // 设置启动超时
      startupTimeout = setTimeout(() => {
        console.log('⏳ 后端服务启动中，继续启动前端...');
        cleanup();
      }, 5000);

      // 监听输出
      this.backendProcess.stdout.on('data', (data) => {
        const output = data.toString().trim();
        if (output) {
          console.log(`[Backend] ${output}`);

          // 检测成功启动的信号
          if (output.includes('Server started') || output.includes('listening')) {
            console.log('✅ 后端服务启动成功!');
            cleanup();
          }
        }
      });

      this.backendProcess.stderr.on('data', (data) => {
        const output = data.toString().trim();
        if (output) {
          console.error(`[Backend Error] ${output}`);
        }
      });

      this.backendProcess.on('error', (error) => {
        console.error('❌ 后端服务启动失败:', error.message);
        if (!hasResolved) {
          hasResolved = true;
          reject(error);
        }
      });

      this.backendProcess.on('exit', (code, signal) => {
        if (!this.isShuttingDown && !hasResolved) {
          console.log(`❌ 后端服务意外退出: code=${code}, signal=${signal}`);
          hasResolved = true;
          reject(new Error(`Backend process exited with code ${code}`));
        }
      });
    });
  }

  /**
   * 启动前端开发服务器
   */
  startFrontend() {
    console.log('🌐 启动前端开发服务器...');

    this.frontendProcess = spawn('npm', ['run', 'dev'], {
      stdio: 'inherit',
      cwd: join(__dirname, '..'),
      env: { ...process.env }
    });

    this.frontendProcess.on('error', (error) => {
      console.error('❌ 前端服务启动失败:', error.message);
    });

    this.frontendProcess.on('exit', (code, signal) => {
      if (!this.isShuttingDown) {
        console.log(`前端服务退出: code=${code}, signal=${signal}`);
      }
    });
  }

  /**
   * 设置优雅关闭
   */
  setupGracefulShutdown() {
    const shutdown = () => {
      console.log('\n🛑 正在关闭开发服务器...');
      this.isShuttingDown = true;

      if (this.frontendProcess) {
        this.frontendProcess.kill('SIGTERM');
      }

      if (this.backendProcess) {
        this.backendProcess.kill('SIGTERM');
      }

      setTimeout(() => {
        console.log('👋 开发服务器已关闭');
        process.exit(0);
      }, 2000);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('SIGQUIT', shutdown);
  }

  /**
   * 启动完整开发环境
   */
  async start() {
    console.log('🎯 RouteCodex 一键开发环境启动器');
    console.log('=====================================');

    this.setupGracefulShutdown();

    try {
      // 启动后端服务
      await this.startBackend();

      // 等待一下确保后端已经启动
      await new Promise(resolve => setTimeout(resolve, 2000));

      // 启动前端服务
      this.startFrontend();

      console.log('\n✅ 开发环境启动完成!');
      console.log('📱 前端地址: http://localhost:3000');
      console.log('🔧 后端地址: http://localhost:5506');
      console.log('\n按 Ctrl+C 关闭所有服务');

    } catch (error) {
      console.error('❌ 启动失败:', error.message);
      process.exit(1);
    }
  }
}

// 启动开发服务器
const devServer = new DevelopmentServer();
devServer.start().catch(console.error);