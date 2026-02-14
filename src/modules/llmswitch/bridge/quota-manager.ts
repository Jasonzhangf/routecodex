/**
 * Quota Manager Bridge
 *
 * Lazy-loads core quota manager and keeps host-side x7e gate checks local.
 */

import type { ProviderErrorEvent, ProviderSuccessEvent } from '@jsonstudio/llms/dist/router/virtual-router/types.js';
import { x7eGate } from '../../../server/runtime/http-server/daemon-admin/routecodex-x7e-gate.js';
import { importCoreDist } from './module-loader.js';

type QuotaModule = {
  QuotaManager?: new (options?: { store?: unknown }) => {
    hydrateFromStore?: () => Promise<void>;
    registerProviderStaticConfig?: (providerKey: string, cfg: unknown) => void;
    onProviderError?: (ev: ProviderErrorEvent) => void;
    onProviderSuccess?: (ev: ProviderSuccessEvent) => void;
    updateProviderPoolState?: (options: unknown) => void;
    disableProvider?: (options: unknown) => void;
    recoverProvider?: (providerKey: string) => void;
    resetProvider?: (providerKey: string) => void;
    getQuotaView?: () => unknown;
    getSnapshot?: () => unknown;
    persistNow?: () => Promise<void>;
  };
};

let quotaModulePromise: Promise<QuotaModule | null> | null = null;
let cachedQuotaModuleError: string | null = null;

async function importQuotaModule(): Promise<QuotaModule | null> {
  if (!quotaModulePromise) {
    quotaModulePromise = (async () => {
      try {
        const mod = await importCoreDist<QuotaModule>('quota/index');
        cachedQuotaModuleError = null;
        return mod;
      } catch {
        cachedQuotaModuleError = 'failed to import core module quota/index (resolveCoreModulePath or import failed)';
        return null;
      }
    })();
  }
  return await quotaModulePromise;
}

export async function createCoreQuotaManager(options?: { store?: unknown }): Promise<unknown> {
  if (!x7eGate.phase1UnifiedQuota) {
    return null;
  }
  const mod = await importQuotaModule();
  const Ctor = mod?.QuotaManager;
  if (typeof Ctor !== 'function') {
    throw new Error(
      `[llmswitch-bridge] core QuotaManager not available; please update @jsonstudio/llms${cachedQuotaModuleError ? ` (${cachedQuotaModuleError})` : ''}`
    );
  }
  return new Ctor({ ...(options ?? {}) });
}
