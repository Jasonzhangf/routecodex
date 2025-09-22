# CLAUDE.md

This file provides comprehensive guidance to Claude Code when working with code in this repository.

## 🚨 系统核心规则

### ⚠️ 工作目录自动重置机制
**每一条命令的执行都会在项目的根目录，不论它现在上一条命令是在哪一个目录执行。现在这条命令的执行还是会回到当前的项目的主目录。这个是系统的设置。**

这意味着：
- 每次命令执行前，系统会自动`cd`到项目根目录
- 不需要手动切换目录，系统会自动处理
- 所有相对路径都是基于项目根目录的
- 跨目录操作需要使用绝对路径

### 📝 正确的操作方法：在目标目录创建脚本
**由于系统会在每次命令执行前自动重置到项目根目录，要在特定目录执行操作时，请在该目录下创建脚本文件。**

**推荐做法**：
```bash
# 要在 /path/to/target 目录执行操作，请在该目录创建脚本
echo '#!/bin/bash
# 在目标目录执行的操作
cd "$(dirname "$0")"
echo "当前目录: $(pwd)"
# 执行具体的操作...
' > /path/to/target/operation.sh
chmod +x /path/to/target/operation.sh
```

**避免的做法**：
- ❌ 不要在根目录创建操作其他目录的脚本
- ❌ 不要在当前目录创建操作其他目录的脚本
- ✅ **在目标目录下创建脚本**，这样不会混淆，且脚本可以正确引用本地文件

**示例**：
```bash
# 正确：在目标目录创建脚本
echo '#!/bin/bash
# 在当前目录（目标目录）执行操作
echo "在 $(pwd) 目录执行操作"
npm install
npm test
' > ./my-project/run-tests.sh
chmod +x ./my-project/run-tests.sh

# 然后执行该脚本
./my-project/run-tests.sh
```

## 🚨 关键规则

**所有未完成功能必须使用unimplemented-module系统显式声明，严禁使用mock占位符或TODO注释。** 完整规则请参考 `./src/modules/README.md` 文档。

## Project Overview

RouteCodex是一个多Provider OpenAI代理服务器，支持动态路由、负载均衡和兼容性处理。

## Key Directories and Files

- `src/` - 源代码目录
  - `server/` - HTTP服务器和路由处理
  - `core/` - 核心业务逻辑
  - `providers/` - Provider管理和实现
  - `config/` - 配置管理和类型定义
  - `utils/` - 工具函数
  - `patches/` - 兼容性补丁
- `config/` - 用户配置文件
- `tests/` - 测试文件
- `docs/` - 文档目录

## Global Development Philosophy

### Core Principles

- **Incremental progress over big bangs** - 小改动，确保每次构建和测试通过
- **Learning from existing code** - 实现前先学习和理解现有代码
- **Pragmatic over dogmatic** - 适应项目实际情况
- **Clear intent over clever code** - 代码要清晰易懂
- **API-based communication** - 模块间必须通过API通信，禁止直接调用

### Simplicity Means

- 单一职责原则
- 避免过早抽象
- 不要使用巧妙技巧，选择最简单的解决方案
- 如果需要解释说明，那就太复杂了
- 模块边界清晰，依赖关系简单

## Global Coding Standards

### Architecture Principles

- **Composition over inheritance** - 使用依赖注入
- **Interfaces over singletons** - 支持测试和灵活性
- **Explicit over implicit** - 清晰的数据流和依赖关系
- **Test-driven when possible** - 不要禁用测试，要修复它们

### Module Communication Rules

#### 🚨 强制API通信机制
**所有模块间通信必须通过API调用，禁止直接接口调用**

#### 通信架构要求
1. **MessageCenter Only**: 模块间通信仅通过RCC MessageCenter进行
2. **No Direct Imports**: 禁止直接导入其他模块的类或函数
3. **API Boundaries**: 每个模块必须定义明确的API边界
4. **Message Contracts**: 通信必须使用预定义的消息格式

#### 实现规范
```typescript
// ✅ 正确：通过MessageCenter通信
class ServerModule extends RoutecodexModule {
  async startHttpServer(): Promise<void> {
    const response = await this.messageCenter.sendMessage('config-manager', {
      action: 'get-config',
      module: 'server'
    });

    const config = response.content;
    // 使用配置启动服务器
  }
}

// ❌ 错误：直接导入其他模块
class ServerModule extends RoutecodexModule {
  async startHttpServer(): Promise<void> {
    const configManager = new ConfigManager();  // 禁止直接导入
    const config = await configManager.getConfig();  // 禁止直接调用
  }
}
```

