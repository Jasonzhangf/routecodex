#!/usr/bin/env node

/**
 * 未使用变量清理脚本
 * 
 * 功能：
 * 1. 自动移除未使用的导入
 * 2. 未使用参数添加下划线前缀
 * 3. 移除未使用的变量声明
 * 4. 保留必要的类型导入
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_DIR = path.join(__dirname, 'src');

// 统计信息
let stats = {
  filesProcessed: 0,
  unusedImportsRemoved: 0,
  unusedParamsFixed: 0,
  unusedVarsRemoved: 0,
  errors: 0
};

/**
 * 获取文件的lint警告
 */
function getLintWarnings(filePath) {
  try {
    const { execSync } = require('child_process');
    const lintOutput = execSync(`npx eslint "${filePath}" --format=json`, { 
      encoding: 'utf8',
      cwd: __dirname 
    });
    
    const warnings = JSON.parse(lintOutput);
    return warnings.length > 0 && warnings[0].messages ? warnings[0].messages : [];
  } catch (error) {
    return [];
  }
}

/**
 * 处理未使用的导入
 */
function handleUnusedImports(content, warnings) {
  let modifiedContent = content;
  let removedCount = 0;

  // 按行号倒序处理，避免行号偏移
  const unusedImportWarnings = warnings
    .filter(msg => msg.ruleId === '@typescript-eslint/no-unused-vars' && 
                     msg.message.includes('is defined but never used'))
    .sort((a, b) => b.line - a.line);

  for (const warning of unusedImportWarnings) {
    const line = warning.line - 1; // 转换为0基索引
    const lines = modifiedContent.split('\n');
    
    if (lines[line]) {
      const targetLine = lines[line];
      
      // 检查是否是导入语句
      if (targetLine.trim().startsWith('import')) {
        // 移除整行
        lines.splice(line, 1);
        modifiedContent = lines.join('\n');
        removedCount++;
        console.log(`  移除未使用导入: 第${warning.line}行`);
      }
    }
  }

  return { content: modifiedContent, removedCount };
}

/**
 * 处理未使用的参数
 */
function handleUnusedParams(content, warnings) {
  let modifiedContent = content;
  let fixedCount = 0;

  const unusedParamWarnings = warnings
    .filter(msg => msg.ruleId === '@typescript-eslint/no-unused-vars' && 
                     msg.message.includes('is defined but never used') &&
                     msg.message.includes('Allowed unused args must match /^_/u'))
    .sort((a, b) => b.line - a.line);

  for (const warning of unusedParamWarnings) {
    const line = warning.line - 1;
    const lines = modifiedContent.split('\n');
    
    if (lines[line]) {
      const targetLine = lines[line];
      const column = warning.column - 1;
      
      // 查找参数名
      const paramMatch = targetLine.substring(column).match(/(\w+)/);
      if (paramMatch) {
        const paramName = paramMatch[1];
        
        // 添加下划线前缀
        lines[line] = targetLine.replace(
          new RegExp(`\\b${paramName}\\b(?=\\s*[:=])`),
          `_${paramName}`
        );
        modifiedContent = lines.join('\n');
        fixedCount++;
        console.log(`  修复未使用参数: ${paramName} → _${paramName} (第${warning.line}行)`);
      }
    }
  }

  return { content: modifiedContent, fixedCount };
}

/**
 * 处理未使用的变量
 */
function handleUnusedVars(content, warnings) {
  let modifiedContent = content;
  let removedCount = 0;

  const unusedVarWarnings = warnings
    .filter(msg => msg.ruleId === '@typescript-eslint/no-unused-vars' && 
                     msg.message.includes('is assigned a value but never used'))
    .sort((a, b) => b.line - a.line);

  for (const warning of unusedVarWarnings) {
    const line = warning.line - 1;
    const lines = modifiedContent.split('\n');
    
    if (lines[line]) {
      const targetLine = lines[line];
      
      // 检查是否是变量声明
      if (targetLine.trim().match(/^(const|let|var)\s+\w+/)) {
        // 移除整行
        lines.splice(line, 1);
        modifiedContent = lines.join('\n');
        removedCount++;
        console.log(`  移除未使用变量: 第${warning.line}行`);
      }
    }
  }

  return { content: modifiedContent, removedCount };
}

/**
 * 处理特殊情况的未使用变量
 */
