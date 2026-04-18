import type { ProviderHealthConfig, ProviderHealthState } from './types.js';

interface ProviderInternalState extends ProviderHealthState {
  lastFailureAt?: number;
}

const DEFAULT_CONFIG: Required<ProviderHealthConfig> = {
  failureThreshold: 3,
  cooldownMs: 30_000,
  fatalCooldownMs: 120_000
};

export class ProviderHealthManager {
  private readonly states: Map<string, ProviderInternalState> = new Map();
  private config: Required<ProviderHealthConfig> = DEFAULT_CONFIG;

  configure(config?: ProviderHealthConfig): void {
    if (config) {
      const normalizedCooldown = Math.max(5_000, config.cooldownMs ?? DEFAULT_CONFIG.cooldownMs);
      const fatalCooldownCandidate = config.fatalCooldownMs ?? DEFAULT_CONFIG.fatalCooldownMs ?? normalizedCooldown;
      this.config = {
        failureThreshold: Math.max(1, config.failureThreshold ?? DEFAULT_CONFIG.failureThreshold),
        cooldownMs: normalizedCooldown,
        fatalCooldownMs: Math.max(fatalCooldownCandidate, normalizedCooldown)
      };
    }
  }

  registerProviders(providerKeys: string[]): void {
    for (const key of providerKeys) {
      if (!this.states.has(key)) {
        this.states.set(key, {
          providerKey: key,
          state: 'healthy',
          failureCount: 0
        });
      }
    }
  }

  recordFailure(providerKey: string, reason?: string): ProviderInternalState {
    const state = this.getState(providerKey);
    state.failureCount += 1;
    state.lastFailureAt = Date.now();
    if (reason) {
      state.reason = reason;
    }
    // Aggressive ban: auto-trip when reaching threshold (3 consecutive failures = 3 cycles cooldown)
    const threshold = this.config.failureThreshold;
    const cooldownUnit = this.config.cooldownMs;
    if (state.failureCount >= threshold) {
      state.state = 'tripped';
      state.cooldownExpiresAt = Date.now() + cooldownUnit * 3;
    }
    return state;
  }

  /**
   * 为可恢复错误（例如 429）提供短暂冷静期：在 cooldownMs 内将 providerKey
   * 视为不可用，但不使用 fatalCooldownMs 的长熔断时间。
   */
  cooldownProvider(providerKey: string, reason?: string, overrideMs?: number): ProviderInternalState {
    const state = this.getState(providerKey);
    state.failureCount += 1;
    state.state = 'tripped';
    state.reason = reason;
    const ttl = overrideMs ?? this.config.cooldownMs;
    state.cooldownExpiresAt = Date.now() + ttl;
    state.lastFailureAt = Date.now();
    return state;
  }

  recordSuccess(providerKey: string): ProviderInternalState {
    const state = this.getState(providerKey);
    state.failureCount = 0;
    state.state = 'healthy';
    state.cooldownExpiresAt = undefined;
    state.lastFailureAt = undefined;
    state.reason = undefined;
    return state;
  }

  tripProvider(providerKey: string, reason?: string, cooldownOverrideMs?: number): ProviderInternalState {
    const state = this.getState(providerKey);
    state.failureCount = Math.max(state.failureCount, this.config.failureThreshold);
    state.state = 'tripped';
    state.reason = reason;
    const ttl = cooldownOverrideMs ?? this.config.fatalCooldownMs ?? this.config.cooldownMs;
    state.cooldownExpiresAt = Date.now() + ttl;
    state.lastFailureAt = Date.now();
    return state;
  }

  isAvailable(providerKey: string): boolean {
    const state = this.getState(providerKey);
    if (state.state === 'healthy') {
      return true;
    }
    if (state.cooldownExpiresAt && Date.now() >= state.cooldownExpiresAt) {
      this.recordSuccess(providerKey);
      return true;
    }
    return false;
  }

  getSnapshot(): ProviderHealthState[] {
    return Array.from(this.states.values()).map((state) => ({
      providerKey: state.providerKey,
      state: state.state,
      failureCount: state.failureCount,
      cooldownExpiresAt: state.cooldownExpiresAt
    }));
  }

  getConfig(): Required<ProviderHealthConfig> {
    return { ...this.config };
  }

  private getState(providerKey: string): ProviderInternalState {
    if (!this.states.has(providerKey)) {
      this.states.set(providerKey, {
        providerKey,
        state: 'healthy',
        failureCount: 0
      });
    }
    return this.states.get(providerKey)!;
  }
}
