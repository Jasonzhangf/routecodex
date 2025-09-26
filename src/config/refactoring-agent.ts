/**
 * RouteCodex Configuration System Refactoring Agent
 * 重构助手 - 帮助实施配置系统重构
 */

import fs from 'fs/promises';
import path from 'path';

/**
 * 重构助手类
 * 提供配置系统重构的工具和方法
 */
export class RefactoringAgent {
  private projectRoot: string;
  private configPath: string;
  private systemConfigPath: string;
  private mergedConfigPath: string;

  constructor(projectRoot: string = './') {
    this.projectRoot = path.resolve(projectRoot);
    this.configPath = path.join(this.projectRoot, '~/.routecodex/config.json');
    this.systemConfigPath = path.join(this.projectRoot, 'config/modules.json');
    this.mergedConfigPath = path.join(this.projectRoot, '~/.routecodex/merged-config.json');
  }

  /**
   * 执行重构流程 - 主要入口点
   */
  async executeRefactoring(): Promise<void> {
    console.log('🚀 Starting RouteCodex Configuration System Refactoring...\n');

    try {
      // 步骤1: 分析当前状态
      await this.analyzeCurrentState();

      // 步骤2: 创建配置类型定义
      await this.createConfigTypes();

      // 步骤3: 创建配置解析器
      await this.createConfigParsers();

      // 步骤4: 重构虚拟路由模块
      await this.refactorVirtualRouterModule();

      // 步骤5: 创建配置管理模块
      await this.createConfigManagerModule();

      // 步骤6: 更新主入口点
      await this.updateMainEntry();

      // 步骤7: 创建测试用例
      await this.createTestCases();

      // 步骤8: 验证重构结果
      await this.validateRefactoring();

      console.log('✅ Configuration system refactoring completed successfully!');
      console.log('📋 Next steps:');
      console.log('   1. Review the generated code');
      console.log('   2. Run the test suite');
      console.log('   3. Test with actual configuration files');
      console.log('   4. Deploy and monitor');
    } catch (error) {
      console.error('❌ Refactoring failed:', error);
      throw error;
    }
  }

  /**
   * 开始重构流程 (保持向后兼容)
   */
  async startRefactoring(): Promise<void> {
    return this.executeRefactoring();
  }

  /**
   * 分析当前状态
   */
  private async analyzeCurrentState(): Promise<void> {
    console.log('📊 Analyzing current state...');

    try {
      // 检查现有文件
      const filesToCheck = [
        'src/config/user-config-types.ts',
        'src/config/user-config-manager.ts',
        'config/modules.json',
        '~/.routecodex/config.json',
      ];

      for (const file of filesToCheck) {
        try {
          await fs.access(file);
          console.log(`   ✅ Found: ${file}`);
        } catch {
          console.log(`   ❌ Missing: ${file}`);
        }
      }

      console.log('📋 Current state analysis complete\n');
    } catch (error) {
      console.error('❌ Failed to analyze current state:', error);
      throw error;
    }
  }

  /**
   * 创建配置类型定义
   */
  private async createConfigTypes(): Promise<void> {
    console.log('📝 Creating configuration type definitions...');

    const typesFile = {
      name: 'merged-config-types.ts',
      content: this.getMergedConfigTypesCode(),
    };

    const configDir = path.join(this.projectRoot, 'src/config');
    await fs.mkdir(configDir, { recursive: true });

    const filePath = path.join(configDir, typesFile.name);
    await fs.writeFile(filePath, typesFile.content, 'utf-8');
    console.log(`   ✅ Created: ${typesFile.name}`);

    console.log('📋 Configuration type definitions created\n');
  }

  /**
   * 创建配置解析器
   */
  private async createConfigParsers(): Promise<void> {
    console.log('🔧 Creating configuration parsers...');

    const parsers = [
      {
        name: 'user-config-parser.ts',
        content: this.getUserConfigParserCode(),
      },
      {
        name: 'auth-file-resolver.ts',
        content: this.getAuthFileResolverCode(),
      },
      {
        name: 'route-target-parser.ts',
        content: this.getRouteTargetParserCode(),
      },
      {
        name: 'config-merger.ts',
        content: this.getConfigMergerCode(),
      },
    ];

    const configDir = path.join(this.projectRoot, 'src/config');
    await fs.mkdir(configDir, { recursive: true });

    for (const parser of parsers) {
      const filePath = path.join(configDir, parser.name);
      await fs.writeFile(filePath, parser.content, 'utf-8');
      console.log(`   ✅ Created: ${parser.name}`);
    }

    console.log('📋 Configuration parsers created\n');
  }

  /**
   * 重构虚拟路由模块
   */
  private async refactorVirtualRouterModule(): Promise<void> {
    console.log('🔄 Refactoring virtual router module...');

    const moduleDir = path.join(this.projectRoot, 'src/modules/virtual-router');
    await fs.mkdir(moduleDir, { recursive: true });

    const moduleFiles = [
      {
        name: 'virtual-router-module.ts',
        content: this.getVirtualRouterModuleCode(),
      },
      {
        name: 'route-target-pool.ts',
        content: this.getRouteTargetPoolCode(),
      },
      {
        name: 'pipeline-config-manager.ts',
        content: this.getPipelineConfigManagerCode(),
      },
      {
        name: 'protocol-manager.ts',
        content: this.getProtocolManagerCode(),
      },
    ];

    for (const file of moduleFiles) {
      const filePath = path.join(moduleDir, file.name);
      await fs.writeFile(filePath, file.content, 'utf-8');
      console.log(`   ✅ Created: ${file.name}`);
    }

    console.log('📋 Virtual router module refactored\n');
  }

  /**
   * 创建配置管理模块
   */
  private async createConfigManagerModule(): Promise<void> {
    console.log('🏗️ Creating config manager module...');

    const moduleDir = path.join(this.projectRoot, 'src/modules/config-manager');
    await fs.mkdir(moduleDir, { recursive: true });

    const moduleFiles = [
      {
        name: 'config-manager-module.ts',
        content: this.getConfigManagerModuleCode(),
      },
      {
        name: 'merged-config-generator.ts',
        content: this.getMergedConfigGeneratorCode(),
      },
      {
        name: 'config-watcher.ts',
        content: this.getConfigWatcherCode(),
      },
    ];

    for (const file of moduleFiles) {
      const filePath = path.join(moduleDir, file.name);
      await fs.writeFile(filePath, file.content, 'utf-8');
      console.log(`   ✅ Created: ${file.name}`);
    }

    console.log('📋 Config manager module created\n');
  }

  /**
   * 更新主入口点
   */
  private async updateMainEntry(): Promise<void> {
    console.log('🔄 Updating main entry point...');

    const mainIndexPath = path.join(this.projectRoot, 'src/index.ts');
    const newContent = this.getMainEntryCode();

    await fs.writeFile(mainIndexPath, newContent, 'utf-8');
    console.log('   ✅ Updated: src/index.ts');
    console.log('📋 Main entry point updated\n');
  }

  /**
   * 创建测试用例
   */
  private async createTestCases(): Promise<void> {
    console.log('🧪 Creating test cases...');

    const testDir = path.join(this.projectRoot, 'tests/config');
    await fs.mkdir(testDir, { recursive: true });

    const testFiles = [
      {
        name: 'user-config-parser.test.ts',
        content: this.getUserConfigParserTestCode(),
      },
      {
        name: 'config-merger.test.ts',
        content: this.getConfigMergerTestCode(),
      },
      {
        name: 'virtual-router.test.ts',
        content: this.getVirtualRouterTestCode(),
      },
    ];

    for (const file of testFiles) {
      const filePath = path.join(testDir, file.name);
      await fs.writeFile(filePath, file.content, 'utf-8');
      console.log(`   ✅ Created: ${file.name}`);
    }

    console.log('📋 Test cases created\n');
  }

  /**
   * 验证重构结果
   */
  private async validateRefactoring(): Promise<void> {
    console.log('✅ Validating refactoring results...');

    // 验证文件存在性
    const requiredFiles = [
      'src/config/user-config-parser.ts',
      'src/config/auth-file-resolver.ts',
      'src/modules/virtual-router/virtual-router-module.ts',
      'src/modules/config-manager/config-manager-module.ts',
    ];

    for (const file of requiredFiles) {
      try {
        await fs.access(path.join(this.projectRoot, file));
        console.log(`   ✅ Validated: ${file}`);
      } catch {
        console.log(`   ❌ Missing: ${file}`);
      }
    }

    console.log('📋 Refactoring validation complete\n');
  }

