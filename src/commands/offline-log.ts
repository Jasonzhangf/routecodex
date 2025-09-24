/**
 * Offline Log CLI Commands
 *
 * CLI interface for configuring and managing offline log capture:
 * - Module-level offline logging
 * - Pipeline-level offline logging
 * - Log file management
 * - Offline analysis and reporting
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import { UnifiedModuleLogger } from '../logging/UnifiedLogger.js';
import { JsonlLogParser } from '../logging/parser/JsonlParser.js';
import { LogFileScanner } from '../logging/parser/LogFileScanner.js';
import { DebugFileLogger } from '../debug/debug-file-logger.js';
import { TimeSeriesIndexEngine } from '../logging/indexer/TimeSeriesIndexer.js';

// Logger for consistent output
const logger = {
  info: (msg: string) => console.log(chalk.blue('ℹ') + ' ' + msg),
  success: (msg: string) => console.log(chalk.green('✓') + ' ' + msg),
  warning: (msg: string) => console.log(chalk.yellow('⚠') + ' ' + msg),
  error: (msg: string) => console.log(chalk.red('✗') + ' ' + msg),
  debug: (msg: string) => console.log(chalk.gray('◉') + ' ' + msg)
};

// File format utilities
function ensureDirectoryExists(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function resolvePath(filePath: string): string {
  if (filePath.startsWith('~')) {
    return path.join(homedir(), filePath.slice(1));
  }
  return path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
}

// Configuration management
interface OfflineLogConfig {
  enabled: boolean;
  logDirectory: string;
  logLevel: 'minimal' | 'normal' | 'detailed' | 'verbose';
  maxFileSize: number;
  maxFiles: number;
  enableCompression: boolean;
  modules: Record<string, ModuleLogConfig>;
  pipeline: PipelineLogConfig;
}

interface ModuleLogConfig {
  enabled: boolean;
  logLevel: 'minimal' | 'normal' | 'detailed' | 'verbose';
  includePerformance: boolean;
  includeStackTraces: boolean;
  sensitiveFields: string[];
}

interface PipelineLogConfig {
  enabled: boolean;
  logLevel: 'minimal' | 'normal' | 'detailed' | 'verbose';
  captureRequests: boolean;
  captureResponses: boolean;
  captureErrors: boolean;
  capturePerformance: boolean;
}

const DEFAULT_OFFLINE_CONFIG: OfflineLogConfig = {
  enabled: false,
  logDirectory: '~/.routecodex/logs',
  logLevel: 'normal',
  maxFileSize: 50 * 1024 * 1024, // 50MB
  maxFiles: 10,
  enableCompression: true,
  modules: {},
  pipeline: {
    enabled: false,
    logLevel: 'normal',
    captureRequests: true,
    captureResponses: true,
    captureErrors: true,
    capturePerformance: true
  }
};

function getConfigPath(): string {
  return path.join(homedir(), '.routecodex', 'offline-log-config.json');
}

function loadConfig(): OfflineLogConfig {
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (error) {
      logger.warning(`Invalid config file, using defaults: ${error}`);
      return { ...DEFAULT_OFFLINE_CONFIG };
    }
  }
  return { ...DEFAULT_OFFLINE_CONFIG };
}

function saveConfig(config: OfflineLogConfig): void {
  const configPath = getConfigPath();
  ensureDirectoryExists(path.dirname(configPath));
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// Offline log command
export function createOfflineLogCommand(): Command {
  const offlineLog = new Command('offline-log')
    .alias('olog')
    .description('Configure and manage offline log capture for modules and pipeline')
    .addHelpText('after', `
Examples:
  # Enable offline logging for all modules
  routecodex offline-log enable --all-modules
  
  # Configure specific module logging
  routecodex offline-log module --name processor --level detailed --performance
  
  # Enable pipeline logging
  routecodex offline-log pipeline --enable --capture-requests --capture-responses
  
  # Analyze captured logs
  routecodex offline-log analyze --directory ./logs --output report.html
  
  # Generate time series analysis
  routecodex offline-log timeseries --start 2024-01-01 --end 2024-01-02
  
  # List configured modules
  routecodex offline-log list
  
  # Show current configuration
  routecodex offline-log config show
  
  # Reset to defaults
  routecodex offline-log config reset
`);

  // Enable/disable offline logging
  offlineLog
    .command('enable')
    .description('Enable offline logging')
    .option('--all-modules', 'Enable for all modules')
    .option('--pipeline', 'Enable for pipeline')
    .option('--level <level>', 'Log level (minimal, normal, detailed, verbose)', 'normal')
    .option('--directory <dir>', 'Log directory', '~/.routecodex/logs')
    .option('--max-size <size>', 'Max file size in MB', '50')
    .option('--max-files <files>', 'Max number of log files', '10')
    .option('--compression', 'Enable compression')
    .action(async (options) => {
      const spinner = ora('Enabling offline logging...').start();
      
      try {
        const config = loadConfig();
        config.enabled = true;
        config.logDirectory = resolvePath(options.directory);
        config.logLevel = options.level as any;
        config.maxFileSize = parseInt(options.maxSize) * 1024 * 1024;
        config.maxFiles = parseInt(options.maxFiles);
        config.enableCompression = options.compression || false;
        
        if (options.allModules) {
          config.modules = { '*': { 
            enabled: true, 
            logLevel: config.logLevel,
            includePerformance: true,
            includeStackTraces: false,
            sensitiveFields: []
          }};
        }
        
        if (options.pipeline) {
          config.pipeline.enabled = true;
          config.pipeline.logLevel = config.logLevel;
        }
        
        ensureDirectoryExists(config.logDirectory);
        saveConfig(config);
        
        spinner.succeed('Offline logging enabled successfully');
        logger.info(`Log directory: ${config.logDirectory}`);
        logger.info(`Log level: ${config.logLevel}`);
        logger.info(`Max file size: ${options.maxSize}MB`);
        logger.info(`Max files: ${options.maxFiles}`);
        
      } catch (error) {
        spinner.fail('Failed to enable offline logging');
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  // Disable offline logging
  offlineLog
    .command('disable')
    .description('Disable offline logging')
    .action(async () => {
      const spinner = ora('Disabling offline logging...').start();
      
      try {
        const config = loadConfig();
        config.enabled = false;
        saveConfig(config);
        
        spinner.succeed('Offline logging disabled successfully');
        
      } catch (error) {
        spinner.fail('Failed to disable offline logging');
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  // Configure module logging
  offlineLog
    .command('module')
    .description('Configure logging for a specific module')
    .requiredOption('--name <name>', 'Module name')
    .option('--enable', 'Enable logging for this module')
    .option('--disable', 'Disable logging for this module')
    .option('--level <level>', 'Log level (minimal, normal, detailed, verbose)', 'normal')
    .option('--performance', 'Include performance metrics')
    .option('--stack-traces', 'Include stack traces')
    .option('--sensitive <fields>', 'Sensitive fields to redact (comma-separated)')
    .action(async (options) => {
      const spinner = ora(`Configuring module ${options.name}...`).start();
      
      try {
        const config = loadConfig();
        
        if (!config.modules[options.name]) {
          config.modules[options.name] = {
            enabled: false,
            logLevel: 'normal',
            includePerformance: false,
            includeStackTraces: false,
            sensitiveFields: []
          };
        }
        
        const moduleConfig = config.modules[options.name];
        
        if (options.enable) moduleConfig.enabled = true;
        if (options.disable) moduleConfig.enabled = false;
        if (options.level) moduleConfig.logLevel = options.level as any;
        if (options.performance) moduleConfig.includePerformance = true;
        if (options.stackTraces) moduleConfig.includeStackTraces = true;
        if (options.sensitive) {
          moduleConfig.sensitiveFields = options.sensitive.split(',').map((s: string) => s.trim());
        }
        
        saveConfig(config);
        
        spinner.succeed(`Module ${options.name} configured successfully`);
        logger.info(`Enabled: ${moduleConfig.enabled}`);
        logger.info(`Log level: ${moduleConfig.logLevel}`);
        logger.info(`Performance: ${moduleConfig.includePerformance}`);
        logger.info(`Stack traces: ${moduleConfig.includeStackTraces}`);
        
      } catch (error) {
        spinner.fail(`Failed to configure module ${options.name}`);
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  // Configure pipeline logging
  offlineLog
    .command('pipeline')
    .description('Configure pipeline-level logging')
    .option('--enable', 'Enable pipeline logging')
    .option('--disable', 'Disable pipeline logging')
    .option('--level <level>', 'Log level (minimal, normal, detailed, verbose)', 'normal')
    .option('--capture-requests', 'Capture request data')
    .option('--no-capture-requests', 'Do not capture request data')
    .option('--capture-responses', 'Capture response data')
    .option('--no-capture-responses', 'Do not capture response data')
    .option('--capture-errors', 'Capture error data')
    .option('--no-capture-errors', 'Do not capture error data')
    .option('--capture-performance', 'Capture performance metrics')
    .option('--no-capture-performance', 'Do not capture performance metrics')
    .action(async (options) => {
      const spinner = ora('Configuring pipeline logging...').start();
      
      try {
        const config = loadConfig();
        
        if (options.enable) config.pipeline.enabled = true;
        if (options.disable) config.pipeline.enabled = false;
        if (options.level) config.pipeline.logLevel = options.level as any;
        
        // Handle capture options
        if (options.captureRequests !== undefined) {
          config.pipeline.captureRequests = options.captureRequests;
        }
        if (options.captureResponses !== undefined) {
          config.pipeline.captureResponses = options.captureResponses;
        }
        if (options.captureErrors !== undefined) {
          config.pipeline.captureErrors = options.captureErrors;
        }
        if (options.capturePerformance !== undefined) {
          config.pipeline.capturePerformance = options.capturePerformance;
        }
        
        saveConfig(config);
        
        spinner.succeed('Pipeline logging configured successfully');
        logger.info(`Enabled: ${config.pipeline.enabled}`);
        logger.info(`Log level: ${config.pipeline.logLevel}`);
        logger.info(`Capture requests: ${config.pipeline.captureRequests}`);
        logger.info(`Capture responses: ${config.pipeline.captureResponses}`);
        logger.info(`Capture errors: ${config.pipeline.captureErrors}`);
        logger.info(`Capture performance: ${config.pipeline.capturePerformance}`);
        
      } catch (error) {
        spinner.fail('Failed to configure pipeline logging');
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  // Analyze captured logs
  offlineLog
    .command('analyze')
    .description('Analyze captured offline logs')
    .requiredOption('--directory <dir>', 'Log directory to analyze')
    .option('--output <file>', 'Output file for analysis results')
    .option('--format <format>', 'Output format (json, html, csv)', 'json')
    .option('--modules <modules>', 'Specific modules to analyze (comma-separated)')
    .option('--start <date>', 'Start date (ISO format)')
    .option('--end <date>', 'End date (ISO format)')
    .option('--level <level>', 'Minimum log level to include')
    .action(async (options) => {
      const spinner = ora('Analyzing logs...').start();
      
      try {
        const logDir = resolvePath(options.directory);
        
        if (!fs.existsSync(logDir)) {
          throw new Error(`Log directory not found: ${logDir}`);
        }
        
        // 扫描日志文件
        const scanner = new LogFileScanner({
          scanDirectory: logDir,
          moduleIds: options.modules ? options.modules.split(',').map((s: string) => s.trim()) : undefined,
          timeRange: options.start && options.end ? {
            start: new Date(options.start).getTime(),
            end: new Date(options.end).getTime()
          } : undefined,
          includeCompressed: true
        });
        const scanResult = await scanner.scan();
        
        spinner.text = `Found ${scanResult.totalFiles} log files, parsing...`;
        
        // 解析日志文件
        const parser = new JsonlLogParser();
        const allEntries = [];
        
        for (const fileInfo of scanResult.files) {
          const entries = await parser.parseFile(fileInfo.filePath);
          allEntries.push(...entries);
        }
        
        spinner.text = `Parsed ${allEntries.length} entries, analyzing...`;
        
        // 分析数据
        const analysis = analyzeLogEntries(allEntries, options);
        
        // 输出结果
        const outputFile = options.output || `./analysis-${Date.now()}.${options.format}`;
        
        switch (options.format) {
          case 'json':
            fs.writeFileSync(outputFile, JSON.stringify(analysis, null, 2));
            break;
          case 'html':
            await generateHTMLReport(analysis, outputFile);
            break;
          case 'csv':
            await generateCSVReport(analysis, outputFile);
            break;
        }
        
        spinner.succeed(`Analysis completed, results saved to: ${outputFile}`);
        logger.info(`Total entries analyzed: ${analysis.totalEntries}`);
        logger.info(`Module count: ${Object.keys(analysis.moduleStats).length}`);
        logger.info(`Error count: ${analysis.errorStats.total}`);
        
      } catch (error) {
        spinner.fail('Failed to analyze logs');
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  // Time series analysis
  offlineLog
    .command('timeseries')
    .description('Perform time series analysis on captured logs')
    .requiredOption('--directory <dir>', 'Log directory to analyze')
    .option('--output <file>', 'Output file for analysis results')
    .option('--start <date>', 'Start date (ISO format)')
    .option('--end <date>', 'End date (ISO format)')
    .option('--bucket <size>', 'Time bucket size in minutes', '5')
    .option('--modules <modules>', 'Specific modules to analyze (comma-separated)')
    .action(async (options) => {
      const spinner = ora('Performing time series analysis...').start();
      
      try {
        const logDir = resolvePath(options.directory);
        const bucketSize = parseInt(options.bucket) * 60000; // Convert to milliseconds
        
        // 扫描日志文件
        const scanner = new LogFileScanner({
          scanDirectory: logDir,
          moduleIds: options.modules ? options.modules.split(',').map((s: string) => s.trim()) : undefined,
          timeRange: options.start && options.end ? {
            start: new Date(options.start).getTime(),
            end: new Date(options.end).getTime()
          } : undefined,
          includeCompressed: true
        });
        const scanResult = await scanner.scan();
        
        // 创建时间序列索引
        const indexer = new TimeSeriesIndexEngine({
          name: 'offline-analysis',
          shardInterval: bucketSize,
          enableCompression: true
        });
        
        spinner.text = 'Indexing log files...';
        // 读取日志文件并添加到索引
        const allLogs: any[] = [];
        for (const fileInfo of scanResult.files) {
          const parser = new JsonlLogParser();
          const entries = await parser.parseFile(fileInfo.filePath);
          allLogs.push(...entries);
        }
        await indexer.index(allLogs);
        
        // 查询数据
        const query = {
          timeRange: options.start && options.end ? {
            start: new Date(options.start).getTime(),
            end: new Date(options.end).getTime()
          } : undefined,
          filters: {
            moduleIds: options.modules ? options.modules.split(',').map((s: string) => s.trim()) : undefined
          }
        };
        
        spinner.text = 'Querying time series data...';
        const results = await indexer.query(query);
        
        // 生成时间序列数据 - 适配不同的返回格式
        let logEntries: any[] = [];
        if (Array.isArray(results)) {
          logEntries = results;
        } else if (results && typeof results === 'object' && 'entries' in results) {
          logEntries = (results as any).entries || [];
        } else if (results && typeof results === 'object') {
          // 假设结果是直接的条目数组
          logEntries = Object.values(results).flat() as any[];
        }
        const timeSeriesData = generateTimeSeriesData(logEntries, bucketSize);
        
        const analysis = {
          metadata: {
            startDate: options.start,
            endDate: options.end,
            bucketSize: parseInt(options.bucket),
            totalBuckets: timeSeriesData.length,
            modules: options.modules ? options.modules.split(',') : 'all'
          },
          timeSeries: timeSeriesData,
          summary: generateTimeSeriesSummary(timeSeriesData)
        };
        
        // 输出结果
        const outputFile = options.output || `./timeseries-${Date.now()}.json`;
        fs.writeFileSync(outputFile, JSON.stringify(analysis, null, 2));
        
        spinner.succeed(`Time series analysis completed, results saved to: ${outputFile}`);
        logger.info(`Total time buckets: ${timeSeriesData.length}`);
        logger.info(`Peak activity: ${analysis.summary.peakActivity.bucket} (${analysis.summary.peakActivity.count} events)`);
        logger.info(`Average activity: ${analysis.summary.avgActivity.toFixed(2)} events/bucket`);
        
      } catch (error) {
        spinner.fail('Failed to perform time series analysis');
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  // List configured modules
  offlineLog
    .command('list')
    .description('List configured modules and their logging status')
    .action(async () => {
      try {
        const config = loadConfig();
        
        console.log(chalk.cyan('\nOffline Logging Configuration:'));
        console.log('=' .repeat(50));
        console.log(`Enabled: ${config.enabled ? chalk.green('Yes') : chalk.red('No')}`);
        console.log(`Log Directory: ${config.logDirectory}`);
        console.log(`Log Level: ${config.logLevel}`);
        console.log(`Max File Size: ${(config.maxFileSize / 1024 / 1024).toFixed(0)}MB`);
        console.log(`Max Files: ${config.maxFiles}`);
        console.log(`Compression: ${config.enableCompression ? 'Enabled' : 'Disabled'}`);
        
        if (config.pipeline.enabled) {
          console.log(chalk.cyan('\nPipeline Logging:'));
          console.log(`  Enabled: ${chalk.green('Yes')}`);
          console.log(`  Log Level: ${config.pipeline.logLevel}`);
          console.log(`  Capture Requests: ${config.pipeline.captureRequests ? 'Yes' : 'No'}`);
          console.log(`  Capture Responses: ${config.pipeline.captureResponses ? 'Yes' : 'No'}`);
          console.log(`  Capture Errors: ${config.pipeline.captureErrors ? 'Yes' : 'No'}`);
          console.log(`  Capture Performance: ${config.pipeline.capturePerformance ? 'Yes' : 'No'}`);
        }
        
        if (Object.keys(config.modules).length > 0) {
          console.log(chalk.cyan('\nModule Logging:'));
          for (const [moduleName, moduleConfig] of Object.entries(config.modules)) {
            console.log(`\n  ${moduleName}:`);
            console.log(`    Enabled: ${moduleConfig.enabled ? chalk.green('Yes') : chalk.red('No')}`);
            console.log(`    Log Level: ${moduleConfig.logLevel}`);
            console.log(`    Performance: ${moduleConfig.includePerformance ? 'Yes' : 'No'}`);
            console.log(`    Stack Traces: ${moduleConfig.includeStackTraces ? 'Yes' : 'No'}`);
            if (moduleConfig.sensitiveFields.length > 0) {
              console.log(`    Sensitive Fields: ${moduleConfig.sensitiveFields.join(', ')}`);
            }
          }
        }
        
      } catch (error) {
        logger.error('Failed to list configuration: ' + (error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  // Configuration management
  const configCmd = offlineLog
    .command('config')
    .description('Manage offline logging configuration');

  configCmd
    .command('show')
    .description('Show current configuration')
    .action(async () => {
      try {
        const config = loadConfig();
        console.log(chalk.cyan('Current Configuration:'));
        console.log(JSON.stringify(config, null, 2));
      } catch (error) {
        logger.error('Failed to show configuration: ' + (error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  configCmd
    .command('reset')
    .description('Reset configuration to defaults')
    .action(async () => {
      const spinner = ora('Resetting configuration...').start();
      
      try {
        saveConfig({ ...DEFAULT_OFFLINE_CONFIG });
        spinner.succeed('Configuration reset to defaults');
      } catch (error) {
        spinner.fail('Failed to reset configuration');
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  return offlineLog;
}

// Helper functions
function analyzeLogEntries(entries: any[], options: any) {
  const moduleStats: Record<string, { count: number; errors: number; avgDuration: number; durations: number[] }> = {};
  const errorStats = { total: 0, byType: {} as Record<string, number> };
  const levelStats = {} as Record<string, number>;
  
  entries.forEach((entry: any) => {
    // 模块统计
    const moduleId = entry.moduleId || entry.context?.moduleId || 'unknown';
    if (!moduleStats[moduleId]) {
      moduleStats[moduleId] = { count: 0, errors: 0, avgDuration: 0, durations: [] };
    }
    moduleStats[moduleId].count++;
    
    // 级别统计
    const level = entry.level || entry.logLevel || 'info';
    levelStats[level] = (levelStats[level] || 0) + 1;
    
    // 错误统计
    if (level === 'error' || entry.level === 'ERROR') {
      errorStats.total++;
      moduleStats[moduleId].errors++;
      
      const errorType = entry.data?.errorType || entry.data?.type || 'unknown';
      errorStats.byType[errorType] = (errorStats.byType[errorType] || 0) + 1;
    }
    
    // 性能统计
    const duration = entry.data?.duration || entry.data?.processingTime || entry.metrics?.duration;
    if (duration && typeof duration === 'number') {
      moduleStats[moduleId].durations.push(duration);
    }
  });
  
  Object.values(moduleStats).forEach((stats: { durations: number[]; avgDuration: number }) => {
      if (stats.durations.length > 0) {
        stats.avgDuration = stats.durations.reduce((a: number, b: number) => a + b, 0) / stats.durations.length;
        (stats as any).durations = undefined; // 清理临时数据
      }
    });
  
  return {
    totalEntries: entries.length,
    moduleStats,
    errorStats,
    levelStats,
    timeRange: {
      start: Math.min(...entries.map((e: any) => e.timestamp || e.time || Date.now())),
      end: Math.max(...entries.map((e: any) => e.timestamp || e.time || Date.now()))
    }
  };
}

async function generateHTMLReport(analysis: any, outputFile: string): Promise<void> {
  const html = `
<!DOCTYPE html>
<html>
<head>
    <title>RouteCodex Offline Log Analysis Report</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .header { text-align: center; margin-bottom: 30px; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px; }
        .stat-card { background: #f8f9fa; padding: 15px; border-radius: 5px; text-align: center; }
        .stat-value { font-size: 24px; font-weight: bold; color: #007bff; }
        .stat-label { color: #6c757d; margin-top: 5px; }
        .chart-container { margin: 30px 0; }
        .module-list { background: #f8f9fa; padding: 15px; border-radius: 5px; }
        .module-item { display: flex; justify-content: space-between; align-items: center; padding: 10px; border-bottom: 1px solid #dee2e6; }
        .module-item:last-child { border-bottom: none; }
        .error { color: #dc3545; }
        .success { color: #28a745; }
        .warning { color: #ffc107; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>RouteCodex Offline Log Analysis</h1>
            <p>Generated on ${new Date().toLocaleString()}</p>
        </div>
        
        <div class="stats">
            <div class="stat-card">
                <div class="stat-value">${analysis.totalEntries.toLocaleString()}</div>
                <div class="stat-label">Total Log Entries</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${Object.keys(analysis.moduleStats).length}</div>
                <div class="stat-label">Modules</div>
            </div>
            <div class="stat-card">
                <div class="stat-value error">${analysis.errorStats.total}</div>
                <div class="stat-label">Total Errors</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${((analysis.errorStats.total / analysis.totalEntries) * 100).toFixed(2)}%</div>
                <div class="stat-label">Error Rate</div>
            </div>
        </div>
        
        <div class="chart-container">
            <canvas id="moduleChart"></canvas>
        </div>
        
        <div class="chart-container">
            <canvas id="errorChart"></canvas>
        </div>
        
        <div class="module-list">
            <h3>Module Statistics</h3>
            ${Object.entries(analysis.moduleStats).map(([module, stats]: [string, any]) => `
                <div class="module-item">
                    <div>
                        <strong>${module}</strong>
                        <div style="font-size: 12px; color: #6c757d;">
                            ${stats.count} entries, ${stats.errors} errors
                            ${stats.avgDuration > 0 ? `, avg: ${stats.avgDuration.toFixed(2)}ms` : ''}
                        </div>
                    </div>
                    <div class="${stats.errors > 0 ? 'error' : 'success'}">
                        ${stats.errors > 0 ? '⚠️ Has Errors' : '✅ OK'}
                    </div>
                </div>
            `).join('')}
        </div>
    </div>
    
    <script>
        // Module Activity Chart
        const moduleCtx = document.getElementById('moduleChart').getContext('2d');
        new Chart(moduleCtx, {
            type: 'bar',
            data: {
                labels: ${JSON.stringify(Object.keys(analysis.moduleStats))},
                datasets: [{
                    label: 'Log Entries',
                    data: ${JSON.stringify(Object.values(analysis.moduleStats).map((s: any) => s.count))},
                    backgroundColor: 'rgba(54, 162, 235, 0.8)',
                    borderColor: 'rgba(54, 162, 235, 1)',
                    borderWidth: 1
                }, {
                    label: 'Errors',
                    data: ${JSON.stringify(Object.values(analysis.moduleStats).map((s: any) => s.errors))},
                    backgroundColor: 'rgba(255, 99, 132, 0.8)',
                    borderColor: 'rgba(255, 99, 132, 1)',
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    title: { display: true, text: 'Module Activity' }
                },
                scales: { y: { beginAtZero: true } }
            }
        });
        
        // Error Types Chart
        const errorCtx = document.getElementById('errorChart').getContext('2d');
        new Chart(errorCtx, {
            type: 'doughnut',
            data: {
                labels: ${JSON.stringify(Object.keys(analysis.errorStats.byType))},
                datasets: [{
                    data: ${JSON.stringify(Object.values(analysis.errorStats.byType))},
                    backgroundColor: [
                        'rgba(255, 99, 132, 0.8)',
                        'rgba(54, 162, 235, 0.8)',
                        'rgba(255, 206, 86, 0.8)',
                        'rgba(75, 192, 192, 0.8)',
                        'rgba(153, 102, 255, 0.8)'
                    ]
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    title: { display: true, text: 'Error Types Distribution' }
                }
            }
        });
    </script>
</body>
</html>`;
  
  fs.writeFileSync(outputFile, html);
}

async function generateCSVReport(analysis: any, outputFile: string): Promise<void> {
  const csv = [
    'Module,Total Entries,Errors,Error Rate,Avg Duration (ms)',
    ...Object.entries(analysis.moduleStats).map(([module, stats]: [string, any]) =>
      `${module},${(stats as any).count},${(stats as any).errors},${(((stats as any).errors / (stats as any).count) * 100).toFixed(2)}%,${(stats as any).avgDuration.toFixed(2)}`
    )
  ].join('\n');
  
  fs.writeFileSync(outputFile, csv);
}

function generateTimeSeriesData(results: any[], bucketSize: number): any[] {
  const timeBuckets: Record<number, { timestamp: number; count: number; errors: number; avgDuration: number; durations: number[] }> = {};
  
  results.forEach(result => {
    const bucketTime = Math.floor(result.timestamp / bucketSize) * bucketSize;
    if (!timeBuckets[bucketTime]) {
      timeBuckets[bucketTime] = {
        timestamp: bucketTime,
        count: 0,
        errors: 0,
        avgDuration: 0,
        durations: []
      };
    }
    
    timeBuckets[bucketTime].count++;
    
    if (result.level === 'error') {
      timeBuckets[bucketTime].errors++;
    }
    
    if (result.data?.duration) {
      timeBuckets[bucketTime].durations.push(result.data.duration);
    }
  });
  
  // 计算平均持续时间
  Object.values(timeBuckets).forEach((bucket: any) => {
    if (bucket.durations.length > 0) {
      bucket.avgDuration = bucket.durations.reduce((a: number, b: number) => a + b, 0) / bucket.durations.length;
      (bucket as any).durations = undefined;
    }
  });
  
  return Object.values(timeBuckets).sort((a, b) => a.timestamp - b.timestamp);
}

function generateTimeSeriesSummary(timeSeriesData: any[]): any {
  if (timeSeriesData.length === 0) {
    return { peakActivity: { bucket: 0, count: 0 }, avgActivity: 0 };
  }
  
  const peakActivity = timeSeriesData.reduce((peak, current) => 
    current.count > peak.count ? current : peak
  );
  
  const avgActivity = timeSeriesData.reduce((sum, current) => sum + current.count, 0) / timeSeriesData.length;
  
  return {
    peakActivity: { bucket: peakActivity.timestamp, count: peakActivity.count },
    avgActivity: avgActivity
  };
}