#### 消息格式标准
```typescript
interface ModuleMessage {
  targetModule: string;           // 目标模块ID
  action: string;                 // 操作类型
  payload: any;                   // 请求数据
  metadata?: {
    requestId?: string;           // 请求ID
    timestamp?: number;           // 时间戳
    sourceModule?: string;        // 源模块ID
  };
}

interface ModuleResponse {
  success: boolean;               // 操作是否成功
  data?: any;                     // 响应数据
  error?: string;                 // 错误信息
  metadata?: {
    requestId?: string;           // 关联请求ID
    processingTime?: number;      // 处理时间
  };
}
```

#### 模块API设计
```typescript
class ConfigManagerModule extends RoutecodexModule {
  protected async registerMessageHandlers(): Promise<void> {
    this.messageCenter.registerHandler('config-manager', async (message) => {
      switch (message.action) {
        case 'get-config':
          return this.handleGetConfig(message);
        case 'set-config':
          return this.handleSetConfig(message);
        case 'reload-config':
          return this.handleReloadConfig(message);
        default:
          throw new Error(`Unknown action: ${message.action}`);
      }
    });
  }

  private async handleGetConfig(message: ModuleMessage): Promise<ModuleResponse> {
    try {
      const config = await this.configManager.loadConfig(message.payload.module);
      return {
        success: true,
        data: config,
        metadata: {
          requestId: message.metadata?.requestId,
          processingTime: Date.now() - (message.metadata?.timestamp || Date.now())
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        metadata: {
          requestId: message.metadata?.requestId
        }
      };
    }
  }
}
```

#### 通信流程图
```
┌─────────────────┐    Message      ┌─────────────────┐
│   ServerModule  │ ─────────────> │ ConfigManager   │
│                 │                │     Module      │
│                 │                │                 │
│                 │    Response    │                 │
│                 │ <──────────── │                 │
└─────────────────┘                └─────────────────┘
```

#### 模块注册和发现
```typescript
class ModuleRegistry {
  private modules: Map<string, RoutecodexModule> = new Map();

  registerModule(module: RoutecodexModule): void {
    this.modules.set(module.moduleId, module);
  }

  async sendMessage(targetModule: string, message: ModuleMessage): Promise<ModuleResponse> {
    const module = this.modules.get(targetModule);
    if (!module) {
      throw new Error(`Module not found: ${targetModule}`);
    }

    return await module.handleMessage(message);
  }
}
```

#### 错误处理和重试
```typescript
class ResilientMessageClient {
  async sendMessageWithRetry(
    targetModule: string,
    message: ModuleMessage,
    maxRetries: number = 3
  ): Promise<ModuleResponse> {
    let lastError: Error;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.messageCenter.sendMessage(targetModule, message);
        return response;
      } catch (error) {
        lastError = error;

        if (attempt < maxRetries) {
          await this.delay(1000 * attempt); // 指数退避
        }
      }
    }

    throw lastError;
  }
}
```

#### 性能监控和日志
```typescript
class MonitoringMessageCenter extends MessageCenter {
  async sendMessage(targetModule: string, message: ModuleMessage): Promise<ModuleResponse> {
    const startTime = Date.now();

    try {
      const response = await super.sendMessage(targetModule, message);

      await this.debugCenter.log('module-communication', {
        direction: 'outgoing',
        targetModule,
        action: message.action,
        success: true,
        processingTime: Date.now() - startTime,
        requestId: message.metadata?.requestId
      });

      return response;
    } catch (error) {
      await this.debugCenter.log('module-communication', {
        direction: 'outgoing',
        targetModule,
        action: message.action,
        success: false,
        error: error.message,
        processingTime: Date.now() - startTime,
        requestId: message.metadata?.requestId
      });

      throw error;
    }
  }
}
```

#### 模块生命周期管理
```typescript
class ModuleLifecycleManager {
  async startModule(module: RoutecodexModule): Promise<void> {
    await this.sendMessageWithRetry(module.moduleId, {
      action: 'start',
      payload: {},
      metadata: {
        timestamp: Date.now(),
        sourceModule: 'lifecycle-manager'
      }
    });
  }

  async stopModule(module: RoutecodexModule): Promise<void> {
    await this.sendMessageWithRetry(module.moduleId, {
      action: 'stop',
      payload: {},
      metadata: {
        timestamp: Date.now(),
        sourceModule: 'lifecycle-manager'
      }
    });
  }
}
```

### Code Quality Standards

- **Every commit must**:
  - 编译成功
  - 通过所有测试
  - 包含新功能的测试
  - 遵循项目格式/代码检查规则

- **Before committing**:
  - 运行格式化工具/代码检查
  - 自我审查更改
  - 确保提交消息解释"为什么"