  /**
   * 获取用户配置解析器代码
   */
  private getUserConfigParserCode(): string {
    return `/**
 * User Configuration Parser
 * 解析用户配置为模块格式
 */

import type { UserConfig, ModuleConfigs } from './user-config-types.js';

export class UserConfigParser {
  /**
   * 解析用户配置
   */
  parseUserConfig(userConfig: UserConfig): {
    routeTargets: RouteTargetPool;
    pipelineConfigs: PipelineConfigs;
    moduleConfigs: ModuleConfigs;
  } {
    const routeTargets = this.parseRouteTargets(userConfig.virtualrouter.routing);
    const pipelineConfigs = this.parsePipelineConfigs(userConfig.virtualrouter);
    const moduleConfigs = this.parseModuleConfigs(userConfig);

    return {
      routeTargets,
      pipelineConfigs,
      moduleConfigs
    };
  }

  /**
   * 解析路由目标池
   */
  private parseRouteTargets(routingConfig: any): RouteTargetPool {
    const routeTargets: RouteTargetPool = {};

    for (const [routeName, targets] of Object.entries(routingConfig)) {
      routeTargets[routeName] = targets.map((target: string) => {
        const parts = target.split('.');
        
        // 支持两种格式：
        // 1. provider.model → 使用provider的所有key（负载均衡）
        // 2. provider.model.key → 只使用指定key
        if (parts.length === 2) {
          // provider.model格式：使用provider的所有key
          const [providerId, modelId] = parts;
          return {
            providerId,
            modelId,
            keyId: '*', // 通配符表示使用所有key
            actualKey: '*', // 通配符表示使用所有key
            inputProtocol: 'openai',
            outputProtocol: 'openai'
          };
        } else if (parts.length === 3) {
          // provider.model.key格式：只使用指定key
          const [providerId, modelId, keyId] = parts;
          return {
            providerId,
            modelId,
            keyId,
            actualKey: this.resolveActualKey(keyId),
            inputProtocol: 'openai',
            outputProtocol: 'openai'
          };
        } else {
          throw new Error('Invalid route target format: ' + target);
        }
      });
    }

    return routeTargets;

  /**
   * 解析流水线配置
   */
  private parsePipelineConfigs(virtualRouterConfig: any): PipelineConfigs {
    const pipelineConfigs: PipelineConfigs = {};

    for (const [providerId, providerConfig] of Object.entries(virtualRouterConfig.providers)) {
      for (const [modelId, modelConfig] of Object.entries(providerConfig.models)) {
        for (const keyId of providerConfig.apiKey) {
          const configKey = \`\${providerId}.\${modelId}.\${keyId}\`;
          pipelineConfigs[configKey] = {
            provider: {
              type: providerConfig.type,
              baseURL: providerConfig.baseURL
            },
            model: {
              maxContext: modelConfig.maxContext || 128000,
              maxTokens: modelConfig.maxTokens || 32000
            },
            keyConfig: {
              keyId,
              actualKey: this.resolveActualKey(keyId)
            },
            protocols: {
              input: virtualRouterConfig.inputProtocol,
              output: virtualRouterConfig.outputProtocol
            }
          };
        }
      }
    }

    return pipelineConfigs;
  }

  /**
   * 解析模块配置
   */
  private parseModuleConfigs(userConfig: UserConfig): ModuleConfigs {
    const moduleConfigs: ModuleConfigs = {};

    // 虚拟路由模块配置
    moduleConfigs.virtualrouter = {
      enabled: true,
      config: {
        moduleType: 'virtual-router',
        inputProtocol: userConfig.virtualrouter.inputProtocol,
        outputProtocol: userConfig.virtualrouter.outputProtocol
      }
    };

    // 其他模块配置
    for (const [moduleName, moduleConfig] of Object.entries(userConfig)) {
      if (moduleName !== 'virtualrouter' && moduleName !== 'user' && typeof moduleConfig === 'object') {
        moduleConfigs[moduleName] = {
          enabled: true,
          config: moduleConfig
        };
      }
    }

    return moduleConfigs;
  }

  /**
   * 解析实际密钥
   */
  private resolveActualKey(keyId: string): string {
    if (keyId.startsWith('authfile-')) {
      // TODO: 实现AuthFile解析
      return keyId;
    }
    return keyId;
  }
}

// 类型定义
interface RouteTarget {
  providerId: string;
  modelId: string;
  keyId: string;
  actualKey: string;
  inputProtocol: string;
  outputProtocol: string;
}

interface RouteTargetPool {
  [routeName: string]: RouteTarget[];
}

interface PipelineConfig {
  provider: {
    type: string;
    baseURL: string;
  };
  model: {
    maxContext: number;
    maxTokens: number;
  };
  keyConfig: {
    keyId: string;
    actualKey: string;
  };
  protocols: {
    input: string;
    output: string;
  };
}

interface PipelineConfigs {
  [providerModelKey: string]: PipelineConfig;
}
`;
  }

  /**
   * 获取AuthFile解析器代码
   */
  private getAuthFileResolverCode(): string {
    return `/**
 * AuthFile Resolver
 * 处理AuthFile机制的密钥解析
 */

import fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';

export class AuthFileResolver {
  private authDir: string;
  private keyCache: Map<string, string> = new Map();

  constructor(authDir?: string) {
    this.authDir = authDir || path.join(homedir(), '.routecodex', 'auth');
  }

  /**
   * 解析密钥
   */
  async resolveKey(keyId: string): Promise<string> {
    // 检查缓存
    if (this.keyCache.has(keyId)) {
      return this.keyCache.get(keyId)!;
    }

    // 如果不是AuthFile，直接返回
    if (!keyId.startsWith('authfile-')) {
      return keyId;
    }

    // 解析AuthFile
    const filename = keyId.replace('authfile-', '');
    const filePath = path.join(this.authDir, filename);

    try {
      // 读取密钥文件
      const keyContent = await fs.readFile(filePath, 'utf-8');
      const actualKey = keyContent.trim();

      // 缓存密钥
      this.keyCache.set(keyId, actualKey);

      return actualKey;
    } catch (error) {
      throw new Error(\`Failed to read auth file \${filePath}: \${error}\`);
    }
  }

  /**
   * 批量解析密钥
   */
  async resolveKeys(keyIds: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();

    for (const keyId of keyIds) {
      try {
        const actualKey = await this.resolveKey(keyId);
        result.set(keyId, actualKey);
      } catch (error) {
        console.warn(\`Failed to resolve key \${keyId}:\`, error);
        result.set(keyId, keyId); // 使用原始keyId作为fallback
      }
    }

    return result;
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.keyCache.clear();
  }

  /**
   * 确保Auth目录存在
   */
  async ensureAuthDir(): Promise<void> {
    try {
      await fs.mkdir(this.authDir, { recursive: true });
      console.log(\`Auth directory created: \${this.authDir}\`);
    } catch (error) {
      // 目录已存在，忽略错误
    }
  }
}
`;
  }

  /**
   * 获取路由目标解析器代码
   */
  private getRouteTargetParserCode(): string {
    return `/**
 * Route Target Parser
 * 解析路由字符串为目标配置
 */

export class RouteTargetParser {
  /**
   * 解析路由字符串
   */
  parseRouteString(routeString: string): RouteTarget {
    const parts = routeString.split('.');
    
    // 支持两种格式：provider.model.key 或 provider.model（默认使用default key）
    if (parts.length === 2) {
      // 新格式：provider.model，使用default作为key
      const [providerId, modelId] = parts;
      return {
        providerId,
        modelId,
        keyId: 'default',
        actualKey: 'default', // 将由AuthFileResolver解析
        inputProtocol: 'openai',
        outputProtocol: 'openai'
      };
    } else if (parts.length === 3) {
      // 旧格式：provider.model.key
      const [providerId, modelId, keyId] = parts;
      return {
        providerId,
        modelId,
        keyId,
        actualKey: keyId, // 将由AuthFileResolver解析
        inputProtocol: 'openai',
        outputProtocol: 'openai'
      };
    } else {
      throw new Error("Invalid route string format: " + routeString + ". Expected format: provider.model or provider.model.key");
    }
  }

  /**
   * 解析路由配置
   */
  parseRoutingConfig(routingConfig: Record<string, string[]>): RouteTargetPool {
    const routeTargetPool: RouteTargetPool = {};

    for (const [routeName, targets] of Object.entries(routingConfig)) {
      routeTargetPool[routeName] = targets.map(target =>
        this.parseRouteString(target)
      );
    }

    return routeTargetPool;
  }

  /**
   * 验证路由目标
   */
  validateRouteTarget(target: RouteTarget): boolean {
    return (
      target.providerId &&
      target.modelId &&
      target.keyId &&
      target.inputProtocol &&
      target.outputProtocol
    );
  }

  /**
   * 验证路由配置
   */
  validateRoutingConfig(routeTargetPool: RouteTargetPool): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    for (const [routeName, targets] of Object.entries(routeTargetPool)) {
      if (!targets || targets.length === 0) {
        errors.push(\`Route \${routeName} has no targets\`);
        continue;
      }

      for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        if (!this.validateRouteTarget(target)) {
          errors.push(\`Invalid target at index \${i} in route \${routeName}\`);
        }
      }
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }
}

interface RouteTarget {
  providerId: string;
  modelId: string;
  keyId: string;
  actualKey: string;
  inputProtocol: string;
  outputProtocol: string;
}

interface RouteTargetPool {
  [routeName: string]: RouteTarget[];
}
`;
  }

