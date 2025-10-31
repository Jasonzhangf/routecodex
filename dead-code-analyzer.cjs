#!/usr/bin/env node

/**
 * 废弃函数分析器 - 深度分析RouteCodex项目中的未使用函数和死代码
 *
 * 功能：
 * 1. 扫描所有TypeScript/JavaScript文件中的函数定义
 * 2. 分析函数调用关系和引用情况
 * 3. 识别未使用的导出函数、类方法、工具函数
 * 4. 检测死代码块和未执行的条件分支
 * 5. 分析未使用的常量、接口、类型定义
 * 6. 生成详细的清理清单和风险评估
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

class DeadCodeAnalyzer {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.functionDefinitions = new Map(); // 函数定义
    this.functionCalls = new Map(); // 函数调用
    this.imports = new Map(); // 导入关系
    this.exports = new Map(); // 导出关系
    this.classes = new Map(); // 类定义
    this.interfaces = new Map(); // 接口定义
    this.constants = new Map(); // 常量定义
    this.typeAliases = new Map(); // 类型别名
    this.unusedFunctions = []; // 未使用的函数
    this.deadCodeBlocks = []; // 死代码块
    this.unusedImports = []; // 未使用的导入
    this.analysisResults = {
      summary: {},
      unusedFunctions: [],
      unusedConstants: [],
      unusedTypes: [],
      unusedImports: [],
      deadCodeBlocks: [],
      riskAssessment: []
    };
  }

  /**
   * 分析项目中的所有文件
   */
  async analyzeProject() {
    console.log('🔍 开始深度分析RouteCodex项目...');

    // 1. 扫描所有TypeScript/JavaScript文件
    const sourceFiles = this.scanSourceFiles();
    console.log(`📁 找到 ${sourceFiles.length} 个源文件`);

    // 2. 分析每个文件
    for (const file of sourceFiles) {
      await this.analyzeFile(file);
    }

    // 3. 分析函数调用关系
    this.analyzeFunctionCalls();

    // 4. 识别未使用的代码
    this.identifyUnusedCode();

    // 5. 检测死代码块
    this.detectDeadCodeBlocks();

    // 6. 生成清理建议
    this.generateCleanupRecommendations();

    console.log('✅ 分析完成！');
    return this.analysisResults;
  }

  /**
   * 扫描源文件
   */
  scanSourceFiles() {
    const extensions = ['.ts', '.js', '.tsx', '.jsx'];
    const sourceFiles = [];

    function scanDirectory(dir) {
      const items = fs.readdirSync(dir);

      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory() && !item.startsWith('.') && item !== 'node_modules') {
          scanDirectory(fullPath);
        } else if (stat.isFile() && extensions.some(ext => item.endsWith(ext))) {
          // 排除声明文件和测试文件（可选）
          if (!item.endsWith('.d.ts') && !item.includes('.test.') && !item.includes('.spec.')) {
            sourceFiles.push(fullPath);
          }
        }
      }
    }

    scanDirectory(this.projectRoot);
    return sourceFiles;
  }

  /**
   * 分析单个文件
   */
  async analyzeFile(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const relativePath = path.relative(this.projectRoot, filePath);

      // 提取函数定义
      this.extractFunctionDefinitions(content, relativePath);

      // 提取类定义
      this.extractClassDefinitions(content, relativePath);

      // 提取接口定义
      this.extractInterfaceDefinitions(content, relativePath);

      // 提取常量定义
      this.extractConstantDefinitions(content, relativePath);

      // 提取类型别名
      this.extractTypeAliases(content, relativePath);

      // 提取导入
      this.extractImports(content, relativePath);

      // 提取导出
      this.extractExports(content, relativePath);

      // 提取函数调用
      this.extractFunctionCalls(content, relativePath);

    } catch (error) {
      console.warn(`⚠️  分析文件失败: ${filePath}`, error.message);
    }
  }

  /**
   * 提取函数定义
   */
  extractFunctionDefinitions(content, filePath) {
    // 匹配各种函数定义模式
    const patterns = [
      // export function name() {}
      /export\s+(?:async\s+)?function\s+(\w+)\s*\(/g,
      // const name = function() {}
      /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function\s*\(/g,
      // const name = () => {}
      /(?:const|let|var)\s+(\w+)\s*=\s*(?:\([^)]*\)|[^=])\s*=>/g,
      // function name() {}
      /(?:async\s+)?function\s+(\w+)\s*\(/g,
      // class method: name() {}
      /(?:async\s+)?(\w+)\s*\([^)]*\)\s*[:{]/g,
      // export const name = ...
      /export\s+(?:const|let|var)\s+(\w+)\s*=/g
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const functionName = match[1];

        // 排除常见的保留字和特殊情况
        if (!this.isReservedWord(functionName) && !this.isTypeDefinition(functionName, content)) {
          this.functionDefinitions.set(functionName, {
            name: functionName,
            file: filePath,
            isExported: content.includes(`export ${functionName}`) ||
                       content.includes(`export function ${functionName}`) ||
                       content.includes(`export const ${functionName}`),
            isAsync: content.includes('async') && content.includes(functionName),
            line: this.getLineNumber(content, match.index)
          });
        }
      }
    }
  }

  /**
   * 提取类定义
   */
  extractClassDefinitions(content, filePath) {
    const classPattern = /(?:export\s+)?class\s+(\w+)/g;
    let match;

    while ((match = classPattern.exec(content)) !== null) {
      const className = match[1];
      this.classes.set(className, {
        name: className,
        file: filePath,
        isExported: content.includes(`export class ${className}`),
        line: this.getLineNumber(content, match.index)
      });
    }
  }

  /**
   * 提取接口定义
   */
  extractInterfaceDefinitions(content, filePath) {
    const interfacePattern = /(?:export\s+)?interface\s+(\w+)/g;
    let match;

    while ((match = interfacePattern.exec(content)) !== null) {
      const interfaceName = match[1];
      this.interfaces.set(interfaceName, {
        name: interfaceName,
        file: filePath,
        isExported: content.includes(`export interface ${interfaceName}`),
        line: this.getLineNumber(content, match.index)
      });
    }
  }

  /**
   * 提取常量定义
   */
  extractConstantDefinitions(content, filePath) {
    const constPattern = /(?:export\s+)?(?:const|let|var)\s+([A-Z_][A-Z0-9_]*)\s*=/g;
    let match;

    while ((match = constPattern.exec(content)) !== null) {
      const constName = match[1];
      this.constants.set(constName, {
        name: constName,
        file: filePath,
        isExported: content.includes(`export const ${constName}`),
        line: this.getLineNumber(content, match.index)
      });
    }
  }

  /**
   * 提取类型别名
   */
  extractTypeAliases(content, filePath) {
    const typePattern = /(?:export\s+)?type\s+(\w+)/g;
    let match;

    while ((match = typePattern.exec(content)) !== null) {
      const typeName = match[1];
      this.typeAliases.set(typeName, {
        name: typeName,
        file: filePath,
        isExported: content.includes(`export type ${typeName}`),
        line: this.getLineNumber(content, match.index)
      });
    }
  }

  /**
   * 提取导入
   */
  extractImports(content, filePath) {
    const importPatterns = [
      // import { name1, name2 } from 'module'
      /import\s*{([^}]+)}\s*from\s*['"]([^'"]+)['"]/g,
      // import name from 'module'
      /import\s+(\w+)\s*from\s*['"]([^'"]+)['"]/g,
      // import * as name from 'module'
      /import\s*\*\s*as\s+(\w+)\s*from\s*['"]([^'"]+)['"]/g
    ];

    for (const pattern of importPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        if (match[1]) {
          const imports = match[1].split(',').map(s => s.trim().split(' as ')[0]);
          const module = match[2];

          imports.forEach(imp => {
            if (imp && imp !== '') {
              if (!this.imports.has(filePath)) {
                this.imports.set(filePath, []);
              }
              this.imports.get(filePath).push({
                name: imp,
                module: module,
                line: this.getLineNumber(content, match.index)
              });
            }
          });
        }
      }
    }
  }

  /**
   * 提取导出
   */
  extractExports(content, filePath) {
    // 简化的导出提取
    const exportPatterns = [
      /export\s+(?:async\s+)?function\s+(\w+)/g,
      /export\s+(?:const|let|var)\s+(\w+)/g,
      /export\s+class\s+(\w+)/g,
      /export\s+interface\s+(\w+)/g,
      /export\s+type\s+(\w+)/g
    ];

    for (const pattern of exportPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const exportName = match[1];
        if (!this.exports.has(filePath)) {
          this.exports.set(filePath, []);
        }
        this.exports.get(filePath).push({
          name: exportName,
          line: this.getLineNumber(content, match.index)
        });
      }
    }
  }

  /**
   * 提取函数调用
   */
  extractFunctionCalls(content, filePath) {
    // 匹配函数调用模式
    const callPattern = /(?:\w+\.)?(\w+)\s*\(/g;
    let match;

    while ((match = callPattern.exec(content)) !== null) {
      const functionName = match[1];

      // 排除常见的语言结构和保留字
      if (!this.isReservedWord(functionName) && !this.isTypeDeclaration(functionName, content, match.index)) {
        if (!this.functionCalls.has(functionName)) {
          this.functionCalls.set(functionName, []);
        }
        this.functionCalls.get(functionName).push({
          file: filePath,
          line: this.getLineNumber(content, match.index),
          context: this.getContext(content, match.index)
        });
      }
    }
  }

  /**
   * 分析函数调用关系
   */
  analyzeFunctionCalls() {
    console.log('📊 分析函数调用关系...');

    for (const [functionName, definition] of this.functionDefinitions) {
      const calls = this.functionCalls.get(functionName) || [];
      definition.isCalled = calls.length > 0;
      definition.callCount = calls.length;
      definition.callSites = calls;

      if (definition.isExported && calls.length === 0) {
        this.unusedFunctions.push(definition);
      }
    }
  }

  /**
   * 识别未使用的代码
   */
  identifyUnusedCode() {
    console.log('🗑️  识别未使用的代码...');

    // 未使用的函数
    this.analysisResults.unusedFunctions = this.unusedFunctions.map(func => ({
      ...func,
      riskLevel: this.assessRiskLevel(func),
      recommendation: this.getRecommendation(func)
    }));

    // 未使用的常量
    for (const [constName, constDef] of this.constants) {
      const calls = this.functionCalls.get(constName) || [];
      if (constDef.isExported && calls.length === 0) {
        this.analysisResults.unusedConstants.push({
          ...constDef,
          riskLevel: this.assessRiskLevel(constDef),
          recommendation: this.getRecommendation(constDef)
        });
      }
    }

    // 未使用的类型
    for (const [typeName, typeDef] of this.typeAliases) {
      const calls = this.functionCalls.get(typeName) || [];
      if (typeDef.isExported && calls.length === 0) {
        this.analysisResults.unusedTypes.push({
          ...typeDef,
          riskLevel: this.assessRiskLevel(typeDef),
          recommendation: this.getRecommendation(typeDef)
        });
      }
    }
  }

  /**
   * 检测死代码块
   */
  detectDeadCodeBlocks() {
    console.log('💀 检测死代码块...');

    const sourceFiles = this.scanSourceFiles();

    for (const file of sourceFiles) {
      try {
        const content = fs.readFileSync(file, 'utf-8');
        const relativePath = path.relative(this.projectRoot, file);

        // 检测未执行的条件分支
        this.detectUnreachableCode(content, relativePath);

        // 检测未使用的导入
        this.detectUnusedImports(content, relativePath);

      } catch (error) {
        console.warn(`⚠️  检测死代码失败: ${file}`, error.message);
      }
    }
  }

  /**
   * 检测不可达代码
   */
  detectUnreachableCode(content, filePath) {
    // 简化的死代码检测
    const patterns = [
      // return/throw后的代码
      /(?:return|throw)[^;]*;[\s\S]*?(\w+\s*\([^)]*\)\s*[{;])/g,
      // 永false条件
      /if\s*\(\s*false\s*\)[^{]*{([^}]+)}/g,
      // 永true条件里的else
      /if\s*\(\s*true\s*\)[^{]*{[^}]*}\s*else\s*{([^}]+)}/g
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        this.deadCodeBlocks.push({
          file: filePath,
          line: this.getLineNumber(content, match.index),
          type: 'unreachable',
          snippet: match[0].substring(0, 100) + '...',
          riskLevel: 'low'
        });
      }
    }
  }

  /**
   * 检测未使用的导入
   */
  detectUnusedImports(content, filePath) {
    const fileImports = this.imports.get(filePath) || [];

    for (const imp of fileImports) {
      const usagePattern = new RegExp(`\\b${imp.name}\\b`, 'g');
      const usageCount = (content.match(usagePattern) || []).length;

      // 减去导入语句本身的使用
      if (usageCount <= 1) {
        this.unusedImports.push({
          ...imp,
          file: filePath,
          riskLevel: 'low',
          recommendation: '可以安全移除此导入'
        });
      }
    }
  }

  /**
   * 生成清理建议
   */
  generateCleanupRecommendations() {
    console.log('📋 生成清理建议...');

    this.analysisResults.summary = {
      totalFunctions: this.functionDefinitions.size,
      unusedFunctions: this.unusedFunctions.length,
      totalConstants: this.constants.size,
      unusedConstants: this.analysisResults.unusedConstants.length,
      totalTypes: this.typeAliases.size,
      unusedTypes: this.analysisResults.unusedTypes.length,
      deadCodeBlocks: this.deadCodeBlocks.length,
      unusedImports: this.unusedImports.length
    };

    // 按风险级别分类
    const riskCategories = {
      low: [],
      medium: [],
      high: []
    };

    [...this.analysisResults.unusedFunctions,
     ...this.analysisResults.unusedConstants,
     ...this.analysisResults.unusedTypes].forEach(item => {
      riskCategories[item.riskLevel].push(item);
    });

    this.analysisResults.riskAssessment = riskCategories;
    this.analysisResults.cleanupPlan = this.generateCleanupPlan();
  }

  /**
   * 生成清理计划
   */
  generateCleanupPlan() {
    return {
      phase1: {
        name: '低风险清理（立即执行）',
        items: [
          '移除明显的未使用导入',
          '删除未使用的常量（全大写命名）',
          '清理死代码块（return/throw后的代码）',
          '移除未使用的工具函数（私有函数）'
        ],
        estimatedFiles: this.unusedImports.length + this.deadCodeBlocks.length
      },
      phase2: {
        name: '中风险清理（需要测试）',
        items: [
          '移除未使用的导出函数',
          '删除未使用的类型别名',
          '清理未使用的接口定义',
          '移除未使用的类定义'
        ],
        estimatedFiles: this.analysisResults.unusedFunctions.length +
                       this.analysisResults.unusedTypes.length
      },
      phase3: {
        name: '高风险清理（需要全面测试）',
        items: [
          '重构复杂的未使用函数',
          '清理可能有副作用的代码',
          '移除动态调用的函数',
          '处理反射和元编程相关代码'
        ],
        estimatedFiles: '需要人工评估'
      }
    };
  }

  /**
   * 辅助方法
   */
  isReservedWord(word) {
    const reserved = ['if', 'else', 'for', 'while', 'switch', 'case', 'default', 'return', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'new', 'typeof', 'instanceof', 'in', 'void', 'delete', 'class', 'extends', 'super', 'import', 'export', 'from', 'as', 'async', 'await', 'yield', 'const', 'let', 'var', 'function', 'this', 'true', 'false', 'null', 'undefined'];
    return reserved.includes(word);
  }

  isTypeDefinition(word, content) {
    // 简单的类型定义检测
    const before = content.substring(0, content.indexOf(word)).trim();
    return before.endsWith('interface ') || before.endsWith('type ') || before.endsWith('class ');
  }

  isTypeDeclaration(word, content, index) {
    const before = content.substring(Math.max(0, index - 100), index);
    return before.includes('interface ') || before.includes('type ') || before.includes('extends ') || before.includes('implements ');
  }

  getLineNumber(content, index) {
    return content.substring(0, index).split('\n').length;
  }

  getContext(content, index, length = 50) {
    const start = Math.max(0, index - length);
    const end = Math.min(content.length, index + length);
    return content.substring(start, end).replace(/\s+/g, ' ');
  }

  assessRiskLevel(item) {
    // 根据文件路径、命名模式等评估风险
    const { file, name } = item;

    if (file.includes('test') || file.includes('spec')) {
      return 'low';
    }

    if (name.startsWith('_') || name.includes('temp') || name.includes('deprecated')) {
      return 'low';
    }

    if (file.includes('index') && name === 'main' || name === 'init') {
      return 'high';
    }

    if (name.includes('util') || name.includes('helper')) {
      return 'medium';
    }

    return 'medium';
  }

  getRecommendation(item) {
    const { riskLevel, name, file } = item;

    switch (riskLevel) {
      case 'low':
        return `可以安全移除 ${name}，此函数/常量未被使用`;
      case 'medium':
        return `建议在测试后移除 ${name}，可能存在动态调用`;
      case 'high':
        return `谨慎处理 ${name}，可能有反射或动态调用，需要深入分析`;
      default:
        return '需要人工评估';
    }
  }

  /**
   * 生成详细报告
   */
  generateReport() {
    const report = {
      timestamp: new Date().toISOString(),
      project: this.projectRoot,
      ...this.analysisResults
    };

    return report;
  }
}

