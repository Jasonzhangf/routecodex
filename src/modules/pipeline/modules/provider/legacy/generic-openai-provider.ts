/**
 * Generic OpenAI-compatible HTTP Provider
 *
 * Sends OpenAI Chat Completions payloads to a configurable baseUrl that claims
 * OpenAI compatibility. Supports streaming passthrough and JSON responses.
 */

import type { ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { ProviderResponse } from '../../types/provider-types.js';
import type { UnknownObject } from '../../../../types/common-types.js';
import { BaseHttpProvider } from './shared/base-http-provider.js';
import fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';

export class GenericOpenAIProvider extends BaseHttpProvider {
  readonly type = 'generic-openai-provider';
  readonly providerType = 'openai';

  constructor(config: ModuleConfig, dependencies: ModuleDependencies) {
    super(config, dependencies);
  }

  protected getDefaultBaseUrl(): string {
    const providerConfig = this.config.config as any;
    return String(providerConfig.baseUrl || '').replace(/\/+$/, '');
  }

  protected buildEndpointUrl(path?: string): string {
    const baseUrl = this.getDefaultBaseUrl();
    return path ? `${baseUrl}${path}` : `${baseUrl}/chat/completions`;
  }

  public async sendRequest(request: UnknownObject, endpoint?: string): Promise<ProviderResponse> {
    const start = Date.now();
    const payload: Record<string, unknown> = { ...(request as any) };

    // Generate request ID for debugging
    const requestId = (() => {
      try {
        const raw: any = payload as any;
        const fromMeta = raw?._metadata && typeof raw._metadata === 'object' ? raw._metadata.requestId : undefined;
        const fromTop = raw?.metadata && typeof raw.metadata === 'object' ? raw.metadata.requestId : undefined;
        const picked = typeof fromMeta === 'string' ? fromMeta : (typeof fromTop === 'string' ? fromTop : undefined);
        return picked && picked.startsWith('req_') ? picked : `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      } catch { return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }
    })();

    // Persist outgoing payload for debugging
    try {
      const baseDir = path.join(homedir(), '.routecodex', 'codex-samples');
      const effectiveId = requestId;
      const entry = (request as any)?.metadata?.entryEndpoint || '';
      const entryFolder = /\/v1\/responses/i.test(String(entry))
        ? 'openai-responses'
        : (/\/v1\/messages/i.test(String(entry)) ? 'anthropic-messages' : 'openai-chat');
      const entryDir = path.join(baseDir, entryFolder);
      await fs.mkdir(entryDir, { recursive: true });
      await fs.writeFile(path.join(entryDir, `${effectiveId}_provider-request.json`), JSON.stringify(payload, null, 2), 'utf-8');
    } catch { /* ignore */ }

    // Strip internal metadata before sending
    const wirePayload = (() => {
      const p = { ...(payload as any) } as Record<string, unknown>;
      delete (p as any)._metadata;
      delete (p as any).metadata;
      return p;
    })();

    // Use base class sendRequest for retry logic
    const response = await super.sendRequest(wirePayload, endpoint);

    // Persist response for debugging
    try {
      const baseDir = path.join(homedir(), '.routecodex', 'codex-samples');
      const effectiveId = requestId;
      const entry = (request as any)?.metadata?.entryEndpoint || '';
      const entryFolder = /\/v1\/responses/i.test(String(entry))
        ? 'openai-responses'
        : (/\/v1\/messages/i.test(String(entry)) ? 'anthropic-messages' : 'openai-chat');
      const entryDir = path.join(baseDir, entryFolder);
      await fs.mkdir(entryDir, { recursive: true });
      await fs.writeFile(path.join(entryDir, `${effectiveId}_provider-response.json`), JSON.stringify(response.data, null, 2), 'utf-8');
    } catch { /* ignore */ }

    return {
      ...response,
      metadata: {
        ...response.metadata,
        requestId,
        processingTime: Date.now() - start,
        model: (request as any)?.model
      }
    };
  }

  getStatus(): { id: string; type: string; providerType: string; isInitialized: boolean; hasAuth: boolean } {
    return {
      id: this.id,
      type: this.type,
      providerType: this.providerType,
      isInitialized: this.isInitialized,
      hasAuth: !!this.authContext
    };
  }
}

export default GenericOpenAIProvider;