  /**
   * 获取配置合并器代码
   */
  private getConfigMergerCode(): string {
    return `/**
 * Configuration Merger
 * 合并系统配置和用户配置
 */

import type { ModulesConfig, UserConfig, MergedConfig } from './user-config-types.js';

export class ConfigMerger {
  /**
   * 合并配置
   */
  mergeConfigs(
    systemConfig: ModulesConfig,
    userConfig: UserConfig,
    parsedUserConfig: any
  ): MergedConfig {
    const mergedModules = this.mergeModules(systemConfig.modules, parsedUserConfig.moduleConfigs);

    // 为虚拟路由模块添加解析后的配置 - 清除默认routeTargets，只保留用户配置
    if (mergedModules.virtualrouter && parsedUserConfig.routeTargets) {
      mergedModules.virtualrouter.config = {
        ...mergedModules.virtualrouter.config,
        // 只保留用户配置的routeTargets，完全清除系统默认的routeTargets
        routeTargets: parsedUserConfig.routeTargets,
        pipelineConfigs: parsedUserConfig.pipelineConfigs
      };
    } else if (mergedModules.virtualrouter) {
      // 如果用户没有提供routeTargets，清除系统默认的routeTargets
      mergedModules.virtualrouter.config = {
        ...mergedModules.virtualrouter.config,
        routeTargets: {},
        pipelineConfigs: {}
      };
    }

    return {
      version: '1.0.0',
      mergedAt: new Date().toISOString(),
      modules: mergedModules
    };
  }

  /**
   * 合并模块配置
   */
  private mergeModules(
    systemModules: Record<string, any>,
    userModules: Record<string, any>
  ): Record<string, any> {
    const mergedModules: Record<string, any> = {};

    // 首先复制所有系统模块
    for (const [moduleName, systemModule] of Object.entries(systemModules)) {
      mergedModules[moduleName] = { ...systemModule };
    }

    // 然后合并用户配置
    for (const [moduleName, userModule] of Object.entries(userModules)) {
      if (mergedModules[moduleName]) {
        // 深度合并现有模块
        mergedModules[moduleName] = this.deepMerge(
          mergedModules[moduleName],
          userModule
        );
      } else {
        // 添加新模块
        mergedModules[moduleName] = userModule;
      }
    }

    return mergedModules;
  }

  /**
   * 深度合并对象
   */
  private deepMerge(target: any, source: any): any {
    if (typeof target !== 'object' || target === null) {
      return source;
    }

    if (typeof source !== 'object' || source === null) {
      return target;
    }

    const result = { ...target };

    for (const [key, value] of Object.entries(source)) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        result[key] = this.deepMerge(target[key], value);
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  /**
   * 验证合并后的配置
   */
  validateMergedConfig(mergedConfig: MergedConfig): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!mergedConfig.modules) {
      errors.push('Missing modules configuration');
      return { isValid: false, errors };
    }

    // 验证虚拟路由模块配置
    const virtualRouter = mergedConfig.modules.virtualrouter;
    if (virtualRouter && virtualRouter.enabled) {
      if (!virtualRouter.config.routeTargets) {
        errors.push('Virtual router missing routeTargets configuration');
      }
      if (!virtualRouter.config.pipelineConfigs) {
        errors.push('Virtual router missing pipelineConfigs configuration');
      }
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }
}
`;
  }

  /**
   * 获取虚拟路由模块代码
   */
  private getVirtualRouterModuleCode(): string {
    return `/**
 * Virtual Router Module
 * 虚拟路由模块 - 处理请求路由和负载均衡
 */

import { BaseModule } from '../../core/base-module.js';

export class VirtualRouterModule extends BaseModule {
  private routeTargets: RouteTargetPool = {};
  private pipelineConfigs: PipelineConfigs = {};
  private protocolManager: ProtocolManager;
  private loadBalancer: LoadBalancer;

  constructor() {
    super({
      id: 'virtual-router',
      name: 'Virtual Router',
      version: '1.0.0',
      description: 'Handles request routing and load balancing'
    });

    this.protocolManager = new ProtocolManager();
    this.loadBalancer = new LoadBalancer();
  }

  /**
   * 初始化模块
   */
  async initialize(config: VirtualRouterConfig): Promise<void> {
    console.log('🔄 Initializing Virtual Router Module...');

    try {
      // 设置路由目标池
      this.routeTargets = config.routeTargets;

      // 设置流水线配置
      this.pipelineConfigs = config.pipelineConfigs;

      // 初始化协议管理器
      await this.protocolManager.initialize({
        inputProtocol: config.inputProtocol,
        outputProtocol: config.outputProtocol
      });

      // 初始化负载均衡器
      await this.loadBalancer.initialize(this.routeTargets);

      console.log('✅ Virtual Router Module initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize Virtual Router Module:', error);
      throw error;
    }
  }

  /**
   * 路由请求
   */
  async routeRequest(request: any, routeName: string = 'default'): Promise<any> {
    try {
      // 获取可用目标
      const targets = this.routeTargets[routeName];
      if (!targets || targets.length === 0) {
        throw new Error(\`No targets found for route: \${routeName}\`);
      }

      // 选择目标
      const target = await this.loadBalancer.selectTarget(targets);
      if (!target) {
        throw new Error('No available targets for routing');
      }

      // 获取流水线配置
      const pipelineConfig = this.pipelineConfigs[
        \`\${target.providerId}.\${target.modelId}.\${target.keyId}\`
      ];
      if (!pipelineConfig) {
        throw new Error(\`No pipeline config found for target: \${target.providerId}.\${target.modelId}.\${target.keyId}\`);
      }

      // 协议转换（如果需要）
      const convertedRequest = await this.protocolManager.convertRequest(
        request,
        pipelineConfig.protocols.input,
        pipelineConfig.protocols.output
      );

      // 执行请求
      const response = await this.executeRequest(convertedRequest, pipelineConfig);

      // 协议转换响应（如果需要）
      const convertedResponse = await this.protocolManager.convertResponse(
        response,
        pipelineConfig.protocols.output,
        pipelineConfig.protocols.input
      );

      return convertedResponse;

    } catch (error) {
      console.error(\`❌ Request routing failed for route \${routeName}:\`, error);
      throw error;
    }
  }

  /**
   * 执行请求
   */
  private async executeRequest(request: any, pipelineConfig: PipelineConfig): Promise<any> {
    // TODO: 实现实际的请求执行逻辑
    console.log(\`🔄 Executing request to \${pipelineConfig.provider.baseURL}\`);

    // 模拟请求执行
    return {
      id: 'response-' + Date.now(),
      object: 'chat.completion',
      model: pipelineConfig.provider.type,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'Response from ' + pipelineConfig.provider.type
        }
      }]
    };
  }

  /**
   * 获取状态
   */
  getStatus(): any {
    return {
      status: this.isRunning ? 'running' : 'stopped',
      routeTargets: Object.keys(this.routeTargets),
      pipelineConfigs: Object.keys(this.pipelineConfigs),
      protocolManager: this.protocolManager.getStatus(),
      loadBalancer: this.loadBalancer.getStatus()
    };
  }
}

// 协议管理器
class ProtocolManager {
  private inputProtocol: string = 'openai';
  private outputProtocol: string = 'openai';

  async initialize(config: { inputProtocol: string; outputProtocol: string }): Promise<void> {
    this.inputProtocol = config.inputProtocol;
    this.outputProtocol = config.outputProtocol;
  }

  async convertRequest(request: any, fromProtocol: string, toProtocol: string): Promise<any> {
    if (fromProtocol === toProtocol) {
      return request;
    }

    // TODO: 实现协议转换逻辑
    console.log(\`🔄 Converting request from \${fromProtocol} to \${toProtocol}\`);
    return request;
  }

  async convertResponse(response: any, fromProtocol: string, toProtocol: string): Promise<any> {
    if (fromProtocol === toProtocol) {
      return response;
    }

    // TODO: 实现协议转换逻辑
    console.log(\`🔄 Converting response from \${fromProtocol} to \${toProtocol}\`);
    return response;
  }

  getStatus(): any {
    return {
      inputProtocol: this.inputProtocol,
      outputProtocol: this.outputProtocol
    };
  }
}

// 负载均衡器
class LoadBalancer {
  private routeTargets: RouteTargetPool = {};
  private currentIndex: Map<string, number> = new Map();

  async initialize(routeTargets: RouteTargetPool): Promise<void> {
    this.routeTargets = routeTargets;
  }

  async selectTarget(targets: RouteTarget[]): Promise<RouteTarget | null> {
    if (targets.length === 0) {
      return null;
    }

    if (targets.length === 1) {
      return targets[0];
    }

    // 简单的轮询算法
    const routeName = Object.keys(this.routeTargets).find(name =>
      this.routeTargets[name] === targets
    );

    if (!routeName) {
      return targets[0];
    }

    const currentIndex = this.currentIndex.get(routeName) || 0;
    const nextIndex = (currentIndex + 1) % targets.length;
    this.currentIndex.set(routeName, nextIndex);

    return targets[nextIndex];
  }

  getStatus(): any {
    return {
      strategy: 'round-robin',
      currentIndex: Object.fromEntries(this.currentIndex)
    };
  }
}

// 类型定义
interface VirtualRouterConfig {
  routeTargets: RouteTargetPool;
  pipelineConfigs: PipelineConfigs;
  inputProtocol: string;
  outputProtocol: string;
  timeout: number;
}

interface RouteTargetPool {
  [routeName: string]: RouteTarget[];
}

interface PipelineConfigs {
  [providerModelKey: string]: PipelineConfig;
}

interface RouteTarget {
  providerId: string;
  modelId: string;
  keyId: string;
  actualKey: string;
  inputProtocol: string;
  outputProtocol: string;
}

interface PipelineConfig {
  provider: {
    type: string;
    baseURL: string;
  };
  model: {
    maxContext: number;
    maxTokens: number;
  };
  keyConfig: {
    keyId: string;
    actualKey: string;
  };
  protocols: {
    input: string;
    output: string;
  };
}
`;
  }