// 主程序
async function main() {
  const projectRoot = process.argv[2] || process.cwd();
  const analyzer = new DeadCodeAnalyzer(projectRoot);

  try {
    const results = await analyzer.analyzeProject();
    const report = analyzer.generateReport();

    // 输出报告
    const reportPath = path.join(projectRoot, 'dead-code-analysis-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

    console.log('\n📊 分析摘要:');
    console.log(`================`);
    console.log(`总函数数: ${results.summary.totalFunctions}`);
    console.log(`未使用函数: ${results.summary.unusedFunctions}`);
    console.log(`总常量数: ${results.summary.totalConstants}`);
    console.log(`未使用常量: ${results.summary.unusedConstants}`);
    console.log(`总类型数: ${results.summary.totalTypes}`);
    console.log(`未使用类型: ${results.summary.unusedTypes}`);
    console.log(`死代码块: ${results.summary.deadCodeBlocks}`);
    console.log(`未使用导入: ${results.summary.unusedImports}`);

    console.log('\n🚨 高风险项目:');
    console.log('===============');
    const highRiskItems = results.riskAssessment.high.slice(0, 5);
    highRiskItems.forEach(item => {
      console.log(`⚠️  ${item.file}:${item.line} - ${item.name} (${item.riskLevel})`);
    });

    console.log(`\n📄 详细报告已保存到: ${reportPath}`);

  } catch (error) {
    console.error('❌ 分析失败:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = DeadCodeAnalyzer;