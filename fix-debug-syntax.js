#!/usr/bin/env node

/**
 * RouteCodex Debug System Syntax Error Fixer
 *
 * This script systematically fixes TypeScript compilation errors
 * in the debug system using automated refactoring.
 */

const fs = require('fs');
const path = require('path');

class DebugSystemRefactorer {
  constructor() {
    this.projectRoot = process.cwd();
    this.fixesApplied = 0;
    this.errorsFixed = [];
  }

  log(message) {
    console.log(`[Refactorer] ${message}`);
  }

  readFile(filePath) {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      this.log(`Error reading ${filePath}: ${error.message}`);
      return null;
    }
  }

  writeFile(filePath, content) {
    try {
      fs.writeFileSync(filePath, content, 'utf8');
      this.fixesApplied++;
      this.log(`Fixed: ${filePath}`);
      return true;
    } catch (error) {
      this.log(`Error writing ${filePath}: ${error.message}`);
      return false;
    }
  }

  // 修复重复属性错误
  fixDuplicateProperties() {
    const filePath = path.join(this.projectRoot, 'src/debug/module-debug-adapter.ts');
    const content = this.readFile(filePath);
    if (!content) return;

    // 移除重复的属性定义
    const fixedContent = content.replace(
      /(\s+)(moduleInfo|methodHooks|state|events|errors):.*,\n(\s+)\/\/ ModuleDebugData requires direct properties\n(\s+)\1,\2(\s+)\3,\4(\s+)\5,\6(\s+)\7,/g,
      '$1moduleInfo: this.moduleInfo,\n$2methodHooks: allHookData,\n$3state,\n$4events,\n$5errors,'
    );

    if (fixedContent !== content) {
      this.writeFile(filePath, fixedContent);
      this.errorsFixed.push('Removed duplicate properties in module-debug-adapter.ts');
    }
  }

  // 修复DebugAPIResponse缺少必要属性
  fixDebugAPIResponse() {
    const filePath = path.join(this.projectRoot, 'src/debug/debug-api-extension.ts');
    const content = this.readFile(filePath);
    if (!content) return;

    // 添加缺少的processingTime和timestamp属性
    const fixedContent = content.replace(
      /return {\s+requestId: request\.id,\s+status: 400,\s+headers: \{ 'content-type': 'application\/json' \},\s+body: \{ error: 'Adapter ID is required' \}\s+};/g,
      `return {
        requestId: request.id,
        status: 400,
        headers: { 'content-type': 'application/json' },
        body: { error: 'Adapter ID is required' },
        processingTime: Date.now() - request.timestamp,
        timestamp: Date.now()
      };`
    );

    if (fixedContent !== content) {
      this.writeFile(filePath, fixedContent);
      this.errorsFixed.push('Added missing properties to DebugAPIResponse');
    }
  }

  // 修复DebugUtils静态方法调用
  fixDebugUtilsStaticCalls() {
    const filePath = path.join(this.projectRoot, 'src/debug/websocket-debug-server.ts');
    const content = this.readFile(filePath);
    if (!content) return;

    // 将实例方法调用改为静态方法调用
    const fixedContent = content.replace(
      /this\.debugUtils\.generateId/g,
      'DebugUtilsStatic.generateId'
    );

    if (fixedContent !== content) {
      this.writeFile(filePath, fixedContent);
      this.errorsFixed.push('Fixed DebugUtils static method calls in websocket-debug-server.ts');
    }
  }

  // 修复WebSocket消息类型
  fixWebSocketMessageTypes() {
    const filePath = path.join(this.projectRoot, 'src/debug/websocket-debug-server.ts');
    const content = this.readFile(filePath);
    if (!content) return;

    // 更新消息类型以匹配枚举
    const typeReplacements = {
      '"subscription"': '"event"',
      '"system"': '"event"',
      '"error"': '"event"'
    };

    let fixedContent = content;
    for (const [oldType, newType] of Object.entries(typeReplacements)) {
      fixedContent = fixedContent.replace(new RegExp(oldType, 'g'), newType);
    }

    if (fixedContent !== content) {
      this.writeFile(filePath, fixedContent);
      this.errorsFixed.push('Fixed WebSocket message types');
    }
  }

  // 修复MethodHookData接口
  fixMethodHookDataInterface() {
    const filePath = path.join(this.projectRoot, 'src/types/debug-types.ts');
    const content = this.readFile(filePath);
    if (!content) return;

    // 添加metadata属性到MethodHookData接口
    const interfaceMatch = content.match(/export interface MethodHookData \{[^}]*\}/);
    if (interfaceMatch) {
      const updatedInterface = interfaceMatch[0].replace(
        /(\s+})/,
        '\n  /** Hook metadata */\n  metadata?: Record<string, any>;\n}'
      );

      const fixedContent = content.replace(interfaceMatch[0], updatedInterface);
      this.writeFile(filePath, fixedContent);
      this.errorsFixed.push('Added metadata property to MethodHookData interface');
    }
  }

  // 修复await语法错误
  fixAwaitSyntaxErrors() {
    const filePath = path.join(this.projectRoot, 'src/debug/websocket-debug-server.ts');
    const content = this.readFile(filePath);
    if (!content) return;

    // 移除不正确的await使用
    const fixedContent = content.replace(
      /await new Promise\(resolve => setTimeout\(resolve, 0\)\);/g,
      'new Promise(resolve => setTimeout(resolve, 0));'
    );

    if (fixedContent !== content) {
      this.writeFile(filePath, fixedContent);
      this.errorsFixed.push('Fixed await syntax errors');
    }
  }

  // 修复模块导入路径
  fixModuleImports() {
    const filePath = path.join(this.projectRoot, 'src/modules/pipeline/core/base-pipeline.ts');
    const content = this.readFile(filePath);
    if (!content) return;

    // 修复导入路径
    const fixedContent = content.replace(
      /import \{ ModuleEnhancementFactory, EnhancementRegistry \} from '\.\.\/\.\.\/modules\/enhancement\/module-enhancement-factory\.js';/,
      "import { ModuleEnhancementFactory } from '../../modules/enhancement/module-enhancement-factory.js';"
    );

    if (fixedContent !== content) {
      this.writeFile(filePath, fixedContent);
      this.errorsFixed.push('Fixed module import paths in base-pipeline.ts');
    }
  }

  // 修复DebugUtils类导出
  fixDebugUtilsExport() {
    const filePath = path.join(this.projectRoot, 'src/utils/debug-utils.ts');
    const content = this.readFile(filePath);
    if (!content) return;

    // 添加类导出
    if (!content.includes('export class DebugUtilsImpl')) {
      const fixedContent = content.replace(
        /class DebugUtilsImpl \{/,
        'export class DebugUtilsImpl {'
      );

      if (fixedContent !== content) {
        this.writeFile(filePath, fixedContent);
        this.errorsFixed.push('Fixed DebugUtils class export');
      }
    }
  }

  // 运行所有修复
  runAllFixes() {
    this.log('Starting systematic debug system syntax error fixes...');

    this.fixDuplicateProperties();
    this.fixDebugAPIResponse();
    this.fixDebugUtilsStaticCalls();
    this.fixWebSocketMessageTypes();
    this.fixMethodHookDataInterface();
    this.fixAwaitSyntaxErrors();
    this.fixModuleImports();
    this.fixDebugUtilsExport();

    this.log(`Completed: ${this.fixesApplied} fixes applied`);
    this.log('Errors fixed:');
    this.errorsFixed.forEach((error, index) => {
      this.log(`  ${index + 1}. ${error}`);
    });
  }
}

// 运行修复器
const refactorer = new DebugSystemRefactorer();
refactorer.runAllFixes();

console.log('\n=== Debug System Refactoring Complete ===');
console.log('Run "npm run build" to verify fixes');