  /**
   * 获取路由目标池代码
   */
  private getRouteTargetPoolCode(): string {
    return `/**
 * Route Target Pool
 * 路由目标池管理
 */

export class RouteTargetPool {
  private targets: Map<string, RouteTarget[]> = new Map();
  private healthStatus: Map<string, boolean> = new Map();

  /**
   * 添加路由目标
   */
  addRouteTargets(routeName: string, targets: RouteTarget[]): void {
    this.targets.set(routeName, targets);

    // 初始化健康状态
    for (const target of targets) {
      const targetKey = this.getTargetKey(target);
      this.healthStatus.set(targetKey, true);
    }
  }

  /**
   * 获取路由目标
   */
  getRouteTargets(routeName: string): RouteTarget[] {
    return this.targets.get(routeName) || [];
  }

  /**
   * 获取健康的路由目标
   */
  getHealthyTargets(routeName: string): RouteTarget[] {
    const targets = this.getRouteTargets(routeName);
    return targets.filter(target => {
      const targetKey = this.getTargetKey(target);
      return this.healthStatus.get(targetKey) || false;
    });
  }

  /**
   * 更新目标健康状态
   */
  updateTargetHealth(target: RouteTarget, isHealthy: boolean): void {
    const targetKey = this.getTargetKey(target);
    this.healthStatus.set(targetKey, isHealthy);
  }

  /**
   * 获取所有路由名称
   */
  getRouteNames(): string[] {
    return Array.from(this.targets.keys());
  }

  /**
   * 获取目标统计信息
   */
  getStatistics(): RoutePoolStatistics {
    const stats: RoutePoolStatistics = {
      totalRoutes: this.targets.size,
      totalTargets: 0,
      healthyTargets: 0,
      unhealthyTargets: 0,
      routeDetails: {}
    };

    for (const [routeName, targets] of this.targets) {
      const healthyCount = targets.filter(target => {
        const targetKey = this.getTargetKey(target);
        return this.healthStatus.get(targetKey) || false;
      }).length;

      stats.totalTargets += targets.length;
      stats.healthyTargets += healthyCount;
      stats.unhealthyTargets += targets.length - healthyCount;

      stats.routeDetails[routeName] = {
        totalTargets: targets.length,
        healthyTargets: healthyCount,
        unhealthyTargets: targets.length - healthyCount
      };
    }

    return stats;
  }

  /**
   * 生成目标键
   */
  private getTargetKey(target: RouteTarget): string {
    return \`\${target.providerId}.\${target.modelId}.\${target.keyId}\`;
  }
}

// 类型定义
interface RouteTarget {
  providerId: string;
  modelId: string;
  keyId: string;
  actualKey: string;
  inputProtocol: string;
  outputProtocol: string;
}

interface RoutePoolStatistics {
  totalRoutes: number;
  totalTargets: number;
  healthyTargets: number;
  unhealthyTargets: number;
  routeDetails: Record<string, {
    totalTargets: number;
    healthyTargets: number;
    unhealthyTargets: number;
  }>;
}
`;
  }

  /**
   * 获取流水线配置管理器代码
   */
  private getPipelineConfigManagerCode(): string {
    return `/**
 * Pipeline Configuration Manager
 * 流水线配置管理
 */

export class PipelineConfigManager {
  private configs: Map<string, PipelineConfig> = new Map();
  private configCache: Map<string, any> = new Map();

  /**
   * 添加流水线配置
   */
  addPipelineConfig(key: string, config: PipelineConfig): void {
    this.configs.set(key, config);
    this.configCache.delete(key); // 清除缓存
  }

  /**
   * 批量添加流水线配置
   */
  addPipelineConfigs(configs: Record<string, PipelineConfig>): void {
    for (const [key, config] of Object.entries(configs)) {
      this.addPipelineConfig(key, config);
    }
  }

  /**
   * 获取流水线配置
   */
  getPipelineConfig(key: string): PipelineConfig | undefined {
    return this.configs.get(key);
  }

  /**
   * 获取或创建流水线实例
   */
  async getPipelineInstance(key: string): Promise<any> {
    // 检查缓存
    if (this.configCache.has(key)) {
      return this.configCache.get(key);
    }

    const config = this.getPipelineConfig(key);
    if (!config) {
      throw new Error(\`Pipeline config not found: \${key}\`);
    }

    // 创建流水线实例
    const pipeline = await this.createPipelineInstance(config);

    // 缓存实例
    this.configCache.set(key, pipeline);

    return pipeline;
  }

  /**
   * 移除流水线配置
   */
  removePipelineConfig(key: string): void {
    this.configs.delete(key);
    this.configCache.delete(key);
  }

  /**
   * 清除所有配置
   */
  clearConfigs(): void {
    this.configs.clear();
    this.configCache.clear();
  }

  /**
   * 获取配置统计信息
   */
  getStatistics(): PipelineConfigStatistics {
    const stats: PipelineConfigStatistics = {
      totalConfigs: this.configs.size,
      cachedInstances: this.configCache.size,
      providerTypes: {},
      protocolTypes: { input: {}, output: {} }
    };

    for (const config of this.configs.values()) {
      // 统计provider类型
      const providerType = config.provider.type;
      stats.providerTypes[providerType] = (stats.providerTypes[providerType] || 0) + 1;

      // 统计协议类型
      const inputProtocol = config.protocols.input;
      const outputProtocol = config.protocols.output;

      stats.protocolTypes.input[inputProtocol] =
        (stats.protocolTypes.input[inputProtocol] || 0) + 1;
      stats.protocolTypes.output[outputProtocol] =
        (stats.protocolTypes.output[outputProtocol] || 0) + 1;
    }

    return stats;
  }

  /**
   * 创建流水线实例
   */
  private async createPipelineInstance(config: PipelineConfig): Promise<any> {
    // TODO: 实现实际的流水线创建逻辑
    console.log(\`🔄 Creating pipeline instance for \${config.provider.type}\`);

    return {
      provider: config.provider,
      model: config.model,
      protocols: config.protocols,
      execute: async (request: any) => {
        // 模拟流水线执行
        return {
          id: 'pipeline-response-' + Date.now(),
          success: true
        };
      }
    };
  }
}

// 类型定义
interface PipelineConfig {
  provider: {
    type: string;
    baseURL: string;
  };
  model: {
    maxContext: number;
    maxTokens: number;
  };
  keyConfig: {
    keyId: string;
    actualKey: string;
  };
  protocols: {
    input: string;
    output: string;
  };
}

interface PipelineConfigStatistics {
  totalConfigs: number;
  cachedInstances: number;
  providerTypes: Record<string, number>;
  protocolTypes: {
    input: Record<string, number>;
    output: Record<string, number>;
  };
}
`;
  }

