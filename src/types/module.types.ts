import type { UnknownObject } from './common-types';

/**
 * 模块依赖接口
 */
export interface ModuleDependencies {
  logger?: {
    logModule: (module: string, event: string, data?: UnknownObject) => void;
    logError?: (error: Error, context?: UnknownObject) => void;
    logInfo?: (message: string, data?: UnknownObject) => void;
  };
  config?: UnknownObject;
  [key: string]: any;
}