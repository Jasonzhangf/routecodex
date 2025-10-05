/**
 * 统一解析机制主入口
 * 
 * 提供日志文件扫描、JSONL解析、时间序列索引和数据验证的完整功能
 */

// 文件扫描
export type {
  LogFileInfo,
  LogScannerOptions,
  LogScanResult
} from './LogFileScanner.js';

export { 
  LogFileScanner
} from './LogFileScanner.js';

// JSONL解析
export type {
  JsonlParserConfig,
  ParseProgress,
  ParseResult,
  ParseError,
  ParseStats
} from './JsonlParser.js';

export { 
  JsonlLogParser
} from './JsonlParser.js';

// 时间序列索引 - 使用简化版本
export type {
  SimpleTimeSeriesIndexConfig
} from '../indexer/SimpleTimeSeriesIndexer.js';

export { 
  SimpleTimeSeriesIndexer as TimeSeriesIndexEngine
} from '../indexer/SimpleTimeSeriesIndexer.js';

// 数据验证和清洗
export type {
  DataValidationOptions,
  DataCleaningOptions,
  ValidationResult,
  ValidationError,
  ValidationWarning,
  ValidationFix,
  CleaningResult,
  CleaningStats
} from '../validator/index.js';

export { 
  DataValidatorAndCleaner
} from '../validator/index.js';

/**
 * 完整的解析流程 - 一站式函数
 */
export async function parseHistoricalLogs(options: {
  /** 扫描目录 */
  scanDirectory?: string;
  /** 时间范围 */
  timeRange?: { start: number; end: number };
  /** 模块过滤 */
  moduleIds?: string[];
  /** 验证选项 */
  validationOptions?: import('../validator/DataValidator.js').DataValidationOptions;
  /** 清洗选项 */
  cleaningOptions?: import('../validator/DataValidator.js').DataCleaningOptions;
  /** 索引导入选项 */
  indexOptions?: import('../indexer/SimpleTimeSeriesIndexer.js').SimpleTimeSeriesIndexConfig;
}) {
  console.log('🚀 开始完整的历史日志解析流程...');
  
  const startTime = Date.now();
  
  try {
    // 1. 扫描日志文件
    console.log('📁 步骤1: 扫描日志文件...');
    const { LogFileScanner } = await import('./LogFileScanner.js');
    const scanner = new LogFileScanner({
      scanDirectory: options.scanDirectory,
      timeRange: options.timeRange,
      moduleIds: options.moduleIds
    });
    
    const scanResult = await scanner.scan();
    console.log(`✅ 发现 ${scanResult.totalFiles} 个日志文件`);
    
    if (scanResult.totalFiles === 0) {
      console.log('⚠️  未找到日志文件');
      return {
        entries: [],
        index: null,
        stats: { totalFiles: 0, totalEntries: 0, parseTime: 0 }
      };
    }
    
    // 2. 解析日志文件
    console.log('📖 步骤2: 解析日志文件...');
    const { JsonlLogParser } = await import('./JsonlParser.js');
    const parser = new JsonlLogParser({
      batchSize: 1000,
      errorHandling: 'skip',
      validateTimestamps: true
    });
    
    const filePaths = scanResult.files.map((f: any) => f.filePath);
    const parseResult = await parser.parseFiles(filePaths);
    console.log(`✅ 解析完成，共 ${parseResult.entries.length} 条日志`);
    
    // 3. 验证和清洗数据
    console.log('🔍 步骤3: 验证和清洗数据...');
    const { DataValidatorAndCleaner } = await import('../validator/DataValidator.js');
    const validator = new DataValidatorAndCleaner(
      options.validationOptions,
      options.cleaningOptions
    );
    
    const cleanResult = await validator.validateAndClean(parseResult.entries);
    console.log(`✅ 清洗完成，有效条目: ${cleanResult.cleaningResult.stats.validEntries}`);
    
    // 4. 构建时间序列索引
    console.log('📊 步骤4: 构建时间序列索引...');
    let index = null;
    
    if (options.indexOptions) {
      const { SimpleTimeSeriesIndexer } = await import('../indexer/SimpleTimeSeriesIndexer.js');
      index = new SimpleTimeSeriesIndexer(options.indexOptions);
      
      await index.index(cleanResult.cleanedEntries);
      console.log(`✅ 索引构建完成，共 ${cleanResult.cleanedEntries.length} 条日志`);
    }
    
    const totalTime = Date.now() - startTime;
    
    console.log(`🎉 历史日志解析完成！总耗时: ${totalTime}ms`);
    console.log(`   文件数: ${scanResult.totalFiles}`);
    console.log(`   日志条目: ${cleanResult.cleaningResult.stats.validEntries}`);
    console.log(`   清洗操作: ${cleanResult.cleaningResult.stats.normalizedOperations}`);
    
    return {
      entries: cleanResult.cleanedEntries,
      index,
      stats: {
        totalFiles: scanResult.totalFiles,
        totalEntries: cleanResult.cleaningResult.stats.validEntries,
        parseTime: totalTime,
        scanStats: scanResult,
        parseStats: parseResult.stats,
        cleanStats: cleanResult.cleaningResult.stats
      }
    };
    
  } catch (error) {
    console.error('❌ 历史日志解析失败:', error);
    throw error;
  }
}

/**
 * 快速解析函数 - 适用于小文件
 */
export async function quickParseLogFile(filePath: string): Promise<import('../types.js').UnifiedLogEntry[]> {
  const { JsonlLogParser } = await import('./JsonlParser.js');
  const parser = new JsonlLogParser({
    batchSize: 100,
    errorHandling: 'skip'
  });
  
  return parser.parseFile(filePath);
}

/**
 * 快速验证函数
 */
export function quickValidateLogContent(content: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const lines = content.split('\n').filter(line => line.trim());
      if (lines.length === 0) {
        resolve(false);
        return;
      }
      
      // 动态导入避免循环依赖
      (async () => {
        const { DataValidatorAndCleaner } = await import('../validator/DataValidator.js');
        const validator = new DataValidatorAndCleaner({ validationLevel: 'lenient' });
        
        for (const line of lines.slice(0, 5)) { // 只检查前5行
          try {
            const parsed = JSON.parse(line);
            const result = validator.validateEntry(parsed);
            if (!result.isValid) {
              resolve(false);
              return;
            }
          } catch {
            resolve(false);
            return;
          }
        }
        
        resolve(true);
      })().catch(() => {
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}