  /**
   * 获取协议管理器代码
   */
  private getProtocolManagerCode(): string {
    return `/**
 * Protocol Manager
 * 协议管理和转换
 */

export class ProtocolManager {
  private inputProtocol: string = 'openai';
  private outputProtocol: string = 'openai';
  private converters: Map<string, ProtocolConverter> = new Map();

  constructor() {
    this.initializeConverters();
  }

  /**
   * 初始化协议转换器
   */
  private initializeConverters(): void {
    // 注册协议转换器
    this.converters.set('openai->anthropic', new OpenAIToAnthropicConverter());
    this.converters.set('anthropic->openai', new AnthropicToOpenAIConverter());
  }

  /**
   * 设置协议
   */
  setProtocols(inputProtocol: string, outputProtocol: string): void {
    this.inputProtocol = inputProtocol;
    this.outputProtocol = outputProtocol;
  }

  /**
   * 转换请求
   */
  async convertRequest(request: any, fromProtocol: string, toProtocol: string): Promise<any> {
    if (fromProtocol === toProtocol) {
      return request;
    }

    const converterKey = \`\${fromProtocol}->\${toProtocol}\`;
    const converter = this.converters.get(converterKey);

    if (!converter) {
      throw new Error(\`No converter found for \${fromProtocol} -> \${toProtocol}\`);
    }

    return await converter.convertRequest(request);
  }

  /**
   * 转换响应
   */
  async convertResponse(response: any, fromProtocol: string, toProtocol: string): Promise<any> {
    if (fromProtocol === toProtocol) {
      return response;
    }

    const converterKey = \`\${fromProtocol}->\${toProtocol}\`;
    const converter = this.converters.get(converterKey);

    if (!converter) {
      throw new Error(\`No converter found for \${fromProtocol} -> \${toProtocol}\`);
    }

    return await converter.convertResponse(response);
  }

  /**
   * 获取支持的协议转换
   */
  getSupportedConversions(): string[] {
    return Array.from(this.converters.keys());
  }

  /**
   * 获取状态
   */
  getStatus(): ProtocolManagerStatus {
    return {
      inputProtocol: this.inputProtocol,
      outputProtocol: this.outputProtocol,
      supportedConversions: this.getSupportedConversions()
    };
  }
}

// 协议转换器接口
interface ProtocolConverter {
  convertRequest(request: any): Promise<any>;
  convertResponse(response: any): Promise<any>;
}

// OpenAI to Anthropic 转换器
class OpenAIToAnthropicConverter implements ProtocolConverter {
  async convertRequest(request: any): Promise<any> {
    // 将OpenAI格式转换为Anthropic格式
    const anthropicRequest = {
      model: request.model,
      max_tokens: request.max_tokens || 1024,
      messages: request.messages.map((msg: any) => ({
        role: msg.role === 'system' ? 'assistant' : msg.role,
        content: msg.content
      }))
    };

    console.log('🔄 Converted OpenAI request to Anthropic format');
    return anthropicRequest;
  }

  async convertResponse(response: any): Promise<any> {
    // 将Anthropic格式转换为OpenAI格式
    const openaiResponse = {
      id: response.id,
      object: 'chat.completion',
      created: Date.now(),
      model: response.model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: response.content[0]?.text || ''
        },
        finish_reason: response.stop_reason
      }]
    };

    console.log('🔄 Converted Anthropic response to OpenAI format');
    return openaiResponse;
  }
}

// Anthropic to OpenAI 转换器
class AnthropicToOpenAIConverter implements ProtocolConverter {
  async convertRequest(request: any): Promise<any> {
    // 将Anthropic格式转换为OpenAI格式
    const openaiRequest = {
      model: request.model,
      max_tokens: request.max_tokens || 1024,
      messages: request.messages.map((msg: any) => ({
        role: msg.role === 'assistant' ? 'system' : msg.role,
        content: typeof msg.content === 'string' ? msg.content : msg.content.text
      }))
    };

    console.log('🔄 Converted Anthropic request to OpenAI format');
    return openaiRequest;
  }

  async convertResponse(response: any): Promise<any> {
    // 将OpenAI格式转换为Anthropic格式
    const anthropicResponse = {
      id: response.id,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: response.choices[0]?.message?.content || '' }],
      model: response.model,
      stop_reason: response.choices[0]?.finish_reason
    };

    console.log('🔄 Converted OpenAI response to Anthropic format');
    return anthropicResponse;
  }
}

// 类型定义
interface ProtocolManagerStatus {
  inputProtocol: string;
  outputProtocol: string;
  supportedConversions: string[];
}
`;
  }

  /**
   * 获取配置管理模块代码
   */
  private getConfigManagerModuleCode(): string {
    return `/**
 * Config Manager Module
 * 配置管理模块 - 管理配置文件和重载
 */

import { BaseModule } from '../../core/base-module.js';
import { UserConfigParser } from '../../config/user-config-parser.js';
import { ConfigMerger } from '../../config/config-merger.js';
import { AuthFileResolver } from '../../config/auth-file-resolver.js';

export class ConfigManagerModule extends BaseModule {
  private configPath: string;
  private systemConfigPath: string;
  private mergedConfigPath: string;
  private userConfigParser: UserConfigParser;
  private configMerger: ConfigMerger;
  private authFileResolver: AuthFileResolver;
  private configWatcher: any;

  constructor(configPath?: string) {
    super({
      id: 'config-manager',
      name: 'Configuration Manager',
      version: '1.0.0',
      description: 'Manages configuration files and reloading'
    });

    this.configPath = configPath || '~/.routecodex/config.json';
    this.systemConfigPath = './config/modules.json';
    this.mergedConfigPath = '~/.routecodex/merged-config.json';

    this.userConfigParser = new UserConfigParser();
    this.configMerger = new ConfigMerger();
    this.authFileResolver = new AuthFileResolver();
  }

  /**
   * 初始化模块
   */
  async initialize(config: any): Promise<void> {
    console.log('🔄 Initializing Config Manager Module...');

    try {
      this.configPath = config.configPath || this.configPath;
      this.mergedConfigPath = config.mergedConfigPath || this.mergedConfigPath;

      // 确保Auth目录存在
      await this.authFileResolver.ensureAuthDir();

      // 生成初始合并配置
      await this.generateMergedConfig();

      // 启动配置监听
      if (config.autoReload) {
        await this.startConfigWatcher();
      }

      console.log('✅ Config Manager Module initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize Config Manager Module:', error);
      throw error;
    }
  }

  /**
   * 生成合并配置
   */
  async generateMergedConfig(): Promise<void> {
    try {
      console.log('🔄 Generating merged configuration...');

      // 加载系统配置
      const systemConfig = await this.loadSystemConfig();

      // 加载用户配置
      const userConfig = await this.loadUserConfig();

      // 解析用户配置
      const parsedUserConfig = this.userConfigParser.parseUserConfig(userConfig);

      // 合并配置
      const mergedConfig = this.configMerger.mergeConfigs(
        systemConfig,
        userConfig,
        parsedUserConfig
      );

      // 验证合并配置
      const validation = this.configMerger.validateMergedConfig(mergedConfig);
      if (!validation.isValid) {
        throw new Error(\`Configuration validation failed: \${validation.errors.join(', ')}\`);
      }

      // 保存合并配置
      await this.saveMergedConfig(mergedConfig);

      console.log('✅ Merged configuration generated successfully');
    } catch (error) {
      console.error('❌ Failed to generate merged configuration:', error);
      throw error;
    }
  }

  /**
   * 重新加载配置
   */
  async reloadConfig(): Promise<void> {
    console.log('🔄 Reloading configuration...');
    await this.generateMergedConfig();
    console.log('✅ Configuration reloaded successfully');
  }

  /**
   * 加载系统配置
   */
  private async loadSystemConfig(): Promise<any> {
    try {
      const configContent = await fs.readFile(this.systemConfigPath, 'utf-8');
      return JSON.parse(configContent);
    } catch (error) {
      console.error(\`Failed to load system config from \${this.systemConfigPath}:\`, error);
      throw error;
    }
  }

  /**
   * 加载用户配置
   */
  private async loadUserConfig(): Promise<any> {
    try {
      const configContent = await fs.readFile(this.configPath, 'utf-8');
      return JSON.parse(configContent);
    } catch (error) {
      console.error(\`Failed to load user config from \${this.configPath}:\`, error);
      throw error;
    }
  }

  /**
   * 保存合并配置
   */
  private async saveMergedConfig(mergedConfig: any): Promise<void> {
    try {
      const configDir = this.mergedConfigPath.split('/').slice(0, -1).join('/');
      await fs.mkdir(configDir, { recursive: true });

      const configContent = JSON.stringify(mergedConfig, null, 2);
      await fs.writeFile(this.mergedConfigPath, configContent, 'utf-8');

      console.log(\`💾 Merged configuration saved to \${this.mergedConfigPath}\`);
    } catch (error) {
      console.error(\`Failed to save merged config to \${this.mergedConfigPath}:\`, error);
      throw error;
    }
  }

  /**
   * 启动配置监听
   */
  private async startConfigWatcher(): Promise<void> {
    // TODO: 实现配置文件监听
    console.log('👀 Starting configuration watcher...');
  }

  /**
   * 获取状态
   */
  getStatus(): any {
    return {
      status: this.isRunning ? 'running' : 'stopped',
      configPath: this.configPath,
      systemConfigPath: this.systemConfigPath,
      mergedConfigPath: this.mergedConfigPath,
      lastUpdated: new Date().toISOString()
    };
  }
}
`;
  }

