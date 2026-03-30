import type { ManagerContext, ManagerModule } from '../../types.js';
import { TokenDaemon } from '../../../token-daemon/token-daemon.js';
import {
  releaseTokenManagerLeader,
  tryAcquireTokenManagerLeader
} from '../../../token-daemon/leader-lock.js';

type RoutingProviderScope = {
  providerKeys?: string[];
  providerIds?: string[];
  oauthProviderKeys?: string[];
  oauthProviderIds?: string[];
};

export class TokenManagerModule implements ManagerModule {
  readonly id = 'token';
  private daemon: TokenDaemon | null = null;
  private ownerId: string | null = null;
  private isLeader: boolean = false;
  private configPath: string | null = null;
  private started = false;
  private routingScopeResolved = false;
  private routedOAuthProviderIds: Set<string> = new Set();

  async init(context: ManagerContext): Promise<void> {
    // 使用 serverId 构造稳定 ownerId，便于区分不同服务器实例。
    this.ownerId = `server:${context.serverId}`;
    this.configPath = typeof context.configPath === 'string' && context.configPath.trim()
      ? context.configPath.trim()
      : null;
  }

  async start(): Promise<void> {
    this.started = true;
    await this.reconcileDaemonState();
  }

  async stop(): Promise<void> {
    this.started = false;
    await this.stopDaemonAndReleaseLeader();
  }

  async updateRoutingScope(scope?: RoutingProviderScope): Promise<void> {
    this.routingScopeResolved = true;
    this.routedOAuthProviderIds = normalizeScopeSet(scope?.oauthProviderIds);
    await this.reconcileDaemonState();
  }

  private async reconcileDaemonState(): Promise<void> {
    if (!this.started) {
      return;
    }
    if (!this.routingScopeResolved) {
      return;
    }
    if (this.routedOAuthProviderIds.size === 0) {
      await this.stopDaemonAndReleaseLeader();
      console.log('[TokenManagerModule] skip token daemon: no routed oauth providers');
      return;
    }
    await this.ensureDaemonStarted();
  }

  private async ensureDaemonStarted(): Promise<void> {
    if (this.daemon || !this.ownerId) {
      return;
    }
    const disabled =
      String(process.env.ROUTECODEX_DISABLE_TOKEN_DAEMON || '').trim() === '1' ||
      String(process.env.RCC_DISABLE_TOKEN_DAEMON || '').trim() === '1';
    const mockMode =
      String(process.env.ROUTECODEX_USE_MOCK || '').trim() === '1' ||
      Boolean(process.env.ROUTECODEX_MOCK_CONFIG_PATH);
    if (disabled || mockMode) {
      return;
    }

    const { isLeader, leader } = await tryAcquireTokenManagerLeader(this.ownerId);
    if (!isLeader) {
      const owner = leader?.ownerId ?? 'unknown';
      const pid = leader?.pid ?? 'unknown';
      // 仅日志提示，避免重复刷新同一批 token。
      const logFlag = String(process.env.ROUTECODEX_TOKEN_DAEMON_LOG || '').trim().toLowerCase();
      const logEnabled = logFlag === '1' || logFlag === 'true';
      if (logEnabled) {
        // eslint-disable-next-line no-console
        console.log(
          `[TokenManagerModule] Token manager leader already active (owner=${owner}, pid=${pid}); skipping TokenDaemon in this process.`
        );
      }
      this.isLeader = false;
      return;
    }

    const intervalSec = readPositiveNumberFromEnv('ROUTECODEX_TOKEN_INTERVAL_SEC', 60);
    // 默认提前 30 分钟刷新：避免临近到期时触发“真实请求阻塞 / 403/401 连锁失败”。
    const aheadMinutes = readPositiveNumberFromEnv('ROUTECODEX_TOKEN_REFRESH_AHEAD_MIN', 30);
    this.daemon = new TokenDaemon({
      intervalMs: intervalSec * 1000,
      refreshAheadMinutes: aheadMinutes,
      configPath: this.configPath ?? undefined
    });
    this.isLeader = true;
    await this.daemon.start();
  }

  private async stopDaemonAndReleaseLeader(): Promise<void> {
    if (this.daemon) {
      await this.daemon.stop();
      this.daemon = null;
    }
    if (this.isLeader && this.ownerId) {
      await releaseTokenManagerLeader(this.ownerId);
      this.isLeader = false;
    }
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

function normalizeScopeSet(values: string[] | undefined): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(values)) {
    return out;
  }
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) {
      continue;
    }
    out.add(trimmed);
  }
  return out;
}
