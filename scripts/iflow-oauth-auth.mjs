#!/usr/bin/env node

/**
 * iFlow OAuth认证脚本
 * 弹出浏览器界面让用户完成OAuth认证流程
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

class iFlowOAuthAuthenticator {
  constructor() {
    this.tokenFile = join(homedir(), '.iflow', 'oauth_creds.json');
    this.config = {
      clientId: '10009311001', // 从iFlow源码获取
      clientSecret: '4Z3YjXycVsQvyGF1etiNlIBB4RsqSDtW', // 从iFlow源码获取
      redirectUri: 'http://localhost:8080/callback',
      authUrl: 'https://iflow.cn/oauth',
      tokenUrl: 'https://iflow.cn/oauth/token',
      successUrl: 'https://iflow.cn/oauth/success',
      errorUrl: 'https://iflow.cn/oauth/error',
      scopes: ['chat', 'models']
    };
  }

  async startAuthentication() {
    console.log('🚀 启动iFlow OAuth认证流程...');

    // 检查是否已有token
    if (existsSync(this.tokenFile)) {
      try {
        const existingToken = JSON.parse(readFileSync(this.tokenFile, 'utf8'));
        if (this.isTokenValid(existingToken)) {
          console.log('✅ 现有token仍然有效');
          return existingToken;
        }
      } catch (error) {
        console.log('⚠️  现有token无效，需要重新认证');
      }
    }

    // 启动本地服务器接收回调
    const callbackServer = await this.startCallbackServer();

    // 构建认证URL
    const authUrl = this.buildAuthUrl();

    console.log('📱 正在打开浏览器进行认证...');
    console.log('🔗 认证URL:', authUrl);

    // 监听认证成功
    const authPromise = new Promise((resolve, reject) => {
      callbackServer.on('callback', (code) => {
        resolve(code);
      });

      // 超时处理
      setTimeout(() => {
        reject(new Error('认证超时'));
      }, 300000); // 5分钟超时
    });

    try {
      // 使用系统默认浏览器打开认证URL
      await this.openBrowser(authUrl);

      // 等待用户完成认证
      const authCode = await authPromise;

      console.log('✅ 收到授权码，正在获取token...');

      // 用授权码换取token
      const tokenData = await this.exchangeCodeForToken(authCode);

      // 保存token
      this.saveToken(tokenData);

      console.log('🎉 认证成功！token已保存');
      console.log('📁 Token文件位置:', this.tokenFile);

      return tokenData;

    } catch (error) {
      console.error('❌ 认证失败:', error.message);
      throw error;
    } finally {
      callbackServer.close();
    }
  }

  async openBrowser(url) {
    const platform = process.platform;
    let command;

    switch (platform) {
      case 'darwin': // macOS
        command = `open "${url}"`;
        break;
      case 'win32': // Windows
        command = `start "${url}"`;
        break;
      default: // Linux
        command = `xdg-open "${url}"`;
        break;
    }

    try {
      await execAsync(command);
    } catch (error) {
      console.error('无法打开浏览器:', error.message);
      console.log('请手动打开以下URL进行认证:');
      console.log(url);
    }
  }

  buildAuthUrl() {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: this.config.scopes.join(' '),
      state: this.generateState()
    });

    return `${this.config.authUrl}?${params}`;
  }

  generateState() {
    return Math.random().toString(36).substring(2, 15);
  }

  async startCallbackServer() {
    const http = await import('http');
    const url = await import('url');
    const EventEmitter = (await import('events')).EventEmitter;

    const server = new EventEmitter();

    const httpServer = http.createServer(async (req, res) => {
      const parsedUrl = url.parse(req.url, true);

      if (parsedUrl.pathname === '/callback') {
        const { code, state, error } = parsedUrl.query;

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <head>
                <title>认证失败</title>
                <style>
                  body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; }
                  .error { color: #d32f2f; }
                  .success { color: #388e3c; }
                </style>
              </head>
              <body>
                <h1 class="error">认证失败</h1>
                <p>错误: ${error}</p>
                <p>请关闭此窗口并重试</p>
              </body>
            </html>
          `);
          return;
        }

        if (code) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <head>
                <title>认证成功！</title>
                <style>
                  body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; }
                  .success { color: #388e3c; }
                </style>
              </head>
              <body>
                <h1 class="success">认证成功！</h1>
                <p>您已成功授权iFlow访问权限</p>
                <p>请关闭此窗口返回终端</p>
                <script>
                  setTimeout(() => {
                    window.close();
                  }, 3000);
                </script>
              </body>
            </html>
          `);

          server.emit('callback', code);
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Not Found</h1></body></html>');
      }
    });

    httpServer.listen(8080, () => {
      console.log('🔄 回调服务器已启动: http://localhost:8080');
    });

    server.close = () => {
      httpServer.close();
    };

    return server;
  }

  async exchangeCodeForToken(code) {
    try {
      const response = await fetch(this.config.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code,
          redirect_uri: this.config.redirectUri,
          client_id: this.config.clientId,
          client_secret: 'your_client_secret' // 需要从iFlow获取
        })
      });

      const responseText = await response.text();

      if (!response.ok) {
        console.error('Token交换失败:', response.status, response.statusText);
        console.error('响应内容:', responseText);
        throw new Error(`Token exchange failed: ${response.status} ${response.statusText}`);
      }

      let tokenData;
      try {
        tokenData = JSON.parse(responseText);
      } catch (parseError) {
        console.error('解析token响应失败:', parseError.message);
        console.error('原始响应:', responseText);
        throw new Error('Failed to parse token response');
      }

      return tokenData;
    } catch (error) {
      console.error('Token交换过程中发生错误:', error.message);
      throw error;
    }
  }

  async saveToken(tokenData) {
    const fs = await import('fs');
    const tokenWithMetadata = {
      ...tokenData,
      obtained_at: Date.now(),
      expires_in: tokenData.expires_in || 3600,
      provider: 'iflow'
    };

    const dir = join(homedir(), '.iflow');
    if (!existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    writeFileSync(this.tokenFile, JSON.stringify(tokenWithMetadata, null, 2));
  }

  isTokenValid(tokenData) {
    if (!tokenData.access_token) return false;

    const now = Date.now();
    const expiresAt = (tokenData.obtained_at || 0) + (tokenData.expires_in || 0) * 1000;

    // 提前5分钟过期以避免边界情况
    return now < expiresAt - 300000;
  }
}

// 主执行函数
async function main() {
  const authenticator = new iFlowOAuthAuthenticator();

  try {
    console.log('🔍 检查iFlow OAuth认证状态...');
    const tokenData = await authenticator.startAuthentication();
    console.log('🎉 iFlow OAuth认证完成！');
    console.log('📋 Token信息:');
    console.log('  - Access Token:', tokenData.access_token ? tokenData.access_token.substring(0, 20) + '...' : 'N/A');
    console.log('  - Token Type:', tokenData.token_type || 'N/A');
    console.log('  - 过期时间:', tokenData.expires_in || 'N/A', '秒');

    if (tokenData.refresh_token) {
      console.log('  - Refresh Token:', tokenData.refresh_token.substring(0, 20) + '...');
    }

    console.log('\n🔧 现在可以重新运行iFlow测试脚本了！');

  } catch (error) {
    console.error('❌ 认证流程失败:', error.message);
    console.log('\n💡 如果认证失败，请尝试以下步骤:');
    console.log('1. 确保iFlow服务可用');
    console.log('2. 检查网络连接');
    console.log('3. 手动访问iFlow官网获取API密钥');
    process.exit(1);
  }
}

// 运行认证
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { iFlowOAuthAuthenticator };