  /**
   * 获取合并配置生成器代码
   */
  private getMergedConfigGeneratorCode(): string {
    return `/**
 * Merged Configuration Generator
 * 生成合并后的配置文件
 */

import type { MergedConfig } from '../user-config-types.js';

export class MergedConfigGenerator {
  /**
   * 生成合并配置
   */
  generateMergedConfig(
    systemConfig: any,
    userConfig: any,
    parsedUserConfig: any
  ): MergedConfig {
    return {
      version: '1.0.0',
      mergedAt: new Date().toISOString(),
      modules: this.generateModuleConfigs(systemConfig, userConfig, parsedUserConfig)
    };
  }

  /**
   * 生成模块配置 - 用户配置完全覆盖原则
   * 修复：用户配置应该完全覆盖系统配置，而不是合并
   */
  private generateModuleConfigs(
    systemConfig: any,
    userConfig: any,
    parsedUserConfig: any
  ): any {
    const moduleConfigs: any = {};

    // 首先复制系统模块的基础配置（不包含具体的路由/模型配置）
    for (const [moduleName, systemModule] of Object.entries(systemConfig.modules)) {
      if (moduleName === 'virtualrouter') {
        // 虚拟路由器特殊处理：只保留基础配置框架
        moduleConfigs[moduleName] = {
          ...systemModule,
          config: this.extractSystemBaseConfig(systemModule.config)
        };
      } else {
        // 其他模块：保留基础配置
        moduleConfigs[moduleName] = { ...systemModule };
      }
    }

    // 用户配置完全覆盖系统配置
    for (const [moduleName, userModule] of Object.entries(parsedUserConfig.moduleConfigs)) {
      if (moduleName === 'virtualrouter') {
        // 虚拟路由器：用户配置完全覆盖，包括所有路由和模型配置
        moduleConfigs[moduleName] = {
          ...moduleConfigs[moduleName],
          ...userModule,
          config: {
            // 保留系统基础配置
            ...moduleConfigs[moduleName].config,
            // 用户配置完全覆盖
            ...userModule.config,
            // 确保用户的路由目标完全覆盖
            routeTargets: userModule.config?.routeTargets || {},
            pipelineConfigs: userModule.config?.pipelineConfigs || {}
          }
        };
      } else {
        // 其他模块（如httpserver）：保留关键系统配置，用户配置补充
        moduleConfigs[moduleName] = {
          ...moduleConfigs[moduleName],
          ...userModule,
          config: {
            // 保留系统关键配置（端口、主机等）
            ...this.extractSystemCriticalConfig(moduleConfigs[moduleName].config),
            // 用户配置补充（不覆盖关键配置）
            ...this.extractUserSupplementalConfig(userModule.config)
          }
        };
      }
    }

    return moduleConfigs;
  }

  /**
   * 深度合并对象
   */
  private deepMerge(target: any, source: any): any {
    if (typeof target !== 'object' || target === null) {
      return source;
    }

    if (typeof source !== 'object' || source === null) {
      return target;
    }

    const result = { ...target };

    for (const [key, value] of Object.entries(source)) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        result[key] = this.deepMerge(target[key], value);
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  /**
   * 提取系统基础配置（不包含具体的路由/模型配置）
   */
  private extractSystemBaseConfig(systemConfig: any): any {
    const baseConfig: any = {};
    
    // 只保留基础框架配置，不包含具体的路由目标、模型列表等
    if (systemConfig.moduleType !== undefined) {
      baseConfig.moduleType = systemConfig.moduleType;
    }
    if (systemConfig.enableClassification !== undefined) {
      baseConfig.enableClassification = systemConfig.enableClassification;
    }
    if (systemConfig.classificationConfig !== undefined) {
      // 只保留分类配置框架，不包含具体的模型列表
      baseConfig.classificationConfig = {
        confidenceThreshold: systemConfig.classificationConfig?.confidenceThreshold,
        enableSmartRouting: systemConfig.classificationConfig?.enableSmartRouting,
        protocolMapping: systemConfig.classificationConfig?.protocolMapping
        // 注意：不包含modelTiers和routingDecisions，这些应该由用户配置决定
      };
    }
    if (systemConfig.protocolHandlers !== undefined) {
      baseConfig.protocolHandlers = systemConfig.protocolHandlers;
    }
    
    return baseConfig;
  }

  /**
   * 提取系统关键配置（端口、主机等不应被用户配置覆盖的设置）
   */
  private extractSystemCriticalConfig(systemConfig: any): any {
    const criticalConfig: any = {};
    
    // 保留关键的系统配置，不应被用户配置覆盖
    if (systemConfig.port !== undefined) {
      criticalConfig.port = systemConfig.port;
    }
    if (systemConfig.host !== undefined) {
      criticalConfig.host = systemConfig.host;
    }
    if (systemConfig.cors !== undefined) {
      criticalConfig.cors = systemConfig.cors;
    }
    if (systemConfig.timeout !== undefined) {
      criticalConfig.timeout = systemConfig.timeout;
    }
    if (systemConfig.bodyLimit !== undefined) {
      criticalConfig.bodyLimit = systemConfig.bodyLimit;
    }
    if (systemConfig.enableMetrics !== undefined) {
      criticalConfig.enableMetrics = systemConfig.enableMetrics;
    }
    if (systemConfig.enableHealthChecks !== undefined) {
      criticalConfig.enableHealthChecks = systemConfig.enableHealthChecks;
    }
    if (systemConfig.logging !== undefined) {
      criticalConfig.logging = systemConfig.logging;
    }
    // 保留模块类型等基础设置
    if (systemConfig.moduleType !== undefined) {
      criticalConfig.moduleType = systemConfig.moduleType;
    }
    
    return criticalConfig;
  }

  /**
   * 提取用户补充配置（不包含会覆盖系统关键配置的设置）
   */
  private extractUserSupplementalConfig(userConfig: any): any {
    const supplementalConfig: any = {};
    
    // 只添加用户的补充配置，不覆盖系统关键配置
    for (const [key, value] of Object.entries(userConfig)) {
      // 跳过可能覆盖系统关键配置的键
      if (['port', 'host', 'cors', 'timeout', 'bodyLimit', 'enableMetrics', 'enableHealthChecks', 'logging', 'moduleType'].includes(key)) {
        continue;
      }
      supplementalConfig[key] = value;
    }
    
    return supplementalConfig;
  }

  /**
   * 验证合并配置
   */
  validateMergedConfig(mergedConfig: MergedConfig): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!mergedConfig.modules) {
      errors.push('Missing modules configuration');
      return { isValid: false, errors };
    }

    // 验证必需的模块
    const requiredModules = ['virtualrouter', 'httpserver', 'configmanager'];
    for (const moduleName of requiredModules) {
      if (!mergedConfig.modules[moduleName]) {
        errors.push(\`Missing required module: \${moduleName}\`);
      }
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }
}
`;
  }

  /**
   * 获取配置监听器代码
   */
  private getConfigWatcherCode(): string {
    return `/**
 * Configuration Watcher
 * 配置文件监听器
 */

import { watch, FSWatcher } from 'fs';
import path from 'path';

export class ConfigWatcher {
  private watchers: Map<string, FSWatcher> = new Map();
  private callbacks: Map<string, Function[]> = new Map();

  /**
   * 监听配置文件
   */
  watchFile(filePath: string, callback: Function): void {
    try {
      const watcher = watch(filePath, (eventType) => {
        if (eventType === 'change') {
          console.log(\`📝 Configuration file changed: \${filePath}\`);
          callback(filePath);
        }
      });

      this.watchers.set(filePath, watcher);

      // 添加回调
      if (!this.callbacks.has(filePath)) {
        this.callbacks.set(filePath, []);
      }
      this.callbacks.get(filePath)!.push(callback);

      console.log(\`👀 Started watching: \${filePath}\`);
    } catch (error) {
      console.error(\`Failed to watch file \${filePath}:\`, error);
    }
  }

  /**
   * 停止监听文件
   */
  unwatchFile(filePath: string): void {
    const watcher = this.watchers.get(filePath);
    if (watcher) {
      watcher.close();
      this.watchers.delete(filePath);
      this.callbacks.delete(filePath);
      console.log(\`🛑 Stopped watching: \${filePath}\`);
    }
  }

  /**
   * 停止所有监听
   */
  stopAllWatching(): void {
    for (const [filePath, watcher] of this.watchers) {
      watcher.close();
      console.log(\`🛑 Stopped watching: \${filePath}\`);
    }
    this.watchers.clear();
    this.callbacks.clear();
  }

  /**
   * 触发回调
   */
  private triggerCallbacks(filePath: string): void {
    const callbacks = this.callbacks.get(filePath);
    if (callbacks) {
      for (const callback of callbacks) {
        try {
          callback(filePath);
        } catch (error) {
          console.error(\`Error in config change callback for \${filePath}:\`, error);
        }
      }
    }
  }
}
`;
  }

