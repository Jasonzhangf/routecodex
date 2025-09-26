/**
 * Simple Log Configuration CLI
 *
 * 提供一键开启简化日志功能的CLI命令
 */

import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import { getGlobalLoggerFactory } from '../logging/LoggerFactory.js';
import { LogLevel } from '../logging/types.js';

const logger = {
  info: (msg: string) => console.log(`${chalk.blue('ℹ')} ${msg}`),
  success: (msg: string) => console.log(`${chalk.green('✓')} ${msg}`),
  warning: (msg: string) => console.log(`${chalk.yellow('⚠')} ${msg}`),
  error: (msg: string) => console.log(`${chalk.red('✗')} ${msg}`),
};

// 简单的日志配置文件路径
function getSimpleLogConfigPath(): string {
  return path.join(homedir(), '.routecodex', 'simple-log-config.json');
}

// 简单的日志配置接口
interface SimpleLogConfig {
  enabled: boolean;
  logLevel: LogLevel;
  output: 'console' | 'file' | 'both';
  logDirectory?: string;
  autoStart: boolean;
}

// 默认配置
const DEFAULT_SIMPLE_CONFIG: SimpleLogConfig = {
  enabled: false,
  logLevel: LogLevel.INFO,
  output: 'console',
  logDirectory: path.join(homedir(), '.routecodex', 'logs'),
  autoStart: true,
};

// 加载配置
function loadSimpleConfig(): SimpleLogConfig {
  const configPath = getSimpleLogConfigPath();

  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_SIMPLE_CONFIG };
  }

  try {
    const configData = fs.readFileSync(configPath, 'utf-8');
    return { ...DEFAULT_SIMPLE_CONFIG, ...JSON.parse(configData) };
  } catch (error) {
    logger.warning('配置文件损坏，使用默认配置');
    return { ...DEFAULT_SIMPLE_CONFIG };
  }
}

// 保存配置
function saveSimpleConfig(config: SimpleLogConfig): void {
  const configPath = getSimpleLogConfigPath();
  const configDir = path.dirname(configPath);

  // 确保目录存在
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (error) {
    logger.error(`保存配置文件失败: ${error}`);
    throw error;
  }
}

/**
 * 创建简单日志配置命令
 */
