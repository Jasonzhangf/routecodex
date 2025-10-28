/**
 * Conversion Router wrapper (sharedmodule)
 * Mirrors root wrapper; imports internal orchestrator; types relaxed.
 */

import { SwitchOrchestrator } from '../conversion/switch-orchestrator.js';
import type { ConversionContext } from '../conversion/types.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import fs from 'fs';

export interface ConversionRouterConfig {
  profilesPath?: string;
  defaultProfile?: string;
}

export class ConversionRouterLLMSwitch {
  readonly id: string;
  readonly type = 'llmswitch-conversion-router';
  readonly protocol = 'switchboard';
  readonly config: any;

  private readonly orchestrator: SwitchOrchestrator;
  private initialized = false;

  constructor(config: any, dependencies: any) {
    this.id = `llmswitch-conversion-router-${Date.now()}`;
    this.config = config;
    const routerConfig = (config?.config as ConversionRouterConfig) || {};

    const here = path.dirname(fileURLToPath(import.meta.url));
    let cursor = here;
    let distRoot: string | null = null;
    for (let i = 0; i < 8; i++) {
      if (path.basename(cursor) === 'dist') { distRoot = cursor; break; }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    const packageRoot = distRoot ? path.dirname(distRoot) : path.resolve(here, '../../..');
    routerConfig.profilesPath = routerConfig.profilesPath || 'config/conversion/llmswitch-profiles.json';
    const profilesRel = routerConfig.profilesPath;
    // Resolve host app root (routecodex package root) robustly:
    // Strategy:
    // 1) try resolve('routecodex/package.json')
    // 2) if missing profiles there, scan upwards from llmswitch-core packageRoot to find a directory that contains profilesRel
    // 3) include process.cwd() as a candidate (dev runs)
    // 4) last resort: keep packageRoot
    let hostRoot = packageRoot;
    const hasProfilesAt = (dir: string): boolean => {
      const target = path.isAbsolute(profilesRel) ? profilesRel : path.join(dir, profilesRel);
      try { return fs.existsSync(target); } catch { return false; }
    };
    // Attempt 1: routecodex package root
    try {
      const req = createRequire(import.meta.url);
      const rcPkg = req.resolve('routecodex/package.json');
      const rcRoot = path.dirname(rcPkg);
      if (hasProfilesAt(rcRoot)) hostRoot = rcRoot;
    } catch { /* ignore */ }
    // Attempt 2: scan upwards from llmswitch-core packageRoot
    if (!hasProfilesAt(hostRoot)) {
      const visited = new Set<string>();
      let cur = packageRoot;
      for (let i = 0; i < 8; i++) {
        if (visited.has(cur)) break;
        visited.add(cur);
        if (hasProfilesAt(cur)) { hostRoot = cur; break; }
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
      }
    }
    // Attempt 3: consider process.cwd() (dev)
    if (!hasProfilesAt(hostRoot)) {
      try {
        const cwd = (typeof process !== 'undefined' && process && typeof process.cwd === 'function') ? process.cwd() : '';
        if (cwd && hasProfilesAt(cwd)) hostRoot = cwd;
      } catch { /* ignore */ }
    }
    (routerConfig as any).baseDir = hostRoot;
    this.orchestrator = new SwitchOrchestrator(dependencies, routerConfig as any);

    const deps = dependencies;
    this.orchestrator.registerFactories({
      'openai-openai': async () => {
        const { OpenAIOpenAIConversionCodec } = await import('../conversion/codecs/openai-openai-codec.js');
        return new OpenAIOpenAIConversionCodec(deps);
      },
      'anthropic-openai': async () => {
        const { AnthropicOpenAIConversionCodec } = await import('../conversion/codecs/anthropic-openai-codec.js');
        return new AnthropicOpenAIConversionCodec(deps);
      },
      'responses-openai': async () => {
        const { ResponsesOpenAIConversionCodec } = await import('../conversion/codecs/responses-openai-codec.js');
        return new ResponsesOpenAIConversionCodec(deps);
      }
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.orchestrator.initialize();
    this.initialized = true;
  }

  async processIncoming(request: any): Promise<any> {
    await this.ensureInitialized();
    const ctx = this.buildContextFromRequest(request);
    const result = await this.orchestrator.prepareIncoming((request as any).data, ctx);
    return {
      ...request,
      data: result.payload,
      metadata: { ...((request as any).metadata || {}), conversionProfileId: result.profile.id }
    };
  }

  async processOutgoing(response: any): Promise<any> {
    await this.ensureInitialized();
    const isDto = response && typeof response === 'object' && 'data' in response && 'metadata' in response;
    const ctx = this.buildContextFromResponse(response);
    const payload = isDto ? (response as any).data : response;
    const result = await this.orchestrator.prepareOutgoing(payload, ctx);
    if (isDto) {
      const existing = (response as any).metadata || { pipelineId: 'conversion-router', processingTime: 0, stages: [] };
      const merged = { ...existing, conversionProfileId: result.profile.id } as any;
      return { ...(response as any), data: result.payload, metadata: merged };
    }
    return result.payload;
  }

  async transformRequest(payload: unknown): Promise<unknown> {
    const dummyRequest: any = {
      data: payload,
      route: { providerId: 'unknown', modelId: 'unknown', requestId: `req_${Date.now()}`, timestamp: Date.now() },
      metadata: {},
      debug: { enabled: false, stages: {} }
    };
    const transformed = await this.processIncoming(dummyRequest);
    return (transformed as any).data;
  }

  async transformResponse(payload: unknown): Promise<unknown> {
    const dummyResponse: any = {
      data: payload,
      metadata: { requestId: `req_${Date.now()}`, pipelineId: 'conversion-router', processingTime: 0, stages: [] }
    };
    const transformed = await this.processOutgoing(dummyResponse) as any;
    return (transformed as any).data;
  }

  async cleanup(): Promise<void> { this.initialized = false; }

  private buildContextFromRequest(request: any): ConversionContext {
    return {
      requestId: request?.route?.requestId,
      endpoint: (request?.metadata as any)?.endpoint,
      entryEndpoint: (request?.metadata as any)?.entryEndpoint,
      targetProtocol: (request?.metadata as any)?.targetProtocol,
      stream: Boolean((request?.data as any)?.stream),
      metadata: request?.metadata as Record<string, unknown> | undefined
    } as any;
  }

  private buildContextFromResponse(response: any): ConversionContext {
    if (response && typeof response === 'object' && 'metadata' in response) {
      const metadata = (response as any).metadata as Record<string, unknown> | undefined;
      return {
        requestId: metadata?.requestId as string | undefined,
        endpoint: metadata?.endpoint as string | undefined,
        entryEndpoint: metadata?.entryEndpoint as string | undefined,
        targetProtocol: metadata?.targetProtocol as string | undefined,
        metadata
      } as any;
    }
    return {} as any;
  }

  private async ensureInitialized(): Promise<void> { if (!this.initialized) await this.initialize(); }
}