  /**
   * 获取主入口点代码
   */
  private getMainEntryCode(): string {
    return `/**
 * RouteCodex Main Entry Point
 * Multi-provider OpenAI proxy server with configuration management
 */

import { RouteCodexApp } from './route-codex-app.js';
import { ConfigManagerModule } from './modules/config-manager/config-manager-module.js';

/**
 * Default modules configuration path
 */
function getDefaultModulesConfigPath(): string {
  const possiblePaths = [
    process.env.ROUTECODEX_MODULES_CONFIG,
    './config/modules.json',
    path.join(process.cwd(), 'config', 'modules.json'),
    path.join(homedir(), '.routecodex', 'config', 'modules.json')
  ];

  for (const configPath of possiblePaths) {
    if (configPath && fs.existsSync(configPath)) {
      return configPath;
    }
  }

  return './config/modules.json';
}

/**
 * Main application class
 */
class RouteCodexApp {
  private httpServer: any;
  private configManager: ConfigManagerModule;
  private modulesConfigPath: string;
  private _isRunning: boolean = false;

  constructor(modulesConfigPath?: string) {
    this.modulesConfigPath = modulesConfigPath || getDefaultModulesConfigPath();
    this.configManager = new ConfigManagerModule();
    this.httpServer = null; // 将在初始化时设置
  }

  /**
   * Start the RouteCodex server
   */
  async start(): Promise<void> {
    try {
      console.log('🚀 Starting RouteCodex server...');
      console.log(\`📁 Modules configuration file: \${this.modulesConfigPath}\`);

      // 1. 初始化配置管理器
      const configManagerConfig = {
        configPath: '~/.routecodex/config.json',
        mergedConfigPath: '~/.routecodex/merged-config.json',
        autoReload: true,
        watchInterval: 5000
      };

      await this.configManager.initialize(configManagerConfig);

      // 2. 加载合并后的配置
      const mergedConfig = await this.loadMergedConfig();

      // 3. 初始化HTTP服务器
      const HttpServer = (await import('./server/http-server.js')).HttpServer;
      this.httpServer = new HttpServer(this.modulesConfigPath);

      // 4. 使用合并后的配置初始化服务器
      await this.httpServer.initializeWithMergedConfig(mergedConfig);

      // 5. 启动服务器
      await this.httpServer.start();
      this._isRunning = true;

      // 6. 获取服务器状态
      const status = this.httpServer.getStatus();
      const serverConfig = {
        host: 'localhost',
        port: mergedConfig.modules.httpserver?.config?.port || 5506
      };

      console.log(\`✅ RouteCodex server started successfully!\`);
      console.log(\`🌐 Server URL: http://\${serverConfig.host}:\${serverConfig.port}\`);
      console.log(\`📊 Health check: http://\${serverConfig.host}:\${serverConfig.port}/health\`);
      console.log(\`🔧 Configuration: http://\${serverConfig.host}:\${serverConfig.port}/config\`);
      console.log(\`📖 OpenAI API: http://\${serverConfig.host}:\${serverConfig.port}/v1/openai\`);
      console.log(\`🔬 Anthropic API: http://\${serverConfig.host}:\${serverConfig.port}/v1/anthropic\`);

    } catch (error) {
      console.error('❌ Failed to start RouteCodex server:', error);
      process.exit(1);
    }
  }

  /**
   * Stop the RouteCodex server
   */
  async stop(): Promise<void> {
    try {
      if (this._isRunning) {
        console.log('🛑 Stopping RouteCodex server...');

        if (this.httpServer) {
          await this.httpServer.stop();
        }

        this._isRunning = false;
        console.log('✅ RouteCodex server stopped successfully');
      }
    } catch (error) {
      console.error('❌ Failed to stop RouteCodex server:', error);
      process.exit(1);
    }
  }

  /**
   * Get server status
   */
  getStatus(): any {
    if (this.httpServer) {
      return this.httpServer.getStatus();
    }
    return {
      status: 'stopped',
      message: 'Server not initialized'
    };
  }

  /**
   * Load merged configuration
   */
  private async loadMergedConfig(): Promise<any> {
    try {
      const configPath = path.join(homedir(), '.routecodex', 'merged-config.json');
      const configContent = await fs.readFile(configPath, 'utf-8');
      return JSON.parse(configContent);
    } catch (error) {
      console.error('Failed to load merged configuration:', error);
      throw error;
    }
  }
}

/**
 * Handle graceful shutdown
 */
async function gracefulShutdown(app: RouteCodexApp): Promise<void> {
  console.log('\\n🛑 Received shutdown signal, stopping server gracefully...');
  try {
    await app.stop();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error during graceful shutdown:', error);
    process.exit(1);
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const modulesConfigPath = process.argv[2]; // Allow modules config path as command line argument
  const app = new RouteCodexApp(modulesConfigPath);

  // Setup signal handlers for graceful shutdown
  process.on('SIGTERM', () => gracefulShutdown(app));
  process.on('SIGINT', () => gracefulShutdown(app));

  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    gracefulShutdown(app).catch(() => process.exit(1));
  });

  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    gracefulShutdown(app).catch(() => process.exit(1));
  });

  // Start the server
  await app.start();
}

// Start the application if this file is run directly
if (import.meta.url === \`file://\${process.argv[1]}\`) {
  main().catch((error) => {
    console.error('❌ Failed to start RouteCodex:', error);
    process.exit(1);
  });
}

export { RouteCodexApp, main };
`;
  }

  /**
   * 获取测试用例代码
   */
  private getUserConfigParserTestCode(): string {
    return `/**
 * User Configuration Parser Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { UserConfigParser } from '../../src/config/user-config-parser.js';

describe('UserConfigParser', () => {
  let parser: UserConfigParser;

  beforeEach(() => {
    parser = new UserConfigParser();
  });

  describe('parseRouteTargets', () => {
    it('should parse route targets correctly', () => {
      const routingConfig = {
        default: [
          'openai.gpt-4.sk-xxx',
          'anthropic.claude-3-sonnet.sk-ant-xxx'
        ]
      };

      const result = parser['parseRouteTargets'](routingConfig);

      expect(result).toEqual({
        default: [
          {
            providerId: 'openai',
            modelId: 'gpt-4',
            keyId: 'sk-xxx',
            actualKey: 'sk-xxx',
            inputProtocol: 'openai',
            outputProtocol: 'openai'
          },
          {
            providerId: 'anthropic',
            modelId: 'claude-3-sonnet',
            keyId: 'sk-ant-xxx',
            actualKey: 'sk-ant-xxx',
            inputProtocol: 'openai',
            outputProtocol: 'openai'
          }
        ]
      });
    });
  });

  describe('parsePipelineConfigs', () => {
    it('should parse pipeline configs correctly', () => {
      const virtualRouterConfig = {
        providers: {
          openai: {
            type: 'openai',
            baseURL: 'https://api.openai.com/v1',
            apiKey: ['sk-xxx'],
            models: {
              'gpt-4': {
                maxContext: 128000,
                maxTokens: 32000
              }
            }
          }
        },
        inputProtocol: 'openai',
        outputProtocol: 'openai'
      };

      const result = parser['parsePipelineConfigs'](virtualRouterConfig);

      expect(result).toHaveProperty('openai.gpt-4.sk-xxx');
      expect(result['openai.gpt-4.sk-xxx']).toEqual({
        provider: {
          type: 'openai',
          baseURL: 'https://api.openai.com/v1'
        },
        model: {
          maxContext: 128000,
          maxTokens: 32000
        },
        keyConfig: {
          keyId: 'sk-xxx',
          actualKey: 'sk-xxx'
        },
        protocols: {
          input: 'openai',
          output: 'openai'
        }
      });
    });
  });
});
`;
  }