### Error Handling

- 快速失败并带有描述性消息
- 包含调试上下文
- 在适当的级别处理错误
- 不要静默吞咽异常

### UnderConstruction Module Usage

**CRITICAL**: 使用unimplemented-module系统替代所有mock占位符和TODO注释

#### 必须使用unimplemented-module的场景：
1. **未实现功能** - 业务逻辑尚未开发完成
2. **API未集成** - 第三方服务接口未对接  
3. **算法未优化** - 当前使用简单实现等待优化
4. **配置未确定** - 等待产品确认具体需求
5. **新功能开发** - 任何新开发的功能模块

#### 禁止使用的传统占位符：
- ❌ `// TODO: 实现此功能`
- ❌ `throw new Error('Not implemented')`
- ❌ 空的函数实现
- ❌ 返回硬编码的临时值
- ❌ `UnderConstruction` 模块（已废弃）

#### 标准使用模式：
```typescript
import { RCCUnimplementedModule } from './modules/unimplemented-module.js';
import { UnimplementedModuleFactory } from './modules/unimplemented-module-factory.js';

// 创建未实现模块实例
const unimplementedModule = new RCCUnimplementedModule({
  moduleId: 'user-authentication',
  moduleName: 'User Authentication Module',
  description: '用户登录认证功能',
  customMessage: '用户认证功能正在开发中，敬请期待'
});

class UserService {
  async authenticateUser(username: string, password: string): Promise<string> {
    // 使用标准化的未完成响应
    const response = await unimplementedModule.handleUnimplementedCall('authenticateUser', {
      callerId: 'UserService.authenticateUser',
      context: { username, timestamp: Date.now() }
    });

    console.log(`未实现功能被调用: ${response.error}`);
    return 'temp-token'; // 临时返回值，同时记录使用统计
  }
}

// 或者使用工厂模式进行集中管理
class ModuleRegistry {
  private factory = UnimplementedModuleFactory.getInstance();
  
  async getUnimplementedModule(moduleId: string) {
    return await this.factory.createModule({
      moduleId,
      moduleName: `${moduleId}-module`
    });
  }
}
```

#### 在Provider中的使用：
```typescript
import { UnimplementedProvider } from './providers/unimplemented-provider.js';
import { EnhancedProviderManager } from './core/enhanced-provider-manager.js';

// 自动为不支持的provider类型创建未完成实现
const manager = new EnhancedProviderManager(config, {
  enableUnimplementedProviders: true,
  autoCreateUnimplemented: true
});

// 系统会自动为不支持的provider类型创建UnimplementedProvider实例
```

#### 使用统计和优先级分析：
```typescript
import { UnimplementedModuleAnalytics } from './modules/unimplemented-module-analytics.js';

// 创建分析实例
const analytics = new UnimplementedModuleAnalytics(factory, {
  enabled: true,
  enableTrendAnalysis: true,
  enableCallerAnalysis: true
});

// 获取实现优先级建议
const recommendations = analytics.getImplementationRecommendations();
recommendations.forEach(rec => {
  console.log(`优先级 ${rec.priority}: ${rec.moduleId} - ${rec.reasoning}`);
});

// 导出使用统计报告
const report = analytics.exportAnalytics('report');
console.log(report);
```

#### 重要规则：
1. **必须使用标准化未完成模块** - 禁止使用任何其他形式的未完成占位符
2. **必须记录调用统计** - 所有未完成功能的调用都必须被记录和分析
3. **必须提供有意义的错误消息** - 不要简单的"未实现"，要说明原因和预期
4. **必须跟踪调用者信息** - 记录谁在什么时候调用了未完成功能
5. **必须定期审查使用统计** - 基于数据决定实现优先级

## 🚨 ESM构建要求（CRITICAL）

### 强制ESM规则
**本项目必须使用纯ESM模块系统，严格禁止使用CommonJS**

#### ESM配置要求
1. **TypeScript配置**:
   ```json
   {
     "compilerOptions": {
       "module": "ESNext",
       "moduleResolution": "bundler",
       "target": "ES2022",
       "esModuleInterop": true,
       "verbatimModuleSyntax": true
     }
   }
   ```

2. **Package.json配置**:
   ```json
   {
     "type": "module",
     "exports": {
       ".": {
         "import": "./dist/index.js",
         "types": "./dist/index.d.ts"
       }
     }
   }
   ```

3. **导入/导出语法**:
   - ✅ 使用 `import/export` 语法
   - ✅ 使用 `import()` 动态导入
   - ❌ 禁止 `require()` 语法
   - ❌ 禁止 `module.exports`

