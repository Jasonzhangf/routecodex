import type { ManagerContext, ManagerModule } from '../../types.js';
import { TokenDaemon } from '../../../token-daemon/token-daemon.js';

export class TokenManagerModule implements ManagerModule {
  readonly id = 'token';
  private daemon: TokenDaemon | null = null;

  async init(_context: ManagerContext): Promise<void> {
    // 目前不依赖 serverId 等上下文；后续可根据 serverId 做多实例隔离。
  }

  async start(): Promise<void> {
    if (this.daemon) {
      return;
    }
    const intervalSec = readPositiveNumberFromEnv('ROUTECODEX_TOKEN_INTERVAL_SEC', 60);
    const aheadMinutes = readPositiveNumberFromEnv('ROUTECODEX_TOKEN_REFRESH_AHEAD_MIN', 30);
    this.daemon = new TokenDaemon({
      intervalMs: intervalSec * 1000,
      refreshAheadMinutes: aheadMinutes
    });
    await this.daemon.start();
  }

  async stop(): Promise<void> {
    if (!this.daemon) {
      return;
    }
    this.daemon.stop();
    this.daemon = null;
  }
}

function readPositiveNumberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}
