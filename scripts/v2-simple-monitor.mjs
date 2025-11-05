#!/usr/bin/env node

/**
 * V2干运行简单监控脚本
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

console.log('🚀 V2干运行状态检查');
console.log('='.repeat(40));

// 1. 检查进程状态
console.log('\n📊 进程状态:');
try {
  const nodeProcesses = execSync('ps aux | grep node | grep -v grep', { encoding: 'utf8' });
  if (nodeProcesses.trim()) {
    console.log('✅ 发现Node.js进程:');
    nodeProcesses.split('\n').filter(line => line.trim()).forEach(line => {
      console.log(`  ${line.split(/\s+/).slice(10).join(' ').substring(0, 80)}...`);
    });
  } else {
    console.log('❌ 未发现Node.js进程');
  }
} catch (error) {
  console.log('❌ 无法检查进程:', error.message);
}

// 2. 检查debug-logs目录
console.log('\n📁 调试日志状态:');
const debugLogsDir = path.join(projectRoot, 'debug-logs');
if (fs.existsSync(debugLogsDir)) {
  const files = fs.readdirSync(debugLogsDir);
  const logFiles = files.filter(f => f.includes('pipeline-session'));

  if (logFiles.length > 0) {
    console.log(`✅ 发现 ${logFiles.length} 个流水线日志文件`);

    // 分析最新的几个日志
    const recentFiles = logFiles
      .map(f => ({
        name: f,
        path: path.join(debugLogsDir, f),
        mtime: fs.statSync(path.join(debugLogsDir, f)).mtime
      }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 5);

    console.log('\n📈 最近的流水线活动:');
    recentFiles.forEach(file => {
      try {
        const content = fs.readFileSync(file.path, 'utf8');
        const logData = JSON.parse(content);

        console.log(`  📋 ${logData.sessionId}`);
        console.log(`     状态: ${logData.status}`);
        console.log(`     开始时间: ${new Date(logData.startTime).toLocaleString()}`);
        console.log(`     操作数: ${logData.operations?.length || 0}`);

        if (logData.operations && logData.operations.length > 0) {
          const operations = logData.operations.map(op => op.operationId).join(', ');
          console.log(`     操作: ${operations}`);
        }
        console.log('');
      } catch (error) {
        console.log(`  ❌ 无法解析 ${file.name}: ${error.message}`);
      }
    });
  } else {
    console.log('❌ debug-logs目录中没有流水线日志');
  }
} else {
  console.log('❌ debug-logs目录不存在');
}

// 3. 检查编译输出
console.log('\n🔧 编译状态:');
const distDir = path.join(projectRoot, 'dist');
const v2DistDir = path.join(distDir, 'modules/pipeline/v2');

if (fs.existsSync(v2DistDir)) {
  console.log('✅ V2模块已编译');

  const v2Files = [];
  function collectFiles(dir, prefix = '') {
    const items = fs.readdirSync(dir);
    for (const item of items) {
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        collectFiles(fullPath, prefix + item + '/');
      } else if (item.endsWith('.js')) {
        v2Files.push(prefix + item);
      }
    }
  }

  collectFiles(v2DistDir);
  console.log(`  📦 V2组件: ${v2Files.length} 个文件`);
  v2Files.slice(0, 5).forEach(file => console.log(`    - ${file}`));
  if (v2Files.length > 5) {
    console.log(`    ... 还有 ${v2Files.length - 5} 个文件`);
  }
} else {
  console.log('❌ V2模块未编译或不存在');
}

// 4. 检查配置文件
console.log('\n⚙️  配置文件状态:');
const configDirs = [
  path.join(projectRoot, 'config'),
  path.join(projectRoot, '.route-claudecode'),
  path.join(projectRoot, 'src/config')
];

let configFound = false;
for (const configDir of configDirs) {
  if (fs.existsSync(configDir)) {
    const files = fs.readdirSync(configDir);
    const configFiles = files.filter(f =>
      f.includes('.json') && (f.includes('v2') || f.includes('config'))
    );

    if (configFiles.length > 0) {
      console.log(`✅ ${configDir}:`);
      configFiles.forEach(file => console.log(`  📄 ${file}`));
      configFound = true;
    }
  }
}

if (!configFound) {
  console.log('❌ 未发现配置文件');
}

// 5. 生成简单建议
console.log('\n💡 状态总结和建议:');

const debugLogsCount = fs.existsSync(debugLogsDir)
  ? fs.readdirSync(debugLogsDir).filter(f => f.includes('pipeline-session')).length
  : 0;

if (debugLogsCount > 0) {
  console.log('✅ 流水线系统活跃');
  console.log('💡 建议运行: node src/server/http-server.ts 启动完整服务');
} else {
  console.log('⚠️  流水线系统可能未启动');
  console.log('💡 建议检查服务启动状态');
}

if (fs.existsSync(v2DistDir)) {
  console.log('✅ V2模块已准备就绪');
  console.log('💡 可以在代码中集成V2干运行功能');
} else {
  console.log('⚠️  V2模块需要编译');
  console.log('💡 运行: npm run build');
}

console.log('\n🔍 监控完成!');