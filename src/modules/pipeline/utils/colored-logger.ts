import type { LogData } from "../../../types/common-types.js";
import { resolveSessionAnsiColor } from "../../../utils/session-log-color.js";

export type ColoredLogLevel = "debug" | "info" | "warn" | "error";

export interface ColoredLoggerOptions {
  isDev: boolean;
}

export class ColoredLogger {
  private readonly isDev: boolean;
  private readonly colors: Record<ColoredLogLevel, (msg: string) => string>;

  constructor(opts: ColoredLoggerOptions) {
    this.isDev = opts.isDev;
    this.colors = {
      debug: (msg) => `\x1b[90m${msg}\x1b[0m`,
      info: (msg) => `\x1b[36m${msg}\x1b[0m`,
      warn: (msg) => `\x1b[33m${msg}\x1b[0m`,
      error: (msg) => `\x1b[31m${msg}\x1b[0m`
    };
  }

  private format(data?: LogData): string {
    if (!data) {
      return "";
    }
    return JSON.stringify(data, null, this.isDev ? 2 : 0);
  }

  logProviderRequest(
    requestId: string,
    action: "request-start" | "request-success" | "request-error",
    data?: LogData
  ): void {
    const level: ColoredLogLevel = action === "request-error" ? "error" : "info";
    const prefix = `[provider] ${requestId} ${action}`;
    const body = this.format(data);
    const line = body ? `${prefix} ${body}` : prefix;
    console.log(this.colors[level](line));
    if (
      this.isDev &&
      action === "request-error" &&
      data &&
      typeof data === "object" &&
      (data as any).error instanceof Error
    ) {
      console.error(this.colors.error((data as any).error.stack ?? ""));
    }
  }

  logServerTool(message: string, sessionId?: string): void {
    const colorizer = this.resolveSessionColor(sessionId);
    console.log(colorizer(message));
  }

  logVirtualRouterHit(
    routeName: string,
    providerKey: string,
    model?: string,
    sessionId?: string
  ): void {
    const colorizer = this.resolveSessionColor(sessionId);
    const sessionPart = sessionId ? `[${sessionId}] ` : "";
    const line = `[virtual-router-hit] ${sessionPart}${routeName} -> ${providerKey}${model ? `.${model}` : ""}`;
    console.log(colorizer(line));
  }

  logModule(module: string, action: string, data?: LogData): void {
    const suffix = this.format(data);
    const line = suffix ? `[${module}] ${action} ${suffix}` : `[${module}] ${action}`;
    const normalizedAction = action.toLowerCase();
    if (normalizedAction.includes("error") || normalizedAction.includes("failed")) {
      console.error(this.colors.error(line));
    } else if (normalizedAction.includes("warn")) {
      console.warn(this.colors.warn(line));
    } else {
      console.log(this.colors.info(line));
    }
  }

  private resolveSessionColor(sessionId?: string): (msg: string) => string {
    const color = resolveSessionAnsiColor(sessionId);
    if (!color) {
      return this.colors.debug;
    }
    return (msg) => `${color}${msg}\x1b[0m`;
  }
}
