import type {
  ProviderErrorEvent,
  ProviderSuccessEvent,
  StaticQuotaConfig
} from '../../../modules/llmswitch/bridge.js';

export type CoreQuotaManager = {
  hydrateFromStore?: () => Promise<void>;
  registerProviderStaticConfig?: (providerKey: string, cfg: StaticQuotaConfig) => void;
  onProviderError?: (ev: ProviderErrorEvent) => void;
  onProviderSuccess?: (ev: ProviderSuccessEvent) => void;
  updateProviderPoolState?: (options: {
    providerKey: string;
    inPool: boolean;
    reason?: string | null;
    cooldownUntil?: number | null;
    blacklistUntil?: number | null;
  }) => void;
  disableProvider?: (options: {
    providerKey: string;
    mode: 'cooldown' | 'blacklist';
    durationMs: number;
    reason?: string;
  }) => void;
  recoverProvider?: (providerKey: string) => void;
  resetProvider?: (providerKey: string) => void;
  getQuotaView?: () => (providerKey: string) => unknown;
  getSnapshot?: () => unknown;
  persistNow?: () => Promise<void>;
};

export function assertCoreQuotaManagerApis(mgrAny: any): void {
  const missingApis =
    !mgrAny ||
    typeof mgrAny.getQuotaView !== 'function' ||
    typeof mgrAny.getSnapshot !== 'function' ||
    typeof mgrAny.updateProviderPoolState !== 'function' ||
    typeof mgrAny.resetProvider !== 'function' ||
    typeof mgrAny.recoverProvider !== 'function' ||
    typeof mgrAny.disableProvider !== 'function';
  if (!missingApis) {
    return;
  }
  const detail = {
    hasMgr: Boolean(mgrAny),
    getQuotaView: typeof mgrAny?.getQuotaView,
    getSnapshot: typeof mgrAny?.getSnapshot,
    updateProviderPoolState: typeof mgrAny?.updateProviderPoolState,
    resetProvider: typeof mgrAny?.resetProvider,
    recoverProvider: typeof mgrAny?.recoverProvider,
    disableProvider: typeof mgrAny?.disableProvider
  };
  throw new Error(`core quota manager missing expected APIs: ${JSON.stringify(detail)}`);
}
