import type { LogData } from "../../../types/common-types.js";

export type ColoredLogLevel = "debug" | "info" | "warn" | "error";

export interface ColoredLoggerOptions {
  isDev: boolean;
}

export class ColoredLogger {
  private readonly isDev: boolean;
  private readonly colors: Record<ColoredLogLevel, (msg: string) => string>;
  private readonly sessionColors: ((msg: string) => string)[];
  private sessionColorIndex = 0;
  private readonly sessionColorMap = new Map<string, (msg: string) => string>();

  constructor(opts: ColoredLoggerOptions) {
    this.isDev = opts.isDev;
    this.colors = {
      debug: (msg) => `\x1b[90m${msg}\x1b[0m`, // gray
      info: (msg) => `\x1b[36m${msg}\x1b[0m`, // cyan
      warn: (msg) => `\x1b[33m${msg}\x1b[0m`, // yellow
      error: (msg) => `\x1b[31m${msg}\x1b[0m`, // red
    };
    // Session color palette - distinct colors for different sessions
    this.sessionColors = [
      (msg) => `\x1b[31m${msg}\x1b[0m`, // red
      (msg) => `\x1b[32m${msg}\x1b[0m`, // green
      (msg) => `\x1b[33m${msg}\x1b[0m`, // yellow
      (msg) => `\x1b[34m${msg}\x1b[0m`, // blue
      (msg) => `\x1b[35m${msg}\x1b[0m`, // magenta
      (msg) => `\x1b[36m${msg}\x1b[0m`, // cyan
      (msg) => `\x1b[38;5;208m${msg}\x1b[0m`, // orange
      (msg) => `\x1b[38;5;141m${msg}\x1b[0m`, // light purple
    ];
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
    data?: LogData,
  ): void {
    const level: ColoredLogLevel =
      action === "request-error" ? "error" : "info";
    const prefix = `[provider] ${requestId} ${action}`;
    const body = this.format(data);
    const line = `${prefix} ${body}`;
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

  logVirtualRouterHit(
    routeName: string,
    providerKey: string,
    model?: string,
    sessionId?: string,
  ): void {
    const colorizer = this.resolveSessionColor(sessionId);
    const sessionPart = sessionId ? `[${sessionId}] ` : "";
    const line = `[virtual-router-hit] ${sessionPart}${routeName} -> ${providerKey}${model ? `.${model}` : ""}`;
    console.log(colorizer(line));
  }

  logModule(module: string, action: string, data?: LogData): void {
    const line = `[${module}] ${action} ${this.format(data)}`;
    const normalizedAction = action.toLowerCase();
    if (
      normalizedAction.includes("error") ||
      normalizedAction.includes("failed")
    ) {
      console.error(this.colors.error(line));
    } else if (normalizedAction.includes("warn")) {
      console.warn(this.colors.warn(line));
    } else {
      console.log(this.colors.info(line));
    }
  }

  private resolveSessionColor(sessionId?: string): (msg: string) => string {
    if (!sessionId) {
      // Default color for no session
      return (msg) => `\x1b[90m${msg}\x1b[0m`; // gray
    }
    // Check if we already assigned a color to this session
    const existingColor = this.sessionColorMap.get(sessionId);
    if (existingColor) {
      return existingColor;
    }
    // Assign a new color from the palette (round-robin)
    const color =
      this.sessionColors[this.sessionColorIndex % this.sessionColors.length];
    this.sessionColorMap.set(sessionId, color);
    this.sessionColorIndex++;
    return color;
  }
}