export function createSimpleLogCommand(): Command {
  const simpleLog = new Command('simple-log')
    .description('简单的日志配置和管理（一键开启/关闭）')
    .addHelpText(
      'after',
      `
示例:
  # 一键开启简单日志
  routecodex simple-log on
  
  # 一键关闭简单日志
  routecodex simple-log off
  
  # 查看当前状态
  routecodex simple-log status
  
  # 设置日志级别为debug
  routecodex simple-log level debug
  
  # 同时输出到文件
  routecodex simple-log output both
`
    );

  // 一键开启命令
  simpleLog
    .command('on')
    .description('一键开启简单日志功能')
    .option('-l, --level <level>', '日志级别 (error|warn|info|debug)', 'info')
    .option('-o, --output <output>', '输出方式 (console|file|both)', 'console')
    .action(options => {
      const config = loadSimpleConfig();

      config.enabled = true;
      config.logLevel = (options.level as LogLevel) || LogLevel.INFO;
      config.output = options.output || 'console';

      // 验证日志级别
      const validLevels = [LogLevel.ERROR, LogLevel.WARN, LogLevel.INFO, LogLevel.DEBUG];
      if (!validLevels.includes(config.logLevel)) {
        logger.error(`无效的日志级别: ${options.level}`);
        logger.info(`有效级别: ${validLevels.join(', ')}`);
        return;
      }

      // 验证输出方式
      const validOutputs = ['console', 'file', 'both'];
      if (!validOutputs.includes(config.output)) {
        logger.error(`无效的输出方式: ${options.output}`);
        logger.info(`有效方式: ${validOutputs.join(', ')}`);
        return;
      }

      saveSimpleConfig(config);

      logger.success('✨ 简单日志功能已开启！');
      logger.info(`日志级别: ${chalk.cyan(config.logLevel)}`);
      logger.info(`输出方式: ${chalk.cyan(config.output)}`);

      if (config.output === 'file' || config.output === 'both') {
        logger.info(`日志目录: ${chalk.cyan(config.logDirectory)}`);
      }

      logger.info('\n💡 提示: 日志将在下次运行时生效');
      logger.info('   使用 "routecodex simple-log off" 可以随时关闭');
    });

  // 一键关闭命令
  simpleLog
    .command('off')
    .description('一键关闭简单日志功能')
    .action(() => {
      const config = loadSimpleConfig();

      if (!config.enabled) {
        logger.info('简单日志功能当前已经关闭');
        return;
      }

      config.enabled = false;
      saveSimpleConfig(config);

      logger.success('🛑 简单日志功能已关闭！');
      logger.info('日志输出将恢复为系统默认设置');
      logger.info('\n💡 提示: 使用 "routecodex simple-log on" 可以重新开启');
    });

  // 查看状态命令
  simpleLog
    .command('status')
    .description('查看简单日志的当前状态')
    .action(() => {
      const config = loadSimpleConfig();

      console.log(`\n${chalk.bold.blue('📊 简单日志状态')}`);
      console.log('═'.repeat(30));

      console.log(
        `启用状态: ${config.enabled ? chalk.green('✅ 已开启') : chalk.red('❌ 已关闭')}`
      );
      console.log(`日志级别: ${chalk.cyan(config.logLevel)}`);
      console.log(`输出方式: ${chalk.cyan(config.output)}`);

      if (config.output === 'file' || config.output === 'both') {
        console.log(`日志目录: ${chalk.cyan(config.logDirectory)}`);
      }

      console.log(`自动启动: ${config.autoStart ? chalk.green('是') : chalk.yellow('否')}`);

      console.log(`\n${chalk.gray('配置文件位置:')}`);
      console.log(chalk.gray(getSimpleLogConfigPath()));

      if (config.enabled) {
        console.log(`\n${chalk.green('💡 日志功能正在运行中')}`);
        console.log(chalk.green('   除非主动关闭，否则会一直保持开启状态'));
      }
    });

  // 设置日志级别
  simpleLog
    .command('level <level>')
    .description('设置日志级别')
    .action(level => {
      const config = loadSimpleConfig();

      const validLevels = [LogLevel.ERROR, LogLevel.WARN, LogLevel.INFO, LogLevel.DEBUG];
      if (!validLevels.includes(level as LogLevel)) {
        logger.error(`无效的日志级别: ${level}`);
        logger.info(`有效级别: ${validLevels.join(', ')}`);
        return;
      }

      config.logLevel = level as LogLevel;
      saveSimpleConfig(config);

      logger.success(`日志级别已设置为: ${chalk.cyan(level)}`);
      logger.info('设置将在下次运行时生效');
    });

  // 设置输出方式
  simpleLog
    .command('output <output>')
    .description('设置日志输出方式')
    .action(output => {
      const config = loadSimpleConfig();

      const validOutputs = ['console', 'file', 'both'];
      if (!validOutputs.includes(output)) {
        logger.error(`无效的输出方式: ${output}`);
        logger.info(`有效方式: ${validOutputs.join(', ')}`);
        return;
      }

      config.output = output;
      saveSimpleConfig(config);

      logger.success(`输出方式已设置为: ${chalk.cyan(output)}`);

      if (output === 'file' || output === 'both') {
        logger.info(`日志将保存到: ${chalk.cyan(config.logDirectory)}`);
      }

      logger.info('设置将在下次运行时生效');
    });

  // 显示帮助
  simpleLog
    .command('help')
    .description('显示帮助信息')
    .action(() => {
      simpleLog.help();
    });

  return simpleLog;
}