  /**
   * 获取配置合并器测试代码
   */
  private getConfigMergerTestCode(): string {
    return `/**
 * Configuration Merger Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ConfigMerger } from '../../src/config/config-merger.js';

describe('ConfigMerger', () => {
  let merger: ConfigMerger;

  beforeEach(() => {
    merger = new ConfigMerger();
  });

  describe('mergeConfigs', () => {
    it('should merge system and user configs correctly', () => {
      const systemConfig = {
        modules: {
          httpserver: {
            enabled: true,
            config: {
              moduleType: 'http-server',
              port: 5506,
              host: 'localhost'
            }
          },
          virtualrouter: {
            enabled: true,
            config: {
              moduleType: 'virtual-router',
              timeout: 30000
            }
          }
        }
      };

      const userConfig = {
        virtualrouter: {
          inputProtocol: 'openai',
          outputProtocol: 'openai'
        }
      };

      const parsedUserConfig = {
        routeTargets: {
          default: []
        },
        pipelineConfigs: {},
        moduleConfigs: {
          httpserver: {
            enabled: true,
            config: {
              port: 8080
            }
          }
        }
      };

      const result = merger.mergeConfigs(systemConfig, userConfig, parsedUserConfig);

      expect(result.modules.httpserver.config.port).toBe(8080);
      expect(result.modules.httpserver.config.host).toBe('localhost');
      expect(result.modules.virtualrouter.config.routeTargets).toBeDefined();
    });
  });

  describe('deepMerge', () => {
    it('should merge objects deeply', () => {
      const target = {
        a: 1,
        b: {
          c: 2,
          d: 3
        }
      };

      const source = {
        b: {
          c: 4,
          e: 5
        },
        f: 6
      };

      const result = merger['deepMerge'](target, source);

      expect(result).toEqual({
        a: 1,
        b: {
          c: 4,
          d: 3,
          e: 5
        },
        f: 6
      });
    });
  });
});
`;
  }

  /**
   * 获取虚拟路由测试代码
   */
  private getVirtualRouterTestCode(): string {
    return `/**
 * Virtual Router Module Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VirtualRouterModule } from '../../src/modules/virtual-router/virtual-router-module.js';

describe('VirtualRouterModule', () => {
  let module: VirtualRouterModule;

  beforeEach(() => {
    module = new VirtualRouterModule();
  });

  describe('initialize', () => {
    it('should initialize with valid config', async () => {
      const config = {
        routeTargets: {
          default: [
            {
              providerId: 'openai',
              modelId: 'gpt-4',
              keyId: 'sk-xxx',
              actualKey: 'sk-xxx',
              inputProtocol: 'openai',
              outputProtocol: 'openai'
            }
          ]
        },
        pipelineConfigs: {
          'openai.gpt-4.sk-xxx': {
            provider: {
              type: 'openai',
              baseURL: 'https://api.openai.com/v1'
            },
            model: {
              maxContext: 128000,
              maxTokens: 32000
            },
            keyConfig: {
              keyId: 'sk-xxx',
              actualKey: 'sk-xxx'
            },
            protocols: {
              input: 'openai',
              output: 'openai'
            }
          }
        },
        inputProtocol: 'openai',
        outputProtocol: 'openai',
        timeout: 30000
      };

      await expect(module.initialize(config)).resolves.not.toThrow();
    });
  });

  describe('routeRequest', () => {
    it('should route request to correct target', async () => {
      const config = {
        routeTargets: {
          default: [
            {
              providerId: 'openai',
              modelId: 'gpt-4',
              keyId: 'sk-xxx',
              actualKey: 'sk-xxx',
              inputProtocol: 'openai',
              outputProtocol: 'openai'
            }
          ]
        },
        pipelineConfigs: {
          'openai.gpt-4.sk-xxx': {
            provider: {
              type: 'openai',
              baseURL: 'https://api.openai.com/v1'
            },
            model: {
              maxContext: 128000,
              maxTokens: 32000
            },
            keyConfig: {
              keyId: 'sk-xxx',
              actualKey: 'sk-xxx'
            },
            protocols: {
              input: 'openai',
              output: 'openai'
            }
          }
        },
        inputProtocol: 'openai',
        outputProtocol: 'openai',
        timeout: 30000
      };

      await module.initialize(config);

      const request = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello' }]
      };

      const response = await module.routeRequest(request, 'default');

      expect(response).toBeDefined();
      expect(response.object).toBe('chat.completion');
    });
  });
});
`;
  }

  /**
   * 获取合并配置类型定义代码
   */
  private getMergedConfigTypesCode(): string {
    return `/**
 * Merged Configuration Types
 * 合并配置类型定义 - 支持虚拟路由系统的完整类型定义
 */

/**
 * 路由目标接口
 */
export interface RouteTarget {
  providerId: string;
  modelId: string;
  keyId: string;
  actualKey: string;
  inputProtocol: 'openai' | 'anthropic';
  outputProtocol: 'openai' | 'anthropic';
}

/**
 * 路由目标池
 */
export interface RouteTargetPool {
  [routeName: string]: RouteTarget[];
}

/**
 * 流水线配置
 */
export interface PipelineConfig {
  provider: {
    type: string;
    baseURL: string;
  };
  model: {
    maxContext: number;
    maxTokens: number;
  };
  keyConfig: {
    keyId: string;
    actualKey: string;
  };
  protocols: {
    input: 'openai' | 'anthropic';
    output: 'openai' | 'anthropic';
  };
}

/**
 * 流水线配置集合
 */
export interface PipelineConfigs {
  [providerModelKey: string]: PipelineConfig;
}

/**
 * 虚拟路由模块配置
 */
export interface VirtualRouterConfig {
  moduleType: 'virtual-router';
  routeTargets: RouteTargetPool;
  pipelineConfigs: PipelineConfigs;
  inputProtocol: 'openai' | 'anthropic';
  outputProtocol: 'openai' | 'anthropic';
  timeout: number;
  userConfigDefaults?: {
    maxContext: number;
    maxTokens: number;
  };
}

/**
 * HTTP服务器模块配置
 */
export interface HttpServerConfig {
  moduleType: 'http-server';
  port: number;
  host: string;
  cors?: {
    origin: string | string[];
    credentials: boolean;
  };
  timeout?: number;
  bodyLimit?: string;
  enableMetrics?: boolean;
  enableHealthChecks?: boolean;
}

/**
 * 配置管理模块配置
 */
export interface ConfigManagerConfig {
  moduleType: 'config-manager';
  configPath: string;
  mergedConfigPath: string;
  autoReload: boolean;
  watchInterval: number;
}

/**
 * 调试中心模块配置
 */
export interface DebugCenterConfig {
  moduleType: 'debug-center';
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  enableConsole: boolean;
  enableFile: boolean;
  eventQueueSize?: number;
  filePath?: string;
}

/**
 * 通用模块配置
 */
export interface ModuleConfig {
  enabled: boolean;
  config: VirtualRouterConfig | HttpServerConfig | ConfigManagerConfig | DebugCenterConfig | any;
}

/**
 * 模块配置集合
 */
export interface ModuleConfigs {
  [moduleName: string]: ModuleConfig;
}

/**
 * 用户配置接口 - 兼容现有 ~/.routecodex/config.json 格式
 */
export interface UserConfig {
  version?: string;
  description?: string;
  user?: {
    name: string;
    email: string;
  };
  virtualrouter: {
    inputProtocol: 'openai' | 'anthropic';
    outputProtocol: 'openai' | 'anthropic';
    providers: Record<string, {
      type: string;
      baseURL: string;
      apiKey: string[];
      models: Record<string, {
        maxContext?: number;
        maxTokens?: number;
      }>;
    }>;
    routing: Record<string, string[]>;
  };
  httpserver?: {
    port?: number;
    host?: string;
    cors?: {
      origin?: string | string[];
      credentials?: boolean;
    };
    timeout?: number;
    bodyLimit?: string;
  };
  debugcenter?: {
    logLevel?: string;
    enableConsole?: boolean;
    enableFile?: boolean;
  };
  configmanager?: {
    mergedConfigPath?: string;
    autoReload?: boolean;
    watchInterval?: number;
  };
  [key: string]: any;
}

/**
 * 系统配置接口 - 兼容现有 ./config/modules.json 格式
 */
export interface ModulesConfig {
  modules: Record<string, ModuleConfig>;
}

/**
 * 合并后的配置接口
 */
export interface MergedConfig {
  version: string;
  mergedAt: string;
  modules: ModuleConfigs;
}

/**
 * 配置解析结果
 */
export interface ConfigParseResult {
  routeTargets: RouteTargetPool;
  pipelineConfigs: PipelineConfigs;
  moduleConfigs: ModuleConfigs;
}

/**
 * 配置验证结果
 */
export interface ConfigValidationResult {
  isValid: boolean;
  errors: string[];
  warnings?: string[];
  config?: MergedConfig;
}

/**
 * 协议转换器接口
 */
export interface ProtocolConverter {
  convertRequest(request: any): Promise<any>;
  convertResponse(response: any): Promise<any>;
}

/**
 * 负载均衡器接口
 */
export interface LoadBalancer {
  selectTarget(targets: RouteTarget[]): Promise<RouteTarget | null>;
  updateMetrics(targetId: string, success: boolean): void;
  getStatus(): any;
}

/**
 * 密钥解析器接口
 */
export interface KeyResolver {
  resolveKey(keyId: string): Promise<string>;
  resolveKeys(keyIds: string[]): Promise<Map<string, string>>;
  clearCache(): void;
}
`;
  }
}
