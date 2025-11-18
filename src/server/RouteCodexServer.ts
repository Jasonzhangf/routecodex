// Minimal type and class to satisfy older imports
export interface ServerConfig {
  port: number;
  host: string;
}

export class RouteCodexServer {
  constructor(_config: ServerConfig) {}

  async initialize(): Promise<void> {
    // no-op stub for V1 compatibility
  }

  async start(): Promise<void> {
    // no-op stub for V1 compatibility
  }

  async stop(): Promise<void> {
    // no-op stub for V1 compatibility
  }

  // The following helpers are provided only to satisfy the ServerInstance
  // structural type used by ServerFactory in dev builds. V1 is effectively
  // a no-op in this worktree.
  getStatus(): unknown {
    return { status: 'stub', version: 'v1' };
  }

  isInitialized(): boolean {
    return true;
  }

  isRunning(): boolean {
    return false;
  }
}
