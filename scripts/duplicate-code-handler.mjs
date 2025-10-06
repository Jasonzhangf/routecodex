#!/usr/bin/env node

/**
 * 重复代码自动化处理脚本
 * 
 * 功能：
 * 1. 检测重复代码
 * 2. 生成重构建议
 * 3. 自动提取公共函数/类
 * 4. 更新引用
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

class DuplicateCodeHandler {
  constructor(options = {}) {
    this.options = {
      threshold: options.threshold || 5,
      minLines: options.minLines || 5,
      minTokens: options.minTokens || 50,
      outputDir: options.outputDir || path.join(projectRoot, 'reports'),
      autoFix: options.autoFix || false,
      ...options
    };
    
    this.duplicates = [];
    this.refactoringSuggestions = [];
  }

  /**
   * 运行重复代码检测
   */
  async detectDuplicates() {
    console.log('🔍 检测重复代码...');
    
    try {
      const reportPath = path.join(this.options.outputDir, 'jscpd-report.json');
      if (!fs.existsSync(this.options.outputDir)) {
        fs.mkdirSync(this.options.outputDir, { recursive: true });
      }
      
      // 运行jscpd检测
      const cmd = `npx jscpd "{src/**,scripts/**}" --threshold ${this.options.threshold} --min-lines ${this.options.minLines} --min-tokens ${this.options.minTokens} --reporters json --output ${this.options.outputDir} --gitignore`;
      execSync(cmd, { cwd: projectRoot, stdio: 'pipe' });
      
      // 读取报告
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      this.duplicates = report.duplicates || [];
      
      console.log(`✅ 检测完成，发现 ${this.duplicates.length} 处重复代码`);
      return this.duplicates;
      
    } catch (error) {
      console.error('❌ 重复代码检测失败:', error.message);
      return [];
    }
  }

  /**
   * 分析重复代码模式
   */
  analyzePatterns() {
    console.log('📊 分析重复代码模式...');
    
    const patterns = new Map();
    
    for (const duplicate of this.duplicates) {
      const pattern = this.extractPattern(duplicate);
      const key = pattern.signature;
      
      if (!patterns.has(key)) {
        patterns.set(key, {
          pattern,
          occurrences: [],
          totalLines: 0,
          totalTokens: 0
        });
      }
      
      const group = patterns.get(key);
      group.occurrences.push(duplicate);
      group.totalLines += duplicate.lines;
      group.totalTokens += duplicate.tokens;
    }
    
    // 按影响程度排序
    const sortedPatterns = Array.from(patterns.values())
      .sort((a, b) => (b.totalLines * b.occurrences.length) - (a.totalLines * a.occurrences.length));
    
    console.log(`✅ 分析完成，识别 ${sortedPatterns.length} 种重复模式`);
    return sortedPatterns;
  }

  /**
   * 提取代码模式特征
   */
  extractPattern(duplicate) {
    const firstFile = duplicate.files[0];
    const content = this.readFileContent(firstFile.path, firstFile.start, firstFile.end);
    
    return {
      signature: this.generateSignature(content),
      type: this.detectCodeType(content),
      complexity: this.estimateComplexity(content),
      refactorable: this.isRefactorable(content),
      content
    };
  }

  /**
   * 生成代码签名
   */
  generateSignature(content) {
    // 移除具体值，保留结构
    return content
      .replace(/\b\d+\b/g, 'NUM')
      .replace(/"[^"]*"/g, 'STRING')
      .replace(/'[^']*'/g, 'STRING')
      .replace(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g, 'IDENT')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * 检测代码类型
   */
  detectCodeType(content) {
    if (content.includes('function ') || content.includes('=>')) return 'function';
    if (content.includes('class ')) return 'class';
    if (content.includes('if ') || content.includes('for ') || content.includes('while ')) return 'logic';
    if (content.includes('return ')) return 'return';
    if (content.includes('const ') || content.includes('let ') || content.includes('var ')) return 'declaration';
    return 'generic';
  }

  /**
   * 估算复杂度
   */
  estimateComplexity(content) {
    const lines = content.split('\n').length;
    const branches = (content.match(/\b(if|else|for|while|switch|case)\b/g) || []).length;
    const functions = (content.match(/\b(function|=>)\b/g) || []).length;
    
    return {
      lines,
      branches,
      functions,
      score: lines + (branches * 2) + (functions * 3)
    };
  }

  /**
   * 判断是否可重构
   */
  isRefactorable(content) {
    // 简单的启发式规则
    const hasParameters = content.includes('(') && content.includes(')');
    const hasReturn = content.includes('return');
    const isTooLong = content.split('\n').length > 50;
    const hasTooManyVars = (content.match(/\b(const|let|var)\b/g) || []).length > 5;
    
    return hasParameters && hasReturn && !isTooLong && !hasTooManyVars;
  }

  /**
   * 生成重构建议
   */
  generateRefactoringSuggestions(patterns) {
    console.log('💡 生成重构建议...');
    
    this.refactoringSuggestions = [];
    
    for (const pattern of patterns) {
      if (pattern.occurrences.length >= 2 && pattern.pattern.refactorable) {
        const suggestion = this.createRefactoringSuggestion(pattern);
        if (suggestion) {
          this.refactoringSuggestions.push(suggestion);
        }
      }
    }
    
    console.log(`✅ 生成 ${this.refactoringSuggestions.length} 条重构建议`);
    return this.refactoringSuggestions;
  }

  /**
   * 创建单个重构建议
   */
  createRefactoringSuggestion(pattern) {
    const firstOccurrence = pattern.occurrences[0];
    const { pattern: codePattern } = pattern;
    
    // 确定重构策略
    const strategy = this.determineRefactoringStrategy(codePattern);
    
    return {
      id: `refactor_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      strategy,
      pattern: codePattern,
      occurrences: pattern.occurrences,
      impact: {
        filesAffected: pattern.occurrences.length,
        linesReduced: pattern.totalLines - (pattern.totalLines / pattern.occurrences.length),
        complexityReduction: pattern.pattern.complexity.score * (pattern.occurrences.length - 1)
      },
      suggestedCode: this.generateRefactoredCode(codePattern, strategy),
      targetFile: this.determineTargetFile(firstOccurrence),
      priority: this.calculatePriority(pattern)
    };
  }

  /**
   * 确定重构策略
   */
  determineRefactoringStrategy(pattern) {
    switch (pattern.type) {
      case 'function':
        return 'extract-function';
      case 'class':
        return 'extract-class';
      case 'logic':
        return 'extract-method';
      case 'return':
        return 'extract-utility';
      default:
        return 'extract-common';
    }
  }

  /**
   * 生成重构后的代码
   */
  generateRefactoredCode(pattern, strategy) {
    const content = pattern.content;
    
    switch (strategy) {
      case 'extract-function':
        return this.extractFunction(content);
      case 'extract-class':
        return this.extractClass(content);
      case 'extract-method':
        return this.extractMethod(content);
      case 'extract-utility':
        return this.extractUtility(content);
      default:
        return this.extractCommon(content);
    }
  }

  /**
   * 提取函数
   */
  extractFunction(content) {
    const lines = content.split('\n');
    const indentLevel = this.getIndentLevel(lines[0]);
    const params = this.extractParameters(content);
    
    return {
      name: this.generateFunctionName(content),
      parameters: params,
      body: this.normalizeIndentation(content, indentLevel),
      returnType: this.inferReturnType(content)
    };
  }

  /**
   * 提取类
   */
  extractClass(content) {
    return {
      name: this.generateClassName(content),
      methods: this.extractMethods(content),
      properties: this.extractProperties(content)
    };
  }

  /**
   * 提取方法
   */
  extractMethod(content) {
    return {
      name: this.generateMethodName(content),
      visibility: 'public',
      static: false,
      body: content
    };
  }

  /**
   * 提取工具函数
   */
  extractUtility(content) {
    return {
      name: this.generateUtilityName(content),
      pure: this.isPureFunction(content),
      sideEffects: this.hasSideEffects(content),
      body: content
    };
  }

  /**
   * 提取公共代码
   */
  extractCommon(content) {
    return {
      type: 'common',
      body: content,
      description: '通用代码片段'
    };
  }

  /**
   * 确定目标文件
   */
  determineTargetFile(occurrence) {
    const firstFile = occurrence.files[0].path;
    const dir = path.dirname(firstFile);
    
    // 寻找合适的工具文件目录
    if (dir.includes('provider')) {
      return path.join(dir, 'common-utils.ts');
    } else if (dir.includes('utils')) {
      return path.join(dir, 'common-functions.ts');
    } else {
      return path.join(dir, 'shared.ts');
    }
  }

  /**
   * 计算优先级
   */
  calculatePriority(pattern) {
    const impact = pattern.occurrences.length * pattern.pattern.complexity.score;
    if (impact > 100) return 'high';
    if (impact > 50) return 'medium';
    return 'low';
  }

  /**
   * 应用重构
   */
  async applyRefactoring() {
    if (!this.options.autoFix) {
      console.log('⚠️  自动修复未启用，仅生成建议');
      return;
    }

    console.log('🔧 应用重构...');
    
    let appliedCount = 0;
    
    for (const suggestion of this.refactoringSuggestions) {
      try {
        const success = await this.applySingleRefactoring(suggestion);
        if (success) {
          appliedCount++;
          console.log(`✅ 应用重构: ${suggestion.id}`);
        }
      } catch (error) {
        console.error(`❌ 重构失败 ${suggestion.id}:`, error.message);
      }
    }
    
    console.log(`🎉 重构完成，成功应用 ${appliedCount}/${this.refactoringSuggestions.length} 项`);
  }

  /**
   * 应用单个重构
   */
  async applySingleRefactoring(suggestion) {
    const { targetFile, suggestedCode, occurrences } = suggestion;
    
    // 创建目标文件（如果不存在）
    await this.ensureFileExists(targetFile);
    
    // 添加公共代码到目标文件
    await this.addCodeToFile(targetFile, suggestedCode);
    
    // 更新原始文件中的引用
    for (const occurrence of occurrences) {
      await this.replaceCodeInFile(occurrence, suggestion);
    }
    
    return true;
  }

  /**
   * 生成报告
   */
  generateReport() {
    const report = {
      timestamp: new Date().toISOString(),
      summary: {
        totalDuplicates: this.duplicates.length,
        totalSuggestions: this.refactoringSuggestions.length,
        highPrioritySuggestions: this.refactoringSuggestions.filter(s => s.priority === 'high').length,
        mediumPrioritySuggestions: this.refactoringSuggestions.filter(s => s.priority === 'medium').length,
        lowPrioritySuggestions: this.refactoringSuggestions.filter(s => s.priority === 'low').length
      },
      duplicates: this.duplicates,
      suggestions: this.refactoringSuggestions,
      patterns: this.analyzePatterns()
    };
    
    const reportPath = path.join(this.options.outputDir, `duplicate-code-report-${Date.now()}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    
    console.log(`📄 报告已生成: ${reportPath}`);
    return reportPath;
  }

  // 辅助方法
  readFileContent(filePath, startLine, endLine) {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    return lines.slice(startLine - 1, endLine).join('\n');
  }

  getIndentLevel(line) {
    return line.match(/^(\s*)/)[1].length;
  }

  normalizeIndentation(content, baseIndent) {
    const lines = content.split('\n');
    return lines.map(line => {
      const currentIndent = this.getIndentLevel(line);
      const newIndent = Math.max(0, currentIndent - baseIndent);
      return ' '.repeat(newIndent) + line.trim();
    }).join('\n');
  }

  extractParameters(content) {
    const match = content.match(/\(([^)]*)\)/);
    if (!match) return [];
    
    return match[1].split(',').map(p => p.trim()).filter(p => p);
  }

  generateFunctionName(content) {
    if (content.includes('fetch')) return 'fetchData';
    if (content.includes('transform')) return 'transformData';
    if (content.includes('validate')) return 'validateData';
    if (content.includes('process')) return 'processData';
    return 'extractedFunction';
  }

  generateClassName(content) {
    if (content.includes('Provider')) return 'BaseProvider';
    if (content.includes('Handler')) return 'BaseHandler';
    if (content.includes('Service')) return 'BaseService';
    return 'CommonClass';
  }

  generateMethodName(content) {
    if (content.includes('handle')) return 'handleCommon';
    if (content.includes('process')) return 'processCommon';
    if (content.includes('execute')) return 'executeCommon';
    return 'commonMethod';
  }

  generateUtilityName(content) {
    if (content.includes('format')) return 'formatUtil';
    if (content.includes('parse')) return 'parseUtil';
    if (content.includes('convert')) return 'convertUtil';
    return 'commonUtil';
  }

  inferReturnType(content) {
    if (content.includes('return string') || content.includes('return \'')) return 'string';
    if (content.includes('return number') || /\breturn\s+\d+/.test(content)) return 'number';
    if (content.includes('return boolean') || /\breturn\s+(true|false)\b/.test(content)) return 'boolean';
    if (content.includes('return []') || content.includes('return new Array')) return 'array';
    if (content.includes('return {}') || content.includes('return new Object')) return 'object';
    return 'any';
  }

  extractMethods(content) {
    // 简化实现
    return [];
  }

  extractProperties(content) {
    // 简化实现
    return [];
  }

  isPureFunction(content) {
    return !content.includes('console.') && !content.includes('fs.') && !content.includes('process.');
  }

  hasSideEffects(content) {
    return content.includes('console.') || content.includes('fs.') || content.includes('process.');
  }

  async ensureFileExists(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, '// Auto-generated common utilities\n\n');
    }
  }

  async addCodeToFile(filePath, code) {
    const content = fs.readFileSync(filePath, 'utf8');
    const newContent = content + this.formatCode(code) + '\n\n';
    fs.writeFileSync(filePath, newContent);
  }

  async replaceCodeInFile(occurrence, suggestion) {
    const filePath = occurrence.files[0].path;
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    
    // 替换重复代码为函数调用
    const start = occurrence.files[0].start - 1;
    const end = occurrence.files[0].end - 1;
    
    const functionCall = this.generateFunctionCall(suggestion);
    lines.splice(start, end - start + 1, functionCall);
    
    fs.writeFileSync(filePath, lines.join('\n'));
  }

  formatCode(code) {
    // 简化的代码格式化
    if (typeof code === 'object' && code.name) {
      return `
export function ${code.name}(${code.parameters ? code.parameters.join(', ') : ''})${
        code.returnType ? `: ${code.returnType}` : ''
      } {
${code.body}
}`;
    }
    return `\n${code}`;
  }

  generateFunctionCall(suggestion) {
    const { suggestedCode } = suggestion;
    if (suggestedCode.name) {
      return `  return ${suggestedCode.name}();`;
    }
    return '  // TODO: Replace with function call';
  }

  /**
   * 运行完整流程
   */
  async run() {
    console.log('🚀 开始重复代码自动化处理...\n');
    
    // 1. 检测重复代码
    await this.detectDuplicates();
    
    if (this.duplicates.length === 0) {
      console.log('✨ 未发现重复代码，代码质量良好！');
      return;
    }
    
    // 2. 分析模式
    const patterns = this.analyzePatterns();
    
    // 3. 生成建议
    await this.generateRefactoringSuggestions(patterns);
    
    // 4. 应用重构（如果启用）
    await this.applyRefactoring();
    
    // 5. 生成报告
    const reportPath = this.generateReport();
    
    console.log('\n🎉 重复代码处理完成！');
    console.log(`📊 统计: ${this.duplicates.length} 处重复，${this.refactoringSuggestions.length} 条建议`);
    console.log(`📄 详细报告: ${reportPath}`);
  }
}

// CLI接口
async function main() {
  const args = process.argv.slice(2);
  const options = {};
  
  // 解析命令行参数
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '');
    const value = args[i + 1];
    
    switch (key) {
      case 'threshold':
        options.threshold = parseInt(value);
        break;
      case 'auto-fix':
        options.autoFix = value === 'true';
        break;
      case 'output':
        options.outputDir = value;
        break;
    }
  }
  
  const handler = new DuplicateCodeHandler(options);
  await handler.run();
}

// 如果直接运行此脚本
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { DuplicateCodeHandler };
