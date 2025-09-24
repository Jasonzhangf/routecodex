#!/usr/bin/env node

/**
 * Simple GLM provider startup script
 */

import { spawn } from 'child_process';
import { resolve } from 'path';

// Check for environment variable
if (!process.env.GLM_API_KEY) {
  console.error('❌ GLM_API_KEY environment variable not set');
  console.error('Please set: export GLM_API_KEY=your-api-key');
  process.exit(1);
}

console.log('🚀 Starting GLM Provider Server...');
console.log('📋 Configuration: GLM Provider (OpenAI Compatible)');
console.log('🌐 Base URL: https://open.bigmodel.cn/api/coding/paas/v4');
console.log('🔑 API Key: [SET]');

// Start the server
const serverProcess = spawn('node', [
  'dist/index.js',
  'start',
  '--config',
  resolve(process.cwd(), 'config/glm-provider-config.json')
], {
  stdio: 'inherit',
  env: {
    ...process.env,
    GLM_API_KEY: process.env.GLM_API_KEY
  }
});

serverProcess.on('error', (error) => {
  console.error('❌ Failed to start server:', error.message);
  process.exit(1);
});

serverProcess.on('exit', (code) => {
  if (code !== 0) {
    console.error(`❌ Server exited with code ${code}`);
    process.exit(code);
  }
});

console.log('✅ GLM Provider server started successfully');
console.log('📝 Use Ctrl+C to stop the server');