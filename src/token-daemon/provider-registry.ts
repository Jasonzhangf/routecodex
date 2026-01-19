import { loadRouteCodexConfig } from '../config/routecodex-config-loader.js';
import type { OAuthProviderId } from './token-types.js';

type UnknownRecord = Record<string, unknown>;

const DEFAULT_OAUTH_PROVIDERS: OAuthProviderId[] = ['iflow', 'qwen', 'gemini-cli', 'antigravity'];

export class DynamicProviderRegistry {
  private providers: OAuthProviderId[] = [...DEFAULT_OAUTH_PROVIDERS];
  private configPath: string | null = null;
  private lastLoadedAt = 0;
  private loadPromise: Promise<{ providers: OAuthProviderId[]; changed: boolean }> | null = null;

  async listProviders(): Promise<OAuthProviderId[]> {
    if (!this.lastLoadedAt && !this.loadPromise) {
      await this.reload();
    } else if (this.loadPromise) {
      await this.loadPromise;
    }
    return this.providers;
  }

  async reload(): Promise<{ providers: OAuthProviderId[]; changed: boolean }> {
    if (this.loadPromise) {
      return this.loadPromise;
    }
    this.loadPromise = this.loadFromConfig().finally(() => {
      this.loadPromise = null;
    });
    return this.loadPromise;
  }

  getConfigPath(): string | null {
    return this.configPath;
  }

  private async loadFromConfig(): Promise<{ providers: OAuthProviderId[]; changed: boolean }> {
    let changed = false;
    try {
      const { userConfig, configPath } = await loadRouteCodexConfig();
      this.configPath = configPath;
      const resolved = this.extractProviders(userConfig);
      const nextProviders = resolved.length ? resolved : [...DEFAULT_OAUTH_PROVIDERS];
      changed = !this.areArraysEqual(nextProviders, this.providers);
      if (changed || !this.providers.length) {
        this.providers = nextProviders;
      }
      this.lastLoadedAt = Date.now();
    } catch {
      if (!this.providers.length) {
        this.providers = [...DEFAULT_OAUTH_PROVIDERS];
        changed = true;
      }
    }
    return { providers: this.providers, changed };
  }

  private extractProviders(config: UnknownRecord): OAuthProviderId[] {
    const result: OAuthProviderId[] = [];
    const seen = new Set<string>();
    const virtualRouter = this.asRecord(config.virtualrouter ?? config.virtualRouter);
    const providersNode = this.asRecord(virtualRouter?.providers);
    if (!providersNode) {
      return result;
    }
    for (const raw of Object.values(providersNode)) {
      const provider = this.asRecord(raw);
      if (!provider) {
        continue;
      }
      const authNode = this.asRecord(provider.auth);
      if (!authNode) {
        continue;
      }
      const providerIds = this.collectProviderIds(provider, authNode);
      for (const providerId of providerIds) {
        if (!seen.has(providerId)) {
          seen.add(providerId);
          result.push(providerId as OAuthProviderId);
        }
      }
    }
    return result;
  }

  private collectProviderIds(providerNode: UnknownRecord, authNode: UnknownRecord): string[] {
    const bucket: string[] = [];
    const direct = this.readString(
      (authNode.oauthProviderId as string | undefined) ??
        (providerNode.oauthProviderId as string | undefined)
    );
    if (direct) {
      bucket.push(direct.toLowerCase());
    }
    const oauthNode = this.asRecord(authNode.oauth);
    const typeCandidates = [
      this.readString(authNode.type as string | undefined),
      this.readString((authNode as { rawType?: string }).rawType),
      this.readString(providerNode.authType as string | undefined),
      this.readString(providerNode.providerType as string | undefined),
      this.readString(oauthNode?.type as string | undefined),
      this.readString((oauthNode as { rawType?: string })?.rawType)
    ];
    for (const candidate of typeCandidates) {
      const parsed = this.parseTypeCandidate(candidate);
      if (parsed) {
        bucket.push(parsed);
      }
    }
    this.collectFromEntries(authNode.entries, bucket);
    this.collectFromEntries(authNode.keys, bucket);
    return bucket;
  }

  private collectFromEntries(value: unknown, bucket: string[]): void {
    if (!value) {
      return;
    }
    const pushRecord = (record: UnknownRecord): void => {
      const resolved =
        this.readString(record.oauthProviderId as string | undefined) ??
        this.readString((record as { providerId?: string }).providerId) ??
        this.parseTypeCandidate(this.readString(record.type as string | undefined)) ??
        this.parseTypeCandidate(this.readString((record as { rawType?: string }).rawType));
      if (resolved) {
        bucket.push(resolved.toLowerCase());
      }
    };
    if (Array.isArray(value)) {
      for (const entry of value) {
        const record = this.asRecord(entry);
        if (record) {
          pushRecord(record);
        } else if (typeof entry === 'string') {
          const parsed = this.parseTypeCandidate(entry);
          if (parsed) {
            bucket.push(parsed);
          }
        }
      }
      return;
    }
    const record = this.asRecord(value);
    if (record) {
      for (const entry of Object.values(record)) {
        if (typeof entry === 'string') {
          const parsed = this.parseTypeCandidate(entry);
          if (parsed) {
            bucket.push(parsed);
          }
          continue;
        }
        const nested = this.asRecord(entry);
        if (nested) {
          pushRecord(nested);
        }
      }
      return;
    }
    if (typeof value === 'string') {
      const parsed = this.parseTypeCandidate(value);
      if (parsed) {
        bucket.push(parsed);
      }
    }
  }

  private parseTypeCandidate(value?: string): string | null {
    if (!value) {
      return null;
    }
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return null;
    }
    const match = normalized.match(/^([a-z0-9._-]+)-(?:oauth|oauth2)$/);
    return match ? match[1] : null;
  }

  private areArraysEqual(left: string[], right: string[]): boolean {
    if (left.length !== right.length) {
      return false;
    }
    for (let i = 0; i < left.length; i += 1) {
      if (left[i] !== right[i]) {
        return false;
      }
    }
    return true;
  }

  private asRecord(value: unknown): UnknownRecord | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    return value as UnknownRecord;
  }

  private readString(value?: string): string | undefined {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
    }
    return undefined;
  }
}

let registryInstance: DynamicProviderRegistry | null = null;

export function getDynamicProviderRegistry(): DynamicProviderRegistry {
  if (!registryInstance) {
    registryInstance = new DynamicProviderRegistry();
  }
  return registryInstance;
}