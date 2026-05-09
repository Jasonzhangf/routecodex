import type { ManagerContext, ManagerModule } from '../../types.js';
import { ProviderQuotaDaemonModule } from './provider-quota-daemon.js';

export interface QuotaRecord {
  remainingFraction: number | null;
  resetAt?: number;
  fetchedAt: number;
}

type RoutingProviderScope = {
  providerKeys?: string[];
  providerIds?: string[];
  oauthProviderKeys?: string[];
  oauthProviderIds?: string[];
};

export class QuotaManagerModule implements ManagerModule {
  readonly id = 'quota';
  private readonly delegate = new ProviderQuotaDaemonModule();

  async init(context: ManagerContext): Promise<void> {
    await this.delegate.init(context);
  }

  async start(): Promise<void> {
    await this.delegate.start();
  }

  async stop(): Promise<void> {
    await this.delegate.stop();
  }

  async updateRoutingScope(_scope?: RoutingProviderScope): Promise<void> {
    return;
  }

  async refreshNow(): Promise<{ refreshedAt: number; tokenCount: number; recordCount: number }> {
    const snapshot = this.delegate.getAdminSnapshot();
    return {
      refreshedAt: Date.now(),
      tokenCount: 0,
      recordCount: Object.keys(snapshot).length
    };
  }

  getRawSnapshot(): Record<string, QuotaRecord> {
    return {};
  }

  getCoreQuotaManager(): null {
    return null;
  }

  registerProviderStaticConfig(providerKey: string, config: { authType?: string | null; priorityTier?: number | null; apikeyDailyResetTime?: string | null } = {}): void {
    this.delegate.registerProviderStaticConfig(providerKey, config);
  }

  getQuotaView(): ReturnType<ProviderQuotaDaemonModule['getQuotaView']> {
    return this.delegate.getQuotaView();
  }

  getQuotaViewReadOnly(): ReturnType<ProviderQuotaDaemonModule['getQuotaViewReadOnly']> {
    return this.delegate.getQuotaViewReadOnly();
  }

  getAdminSnapshot(): ReturnType<ProviderQuotaDaemonModule['getAdminSnapshot']> {
    return this.delegate.getAdminSnapshot();
  }

  async persistNow(): Promise<void> {
    return;
  }

  async resetProvider(providerKey: string): Promise<{ providerKey: string; state: unknown } | null> {
    return await this.delegate.resetProvider(providerKey);
  }

  async recoverProvider(providerKey: string): Promise<{ providerKey: string; state: unknown } | null> {
    return await this.delegate.recoverProvider(providerKey);
  }

  async disableProvider(options: { providerKey: string; mode: 'cooldown' | 'blacklist'; durationMs: number }): Promise<{ providerKey: string; state: unknown } | null> {
    return await this.delegate.disableProvider(options);
  }
}
