// Minimal type and class to satisfy older imports
export interface ServerConfig {
  port: number;
  host: string;
}

export class RouteCodexServer {
  constructor(_config: ServerConfig) {}
  async initialize(): Promise<void> { /* no-op */ }
  async start(): Promise<void> { /* no-op */ }
  async stop(): Promise<void> { /* no-op */ }
}

