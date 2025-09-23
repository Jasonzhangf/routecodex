/**
 * Config Manager Module
 * 配置管理模块 - 管理配置文件和重载
 */

import fs from 'fs/promises';
import { homedir } from 'os';
import { BaseModule } from '../../core/base-module.js';
import { UserConfigParser } from '../../config/user-config-parser.js';
import { ConfigMerger } from '../../config/config-merger.js';
import { AuthFileResolver } from '../../config/auth-file-resolver.js';
import type {
  ModulesConfig,
  UserConfig,
  MergedConfig
} from '../../config/merged-config-types.js';

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
  async initialize(config?: any): Promise<void> {
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
        throw new Error(`Configuration validation failed: ${validation.errors.join(', ')}`);
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
      console.error(`Failed to load system config from ${this.systemConfigPath}:`, error);
      throw error;
    }
  }

  /**
   * 加载用户配置
   */
  private async loadUserConfig(): Promise<any> {
    try {
      // 展开路径中的 ~ 符号
      const expandedPath = this.configPath.startsWith('~')
        ? this.configPath.replace('~', homedir())
        : this.configPath;

      const configContent = await fs.readFile(expandedPath, 'utf-8');
      return JSON.parse(configContent);
    } catch (error) {
      console.error(`Failed to load user config from ${this.configPath}:`, error);
      throw error;
    }
  }

  /**
   * 保存合并配置
   */
  private async saveMergedConfig(mergedConfig: any): Promise<void> {
    try {
      // 展开路径中的 ~ 符号
      const expandedPath = this.mergedConfigPath.startsWith('~')
        ? this.mergedConfigPath.replace('~', homedir())
        : this.mergedConfigPath;

      const configDir = expandedPath.split('/').slice(0, -1).join('/');
      await fs.mkdir(configDir, { recursive: true });

      const configContent = JSON.stringify(mergedConfig, null, 2);
      await fs.writeFile(expandedPath, configContent, 'utf-8');

      console.log(`💾 Merged configuration saved to ${this.mergedConfigPath}`);
    } catch (error) {
      console.error(`Failed to save merged config to ${this.mergedConfigPath}:`, error);
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