function handleSpecialCases(content) {
  let modifiedContent = content;
  let fixedCount = 0;

  // 处理常见的未使用变量模式
  const specialPatterns = [
    {
      pattern: /(?:const|let|var)\s+status\s*=\s*[^;]+;/g,
      replacement: '// status removed',
      description: '移除status变量'
    },
    {
      pattern: /(?:const|let|var)\s+maxResponseTime\s*=\s*[^;]+;/g,
      replacement: '// maxResponseTime removed', 
      description: '移除maxResponseTime变量'
    },
    {
      pattern: /(?:const|let|var)\s+minResponseTime\s*=\s*[^;]+;/g,
      replacement: '// minResponseTime removed',
      description: '移除minResponseTime变量'
    }
  ];

  for (const pattern of specialPatterns) {
    const before = modifiedContent;
    modifiedContent = modifiedContent.replace(pattern.pattern, pattern.replacement);
    const changes = (before.match(pattern.pattern) || []).length;
    fixedCount += changes;
    
    if (changes > 0) {
      console.log(`  ${pattern.description}: ${changes} 处`);
    }
  }

  return { content: modifiedContent, fixedCount };
}

/**
 * 处理单个文件
 */
function processFile(filePath) {
  try {
    console.log(`\n处理文件: ${filePath}`);
    
    // 读取文件内容
    const content = fs.readFileSync(filePath, 'utf8');
    let modifiedContent = content;

    // 获取lint警告
    const warnings = getLintWarnings(filePath);
    if (warnings.length === 0) {
      console.log(`  - 无lint警告`);
      stats.filesProcessed++;
      return;
    }

    console.log(`  发现 ${warnings.length} 个lint警告`);

    // 处理未使用的导入
    const importResult = handleUnusedImports(modifiedContent, warnings);
    modifiedContent = importResult.content;
    stats.unusedImportsRemoved += importResult.removedCount;

    // 处理未使用的参数
    const paramResult = handleUnusedParams(modifiedContent, warnings);
    modifiedContent = paramResult.content;
    stats.unusedParamsFixed += paramResult.fixedCount;

    // 处理未使用的变量
    const varResult = handleUnusedVars(modifiedContent, warnings);
    modifiedContent = varResult.content;
    stats.unusedVarsRemoved += varResult.removedCount;

    // 处理特殊情况
    const specialResult = handleSpecialCases(modifiedContent);
    modifiedContent = specialResult.content;
    // stats.specialCasesFixed += specialResult.fixedCount;

    // 如果有修改，写回文件
    if (modifiedContent !== content) {
      // 创建备份
      const backupPath = filePath + '.backup';
      if (!fs.existsSync(backupPath)) {
        fs.writeFileSync(backupPath, content);
      }
      
      // 写入修改后的内容
      fs.writeFileSync(filePath, modifiedContent);
      
      const totalChanges = importResult.removedCount + 
                          paramResult.fixedCount + 
                          varResult.removedCount + 
                          specialResult.fixedCount;
      
      console.log(`  ✓ 完成: ${totalChanges} 处修改`);
    } else {
      console.log(`  - 无需修改`);
    }

    stats.filesProcessed++;
    
  } catch (error) {
    console.error(`  ✗ 错误: ${error.message}`);
    stats.errors++;
  }
}

/**
 * 递归遍历目录
 */
function walkDirectory(dir, callback) {
  const files = fs.readdirSync(dir);
  
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    
    if (stat.isDirectory()) {
      // 跳过node_modules和__tests__目录
      if (!['node_modules', '__tests__', '.git'].includes(file)) {
        walkDirectory(filePath, callback);
      }
    } else if (file.endsWith('.ts')) {
      callback(filePath);
    }
  }
}

/**
 * 主函数
 */
function main() {
  console.log('🧹 开始未使用变量清理');
  console.log('=' .repeat(60));
  
  const startTime = Date.now();
  
  // 遍历src目录
  walkDirectory(SRC_DIR, processFile);
  
  const endTime = Date.now();
  const duration = ((endTime - startTime) / 1000).toFixed(2);
  
  console.log('\n' + '='.repeat(60));
  console.log('📊 清理统计:');
  console.log(`  文件处理数: ${stats.filesProcessed}`);
  console.log(`  移除未使用导入: ${stats.unusedImportsRemoved}`);
  console.log(`  修复未使用参数: ${stats.unusedParamsFixed}`);
  console.log(`  移除未使用变量: ${stats.unusedVarsRemoved}`);
  console.log(`  错误数: ${stats.errors}`);
  console.log(`  耗时: ${duration}秒`);
  console.log('=' .repeat(60));
  
  if (stats.errors > 0) {
    console.log(`⚠️  有 ${stats.errors} 个错误，请检查日志`);
    process.exit(1);
  } else {
    console.log('✅ 未使用变量清理完成！');
  }
}

// 运行主函数
main();
