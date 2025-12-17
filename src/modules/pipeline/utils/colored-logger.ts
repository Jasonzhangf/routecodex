import type { LogData } from '../../../types/common-types.js';

export type ColoredLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ColoredLoggerOptions {
  isDev: boolean;
}

export class ColoredLogger {
  private readonly isDev: boolean;
  private readonly colors: Record<ColoredLogLevel, (msg: string) => string>;

  constructor(opts: ColoredLoggerOptions) {
    this.isDev = opts.isDev;
    this.colors = {
      debug: (msg) => `\x1b[90m${msg}\x1b[0m`,    // gray
      info:  (msg) => `\x1b[36m${msg}\x1b[0m`,    // cyan
      warn:  (msg) => `\x1b[33m${msg}\x1b[0m`,    // yellow
      error: (msg) => `\x1b[31m${msg}\x1b[0m`,    // red
    };
  }

  private format(data?: LogData): string {
    if (!data) return '';
    return JSON.stringify(data, null, this.isDev ? 2 : 0);
  }

  logProviderRequest(requestId: string, action: 'request-start' | 'request-success' | 'request-error', data?: LogData): void {
    const level: ColoredLogLevel = action === 'request-error' ? 'error' : 'info';
    const prefix = `[provider] ${requestId} ${action}`;
    const body = this.format(data);
    const line = `${prefix} ${body}`;
    console.log(this.colors[level](line));
    if (this.isDev && action === 'request-error' && data && typeof data === 'object' && (data as any).error instanceof Error) {
      console.error(this.colors.error((data as any).error.stack ?? ''));
    }
  }

  logVirtualRouterHit(routeName: string, providerKey: string, model?: string): void {
    // virtual router 命中使用橙色，方便从 provider 日志中区分
    const orange = (msg: string) => `\x1b[38;5;208m${msg}\x1b[0m`;
    const line = `[virtual-router] ${routeName} -> ${providerKey}${model ? '.' + model : ''}`;
    console.log(orange(line));
  }

  logModule(module: string, action: string, data?: LogData): void {
    const line = `[${module}] ${action} ${this.format(data)}`;
    const normalizedAction = action.toLowerCase();
    if (normalizedAction.includes('error') || normalizedAction.includes('failed')) {
      console.error(this.colors.error(line));
    } else if (normalizedAction.includes('warn')) {
      console.warn(this.colors.warn(line));
    } else {
      console.log(this.colors.info(line));
    }
  }
}