#### ESM兼容性要求
1. **Jest配置**:
   ```typescript
   // jest.config.ts
   export default {
     extensionsToTreatAsEsm: ['.ts'],
     transform: {
       '^.+\\.tsx?$': ['ts-jest', { useESM: true }]
     }
   }
   ```

2. **运行时环境**:
   ```bash
   NODE_OPTIONS="--experimental-vm-modules" jest
   node --input-type=module dist/index.js
   ```

3. **Docker配置**:
   ```dockerfile
   CMD ["node", "--input-type=module", "dist/index.js"]
   ```

#### 验证规则
- 每次构建必须验证ESM兼容性
- CI/CD必须包含ESM验证步骤
- 禁止任何CommonJS模块依赖

## 🚨 README维护规则（CRITICAL）

### 强制性README维护要求
**每个模块README必须保持最新状态，准确反映文件结构和功能**

#### README更新规则
1. **文件修改前必须查询README** - 修改任何文件前，必须先阅读对应模块的README
2. **文件修改后必须更新README** - 修改文件功能后，必须立即更新对应的README描述
3. **新增文件必须更新README** - 新增任何文件后，必须在对应模块README中添加描述
4. **删除文件必须更新README** - 删除文件后，必须从README中移除对应描述

#### README内容要求
每个模块README必须包含：
1. **模块功能概述** - 该模块的核心功能和作用
2. **文件清单** - 列出所有文件及其具体作用
3. **依赖关系** - 该模块依赖的其他模块
4. **使用示例** - 如何使用该模块的示例

#### README更新流程
```bash
# 修改文件前的操作
cat src/core/README.md
# 理解现有文件结构
# 然后进行修改

# 修改文件后的操作
# 立即更新对应的README
git add src/core/README.md
git commit -m "docs: 更新core模块README，反映最新文件结构"
```

#### README验证
- 每次提交必须验证README的准确性
- CI/CD必须包含README完整性检查
- 禁止README与实际代码不一致

## Global Naming Conventions

### General Principles

Based on the Project Naming Master methodology, all names should be:
- **Memorable and easy to pronounce** - 易记易发音
- **Positive and affirmative** - 积极正面
- **Clear in intent and purpose** - 意图明确
- **Consistent across the codebase** - 保持一致

### TypeScript/ESM Naming

#### Modules and Files
- Use lowercase with hyphens: `http-server.ts`, `config-manager.ts`
- Descriptive names that indicate functionality
- File extensions must be `.ts` for TypeScript

#### Classes
- Use PascalCase: `ProviderManager`, `ConfigManager`, `HttpServer`
- Noun-based names describing what the class represents
- Suffix with purpose when needed: `Manager`, `Handler`, `Processor`

#### Functions and Methods
- Use camelCase: `processRequest`, `manageSession`, `handleError`
- Verb-based names describing what the function does
- Prefer clear, descriptive names over short ones

#### Variables
- Use camelCase: `sessionId`, `authToken`, `browserInstance`
- Descriptive names that indicate content/purpose
- Boolean variables should be questions: `isAuthenticated`, `hasPermission`

#### Constants
- Use UPPER_SNAKE_CASE: `DEFAULT_TIMEOUT`, `MAX_RETRIES`, `API_BASE_URL`
- Group related constants in modules

### Configuration and Environment

#### Environment Variables
- Use UPPER_SNAKE_CASE: `DATABASE_URL`, `API_SECRET_KEY`, `LOG_LEVEL`
- Prefix with project/module: `ROUTECODEX_API_KEY`, `ROUTECODEX_TIMEOUT`

#### Configuration Files
- Use lowercase with dots: `.env`, `settings.json`, `routecodex.json`
- Descriptive suffixes indicating format/purpose

## Common Development Commands

### Development Setup
```bash
# Install dependencies
npm install

# Development mode with watch
npm run dev

# Build project
npm run build

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Code linting
npm run lint

# Fix linting issues
npm run lint:fix
```

### Testing Commands
```bash
# Run all tests with ESM support
NODE_OPTIONS="--experimental-vm-modules" npm test

# Run specific test file
NODE_OPTIONS="--experimental-vm-modules" npm test -- --testNamePattern="specific-test"

# Run tests with coverage
NODE_OPTIONS="--experimental-vm-modules" npm test -- --coverage
```

### Build Commands
```bash
# Build for production
npm run build

# Build with watch mode
npm run build:watch

# Clean build artifacts
npm run clean

# Verify ESM build
npm run build && node --input-type=module --eval="import('./dist/index.js')"
```

## Project Development Process

### 1. Planning & Staging

Break complex work into 3-5 stages. Document in `IMPLEMENTATION_PLAN.md`:

```markdown
## Stage N: [Name]
**Goal**: [Specific deliverable]
**Success Criteria**: [Testable outcomes]
**Tests**: [Specific test cases]
**Status**: [Not Started|In Progress|Complete]
```

### 2. Implementation Flow

1. **Understand** - Study existing patterns in codebase (READ MODULE README FIRST!)
2. **Test** - Write test first (red)
3. **Implement** - Minimal code to pass (green)
4. **Refactor** - Clean up with tests passing
5. **Update README** - Update documentation
6. **Commit** - With clear message linking to plan

### 3. Error Recovery Protocol

**CRITICAL**: Maximum 3 attempts per issue, then STOP.

1. **Document what failed**
2. **Research alternatives**
3. **Question fundamentals**
4. **Try different angle**

## Codebase Architecture

### Core Components

1. **Server Module** (`src/server/`)
   - RouteCodexServer类，继承自BaseModule
   - HTTP服务器实现和OpenAI API路由处理
   - 集成ErrorHandlingCenter和DebugEventBus
   - Express中间件和错误处理

2. **CLI Interface** (`src/cli.js`)
   - Common.js风格的命令行界面
   - 服务器启动、配置管理、状态检查
   - 使用commander.js构建

3. **RCC Integration**
   - **BaseModule**: 提供模块化基础架构
   - **ErrorHandlingCenter**: 统一错误处理
   - **DebugEventBus**: 事件驱动的调试系统

4. **Configuration** (`config/`)
   - 系统配置文件（本地）
   - 用户配置文件（~/.routecodex/）
   - JSON格式的配置管理

### ESM Build Pipeline

```
Source (.ts) → TypeScript → ESM (.js) → Distribution
    ↓
Type Checking → ESM Validation → Testing → CI/CD
```

## Quality Gates

### Definition of Done

- [ ] Tests written and passing (ESM compatible)
- [ ] Code follows project conventions (ESM imports)
- [ ] No linter/formatter warnings
- [ ] README documentation updated
- [ ] ESM compatibility verified
- [ ] Module communication follows API-only rules
- [ ] No direct module imports or interface calls
- [ ] All inter-module communication uses MessageCenter
- [ ] Commit messages are clear
- [ ] Implementation matches plan
- [ ] No TODOs without issue numbers

### Module Communication Validation

- [ ] No `import` statements between modules
- [ ] All module interactions go through `messageCenter.sendMessage()`
- [ ] Message contracts are properly defined
- [ ] Module boundaries are respected
- [ ] No circular dependencies between modules

### Decision Framework

When multiple valid approaches exist, choose based on:

1. **Testability** - Can I easily test this with ESM?
2. **Readability** - Will someone understand this in 6 months?
3. **Consistency** - Does this match project patterns?
4. **Simplicity** - Is this the simplest solution that works?
5. **Reversibility** - How hard to change later?

## 🚨 ESM构建验证协议

### 强制ESM验证命令
**PURPOSE**: 这是唯一接受的ESM构建验证方式，所有系统都必须通过此测试。

**CRITICAL VALIDATION COMMAND**:
```bash
npm run build && node --input-type=module --eval="import('./dist/index.js').then(m => console.log('ESM build successful')).catch(e => { console.error('ESM build failed:', e); process.exit(1); })"
```

**REQUIREMENTS**:
1. **必须通过ESM构建验证** - 每次构建必须成功
2. **禁止CommonJS语法** - 任何文件都不能使用require/module.exports
3. **必须支持动态导入** - 所有模块都必须支持import()语法
4. **必须通过CI/CD验证** - 所有CI/CD流水线必须包含ESM验证

**FAILURE HANDLING**:
- ESM构建失败 = 立即系统失败
- 发现CommonJS语法 = 立即修复
- CI/CD验证失败 = 阻止合并

**PRIORITY**: ESM验证优先于所有其他测试方法。任何系统未通过ESM验证都被认为功能不正常。

---

## Important Notes

- This is an ESM-only project, CommonJS is strictly prohibited
- **NEVER** use `--no-verify` to bypass commit hooks
- **NEVER** disable tests instead of fixing them
- **ALWAYS** update README after code changes
- **ALWAYS** read README before making changes
- **ALWAYS** commit working code incrementally
- **ALWAYS** learn from existing implementations first
- **ALWAYS** verify ESM compatibility before committing
- **NEVER** import other modules directly - always use MessageCenter
- **NEVER** expose module interfaces - only communicate via APIs
- **ALWAYS** validate module communication follows API-only rules

## Version History

- **v0.0.1** - Initial ESM project structure with CI/CD pipeline