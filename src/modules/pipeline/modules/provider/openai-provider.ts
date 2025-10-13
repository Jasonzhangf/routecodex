/**
 * OpenAI Provider Implementation
 *
 * Provides a standard OpenAI-compatible provider using the official OpenAI SDK.
 * Supports chat completions, function calling, and streaming responses.
 */

import type { ProviderModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { ProviderConfig, AuthContext, ProviderResponse } from '../../types/provider-types.js';
import type { UnknownObject } from '../../../../types/common-types.js';
import type { SharedPipelineRequest } from '../../../../types/shared-dtos.js';
import { PipelineDebugLogger } from '../../utils/debug-logger.js';
import { DebugEventBus } from "rcc-debugcenter";
import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';
import { createProviderError } from './shared/provider-helpers.js';
import crypto from 'crypto';

/**
 * OpenAI Provider Module
 */
export class OpenAIProvider implements ProviderModule {
  readonly id: string;
  readonly type = 'openai-provider';
  readonly providerType = 'openai';
  readonly config: ModuleConfig;

  private isInitialized = false;
  private logger: PipelineDebugLogger;
  private authContext: AuthContext | null = null;
  private openai: OpenAI | null = null;
  private client: OpenAI | null = null;

  // Debug enhancement properties
  private debugEventBus: DebugEventBus | null = null;
  private isDebugEnhanced = false;
  private providerMetrics: Map<string, { values: number[]; lastUpdated: number }> = new Map();
  private requestHistory: UnknownObject[] = [];
  private errorHistory: UnknownObject[] = [];
  private maxHistorySize = 50;

  constructor(config: ModuleConfig, private dependencies: ModuleDependencies) {
    this.id = `provider-${Date.now()}`;
    this.config = config;
    this.logger = dependencies.logger as PipelineDebugLogger;

    // Initialize debug enhancements
    this.initializeDebugEnhancements();
  }

  // ---- Error normalization helpers (class-local static) ----
  private static isRecord(v: any): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null;
  }

  private static get(obj: any, path: Array<string | number>): any {
    let cur: any = obj;
    for (const key of path) {
      if (!OpenAIProvider.isRecord(cur)) {return undefined;}
      const k = String(key);
      cur = (cur as Record<string, unknown>)[k];
    }
    return cur;
  }

  private static normalizeError(e: any): {
    status?: number; code?: string; message: string; upstream?: Record<string, unknown>;
    causeCode?: string; retryable?: boolean;
  } {
    const r = OpenAIProvider.isRecord(e) ? (e as Record<string, unknown>) : {};
    const resp = OpenAIProvider.isRecord((r as Record<string, unknown>).response) ? ((r as Record<string, unknown>).response as Record<string, unknown>) : undefined;
    const respStatus = typeof resp?.status === 'number' ? (resp.status as number) : undefined;
    const respData = OpenAIProvider.isRecord(resp?.data) ? (resp!.data as Record<string, unknown>) : undefined;

  const directData = OpenAIProvider.isRecord(r.data) ? (r.data as Record<string, unknown>) : undefined;
  const cause = OpenAIProvider.isRecord(r.cause) ? (r.cause as Record<string, unknown>) : undefined;
  const causeCode = typeof cause?.code === 'string' ? (cause.code as string)
    : (typeof r.code === 'string' ? (r.code as string) : undefined);

  const upstreamMsg = (OpenAIProvider.get(respData, ['error','message']) as string)
    || (OpenAIProvider.get(respData, ['message']) as string)
    || (OpenAIProvider.get(directData, ['error','message']) as string)
    || (OpenAIProvider.get(directData, ['message']) as string)
    || (typeof r.message === 'string' ? (r.message as string) : undefined);

    const statusFromObj = (typeof (r as Record<string, unknown>).status === 'number' ? ((r as Record<string, unknown>).status as number) : undefined)
      ?? (typeof (r as Record<string, unknown>).statusCode === 'number' ? ((r as Record<string, unknown>).statusCode as number) : undefined);
  const status = respStatus ?? statusFromObj ?? 500;

  let message = upstreamMsg || (e instanceof Error ? e.message : String(e));
  if (message && /^\[object\s+Object\]$/.test(message)) {
    try {
      message = JSON.stringify(respData ?? directData ?? r);
    } catch {
      message = 'Unknown error';
    }
  }

    const code = (typeof OpenAIProvider.get(respData, ['error','code']) === 'string' ? (OpenAIProvider.get(respData, ['error','code']) as string)
      : (typeof (r as Record<string, unknown>).code === 'string' ? ((r as Record<string, unknown>).code as string) : undefined));

  let retryable = false;
  if (status >= 500 || status === 429) {retryable = true;}
  if (causeCode) {
    const cc = causeCode.toUpperCase();
    if (['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','ECONNRESET','ECONNREFUSED','EAI_AGAIN','ENOTFOUND'].includes(cc)) {
      retryable = true;
    }
  }

    return {
      status,
      code,
      message: String(message),
      upstream: (respData ?? directData ?? undefined) as Record<string, unknown> | undefined,
      causeCode,
      retryable,
    };
  }

/**
   * Initialize debug enhancements
   */
  private initializeDebugEnhancements(): void {
    try {
      this.debugEventBus = DebugEventBus.getInstance();
      this.isDebugEnhanced = true;
      this.logger.logModule(this.id, 'debug-enhancements-enabled');
    } catch (error) {
      this.logger.logModule(this.id, 'debug-enhancements-failed', { error });
    }
  }

  /**
   * Initialize the OpenAI provider
   */
  async initialize(): Promise<void> {
    try {
      this.logger.logModule(this.id, 'initializing', {
        config: this.config
      });

      const providerConfig = this.config.config as ProviderConfig;

      // Validate configuration
      if (!providerConfig.baseUrl && !providerConfig.auth?.apiKey) {
        throw new Error('OpenAI provider requires either baseUrl or apiKey configuration');
      }

      // Initialize OpenAI client
      const openaiConfig: Record<string, unknown> = {
        dangerouslyAllowBrowser: true // Allow browser usage for Node.js environments
      };

      if (providerConfig.baseUrl) {
        openaiConfig.baseURL = providerConfig.baseUrl;
      }

      if (providerConfig.auth?.apiKey) {
        openaiConfig.apiKey = providerConfig.auth.apiKey;
      }

      if (providerConfig.auth?.organization) {
        openaiConfig.organization = providerConfig.auth.organization;
      }

      // Note: timeout is not part of the base config, but we can add it as needed
      if (providerConfig.compatibility?.timeout) {
        openaiConfig.timeout = providerConfig.compatibility.timeout;
      }

      this.openai = new OpenAI(openaiConfig);
      this.client = this.openai;

      // Store auth context
      this.authContext = providerConfig.auth || null;

      // Test connection
      await this.testConnection();

      this.isInitialized = true;
      this.logger.logModule(this.id, 'initialized');

      if (this.isDebugEnhanced) {
        this.publishProviderEvent('initialization-complete', {
          baseUrl: providerConfig.baseUrl,
          hasAuth: !!providerConfig.auth,
          timeout: providerConfig.compatibility?.timeout
        });
      }

    } catch (error) {
      this.logger.logModule(this.id, 'initialization-error', { error });

      if (this.isDebugEnhanced) {
        this.publishProviderEvent('initialization-error', {
          error: error instanceof Error ? error.message : String(error)
        });
      }

      throw error;
    }
  }

  /**
   * Test OpenAI connection
   */
  private async testConnection(): Promise<void> {
    try {
      // Check if this is a compatibility provider (non-OpenAI)
      const providerConfig = this.config.config as ProviderConfig;
      const isCompatibilityProvider = !providerConfig.baseUrl.includes('api.openai.com');

      if (isCompatibilityProvider) {
        // For compatibility providers, just check that the OpenAI client was created
        // Skip the models.list test as it might not be supported
        this.logger.logModule(this.id, 'connection-test-success', {
          note: 'Compatibility provider - models test skipped'
        });
      } else {
        // For real OpenAI, test with models list
        await this.openai!.models.list();
        this.logger.logModule(this.id, 'connection-test-success');
      }
    } catch (error) {
      this.logger.logModule(this.id, 'connection-test-failed', { error });
      throw new Error(`OpenAI connection test failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Send request to OpenAI
   */
  async sendRequest(request: UnknownObject): Promise<ProviderResponse> {
    if (!this.isInitialized) {
      throw new Error('OpenAI provider is not initialized');
    }

    const startTime = Date.now();
    const requestId = this.generateRequestId();

    try {
      this.logger.logModule(this.id, 'sending-request-start', {
        requestId,
        model: (request as { model?: string }).model,
        hasMessages: Array.isArray((request as { messages?: any[] }).messages),
        hasTools: Array.isArray((request as { tools?: any[] }).tools)
      });

      if (this.isDebugEnhanced) {
        this.publishProviderEvent('request-start', {
          requestId,
          model: (request as { model?: string }).model,
          timestamp: startTime
        });
      }

      // Allow per-request API key override via hidden field (e.g., injected from router headers)
      // This does not log secrets and only affects this call.
      let localClient: OpenAI | null = null;
      const overrideKeyRaw = (request as any)?.__rcc_overrideApiKey as string | undefined;
      if (overrideKeyRaw && typeof overrideKeyRaw === 'string') {
        try {
          const key = overrideKeyRaw.toLowerCase().startsWith('bearer ')
            ? overrideKeyRaw.slice(7).trim()
            : overrideKeyRaw.trim();
          const providerConfig = this.config.config as ProviderConfig;
          const cfg: any = {
            dangerouslyAllowBrowser: true,
            apiKey: key,
          };
          if (providerConfig.baseUrl) { cfg.baseURL = providerConfig.baseUrl; }
          localClient = new OpenAI(cfg);
        } catch {
          // Ignore override errors; fall back to default client
          localClient = null;
        }
      }

      // Build chat completion request (use pipeline-assembled provider model; do NOT trust inbound request.model)
      const providerCfg = this.config?.config as ProviderConfig;
      const configuredModel = (providerCfg as any)?.model as string | undefined;
      const routeModel = (request as any)?.route?.modelId as string | undefined;
      const inboundModel = (request as { model?: string }).model as string | undefined;
      const effectiveModel = configuredModel || routeModel || inboundModel;

      const chatRequest: Record<string, unknown> = {
        model: effectiveModel,
        messages: (request as { messages?: any[] }).messages || [],
        temperature: (request as { temperature?: number }).temperature ?? 0.7,
        max_tokens: (request as { max_tokens?: number }).max_tokens,
        top_p: (request as { top_p?: number }).top_p,
        frequency_penalty: (request as { frequency_penalty?: number }).frequency_penalty,
        presence_penalty: (request as { presence_penalty?: number }).presence_penalty,
        stream: (request as { stream?: boolean }).stream ?? false
      };

      // Add tools if provided (non-GLM or already preflighted)
      {
        const tools = (request as { tools?: any[] }).tools;
        if (Array.isArray(tools) && tools.length > 0 && !('tools' in chatRequest)) {
          chatRequest.tools = tools;
          chatRequest.tool_choice = (request as { tool_choice?: string }).tool_choice || 'auto';
        }
      }

      // Add response format if provided
      if ((request as { response_format?: any }).response_format) {
        chatRequest.response_format = (request as { response_format?: any }).response_format;
      }

      // Persist final payload snapshot when debug is enabled
      try {
        const dir = path.join(homedir(), '.routecodex', 'codex-samples');
        await fs.mkdir(dir, { recursive: true });
        const outPath = path.join(dir, `provider-out-openai_${Date.now()}_${Math.random().toString(36).slice(2,8)}.json`);
        await fs.writeFile(outPath, JSON.stringify(chatRequest, null, 2), 'utf-8');
        if (this.isDebugEnhanced) {
          this.publishProviderEvent('request-payload-saved', {
            requestId,
            path: outPath,
            model: (request as { model?: string }).model,
            hasTools: Array.isArray((chatRequest as any).tools),
            vendorBase: (this.config.config as ProviderConfig)?.baseUrl
          });
        }
      } catch { /* noop: optional debug payload save */ void 0; }

      // Send request to OpenAI
      type ChatCreateArg = Parameters<OpenAI['chat']['completions']['create']>[0];
      const response = await (localClient || this.openai)!.chat.completions.create(chatRequest as unknown as ChatCreateArg);

      const processingTime = Date.now() - startTime;
      const providerResponse: ProviderResponse = {
        data: response,
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-request-id': requestId
        },
        metadata: {
          requestId,
          processingTime,
          model: (request as { model?: string }).model as string
        }
      };

      // Capture provider request+response pair for Anthropic-schema replay validation
      try {
        const baseDir = path.join(homedir(), '.routecodex', 'codex-samples');
        const subDir = path.join(baseDir, 'anth-replay');
        await fs.mkdir(subDir, { recursive: true });
        const filePath = path.join(
          subDir,
          `openai-provider-pair_${Date.now()}_${Math.random().toString(36).slice(2,8)}.json`
        );
        const pair = {
          type: 'openai-provider-pair',
          requestId,
          timestamp: Date.now(),
          meta: {
            provider: 'openai',
            model: (request as { model?: string }).model,
            baseURL: (this.config.config as ProviderConfig)?.baseUrl || undefined,
          },
          // OpenAI request payload (includes tools/function.parameters schemas)
          request: chatRequest,
          // Raw OpenAI ChatCompletion response (contains choices[*].message.tool_calls)
          response,
          // Extracted schemas for convenience
          schemas: {
            openai: (chatRequest as any).tools || []
          }
        };
        await fs.writeFile(filePath, JSON.stringify(pair, null, 2), 'utf-8');
      } catch { /* optional capture; ignore on failure */ }

      this.logger.logModule(this.id, 'sending-request-complete', {
        requestId,
        processingTime,
        model: (request as { model?: string }).model
      });

      if (this.isDebugEnhanced) {
        this.publishProviderEvent('request-complete', {
          requestId,
          processingTime,
          success: true,
          model: (request as { model?: string }).model
        });
        this.recordProviderMetric('request_time', processingTime);
        this.addToRequestHistory({
          requestId,
          model: (request as { model?: string }).model,
          processingTime,
          success: true,
          timestamp: Date.now()
        });
      }

      return providerResponse;

    } catch (error) {
      const processingTime = Date.now() - startTime;
      const n = OpenAIProvider.normalizeError(error);
      const message = n.message;

      this.logger.logModule(this.id, 'sending-request-error', {
        requestId,
        error: message,
        processingTime
      });

      if (this.isDebugEnhanced) {
        this.publishProviderEvent('request-error', {
          requestId,
          error: message,
          processingTime,
          model: (request as { model?: string }).model
        });
        this.addToErrorHistory({
          requestId,
          error: message,
          model: (request as { model?: string }).model,
          timestamp: Date.now()
        });
      }

      // Map to ProviderError so router can produce consistent error payloads
      const e = new Error(message) as Error & { status?: number; details?: UnknownObject };
      e.status = n.status ?? 500;
      const providerConfig = this.config.config as ProviderConfig;
      // Compute a non-reversible fingerprint for apiKey to aid 429 tracker without leaking secrets
      let keyFingerprint: string | undefined;
      try {
        const rawKey = (providerConfig?.auth as any)?.apiKey as string | undefined;
        if (rawKey && typeof rawKey === 'string' && rawKey.length > 0) {
          keyFingerprint = `sha256:${crypto.createHash('sha256').update(rawKey).digest('hex').slice(0, 16)}`;
        }
      } catch { /* ignore */ }
      e.details = {
        upstream: (n.upstream as UnknownObject | undefined),
        provider: {
          moduleType: this.type,
          moduleId: this.id,
          vendor: providerConfig?.type || 'openai',
          baseUrl: providerConfig?.baseUrl,
          model: (request as { model?: string }).model || undefined,
        },
        ...(keyFingerprint ? { key: keyFingerprint } : {})
      };
      const providerErr = createProviderError(e, 'server');
      providerErr.retryable = n.retryable === true;
      // If upstream indicates quota/balance issue, avoid retriable marking to prevent noisy loops
      if (/insufficient balance|no resource package|recharge/i.test(message)) {
        providerErr.retryable = false;
      }
      throw providerErr;
    }
  }

  /**
   * Check provider health
   */
  async checkHealth(): Promise<boolean> {
    if (!this.isInitialized) {
      return false;
    }

    try {
      // Check if this is a compatibility provider
      const providerConfig = this.config.config as ProviderConfig;
      const isCompatibilityProvider = !providerConfig.baseUrl.includes('api.openai.com');

      if (isCompatibilityProvider) {
        // For compatibility providers, just check that the OpenAI client exists
        // Skip actual health check as models endpoint might not exist
        if (this.isDebugEnhanced) {
          this.publishProviderEvent('health-check-success', {
            timestamp: Date.now(),
            note: 'Compatibility provider - models health check skipped'
          });
        }
        return true;
      } else {
        // For real OpenAI, test with models list
        await this.openai!.models.list();

        if (this.isDebugEnhanced) {
          this.publishProviderEvent('health-check-success', {
            timestamp: Date.now()
          });
        }
        return true;
      }
    } catch (error) {
      this.logger.logModule(this.id, 'health-check-failed', { error });

      if (this.isDebugEnhanced) {
        this.publishProviderEvent('health-check-failed', {
          error: error instanceof Error ? error.message : String(error),
          timestamp: Date.now()
        });
      }

      return false;
    }
  }

  /**
   * Process incoming request (compatibility with pipeline)
   */
  async processIncoming(request: UnknownObject | SharedPipelineRequest): Promise<ProviderResponse> {
    const payload: UnknownObject = (this.isSharedPipelineRequest(request) ? (request as SharedPipelineRequest).data : request) as UnknownObject;
    return this.sendRequest(payload);
  }

  /**
   * Process outgoing response (compatibility with pipeline)
   */
  async processOutgoing(response: UnknownObject): Promise<UnknownObject> {
    return response;
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    try {
      this.logger.logModule(this.id, 'cleanup-start');

      // Reset state
      this.isInitialized = false;
      this.openai = null;
      this.client = null;
      this.authContext = null;

      this.logger.logModule(this.id, 'cleanup-complete');

      if (this.isDebugEnhanced) {
        this.publishProviderEvent('cleanup-complete', {
          timestamp: Date.now()
        });
      }

    } catch (error) {
      this.logger.logModule(this.id, 'cleanup-error', { error });
      throw error;
    }
  }

  /**
   * Get module status
   */
  getStatus(): {
    id: string;
    type: string;
    providerType: string;
    isInitialized: boolean;
    lastActivity: number;
    hasAuth: boolean;
    debugEnabled: boolean;
  } {
    return {
      id: this.id,
      type: this.type,
      providerType: this.providerType,
      isInitialized: this.isInitialized,
      lastActivity: Date.now(),
      hasAuth: !!this.authContext,
      debugEnabled: this.isDebugEnhanced
    };
  }

  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    return `openai-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private isSharedPipelineRequest(value: any): value is SharedPipelineRequest {
    if (!value || typeof value !== 'object') {return false;}
    const v = value as Record<string, unknown>;
    return 'data' in v && 'route' in v && 'metadata' in v && 'debug' in v;
  }

  /**
   * Record provider metric
   */
  private recordProviderMetric(operationId: string, value: number): void {
    if (!this.isDebugEnhanced) {return;}

    if (!this.providerMetrics.has(operationId)) {
      this.providerMetrics.set(operationId, {
        values: [],
        lastUpdated: Date.now()
      });
    }

    const metric = this.providerMetrics.get(operationId)!;
    metric.values.push(value);
    metric.lastUpdated = Date.now();

    // Keep only last 50 measurements
    if (metric.values.length > 50) {
      metric.values.shift();
    }
  }

  /**
   * Add request to history
   */
  private addToRequestHistory(request: UnknownObject): void {
    if (!this.isDebugEnhanced) {return;}

    this.requestHistory.push(request);

    // Keep only recent history
    if (this.requestHistory.length > this.maxHistorySize) {
      this.requestHistory.shift();
    }
  }

  /**
   * Add error to history
   */
  private addToErrorHistory(error: UnknownObject): void {
    if (!this.isDebugEnhanced) {return;}

    this.errorHistory.push(error);

    // Keep only recent history
    if (this.errorHistory.length > this.maxHistorySize) {
      this.errorHistory.shift();
    }
  }

  /**
   * Publish provider event
   */
  private publishProviderEvent(type: string, data: UnknownObject): void {
    if (!this.isDebugEnhanced || !this.debugEventBus) {return;}

    try {
      this.debugEventBus.publish({
        sessionId: 'system',
        moduleId: this.id,
        operationId: type,
        timestamp: Date.now(),
        type: "start",
        position: 'middle',
        data: {
          providerType: 'openai',
          ...data
        }
      });
    } catch (error) {
      // Silent fail if WebSocket is not available
    }
  }

  /**
   * Get enhanced provider status with debug information
   */
  getEnhancedStatus(): UnknownObject {
    const baseStatus = this.getStatus();

    if (!this.isDebugEnhanced) {
      return baseStatus;
    }

    return {
      ...baseStatus,
      metrics: this.getProviderMetrics(),
      requestHistory: [...this.requestHistory],
      errorHistory: [...this.errorHistory],
      performanceStats: this.getPerformanceStats()
    };
  }

  /**
   * Get provider metrics
   */
  private getProviderMetrics(): Record<string, { count: number; avg: number; min: number; max: number; lastUpdated: number }> {
    const metrics: Record<string, { count: number; avg: number; min: number; max: number; lastUpdated: number }> = {};

    for (const [operationId, metric] of this.providerMetrics.entries()) {
      const values = metric.values;
      if (values.length > 0) {
        metrics[operationId] = {
          count: values.length,
          avg: Math.round(values.reduce((a: number, b: number) => a + b, 0) / values.length),
          min: Math.min(...values),
          max: Math.max(...values),
          lastUpdated: metric.lastUpdated
        };
      }
    }

    return metrics;
  }

  /**
   * Get performance statistics
   */
  private getPerformanceStats(): Record<string, number> {
    const requests = this.requestHistory as Array<{ processingTime?: number }>;
    const errors = this.errorHistory;
    const count = requests.length;
    const total = count > 0 ? requests.reduce((sum, r) => sum + (typeof r.processingTime === 'number' ? r.processingTime : 0), 0) : 0;
    const avg = count > 0 ? Math.round(total / count) : 0;
    const successRate = count > 0 ? (count - errors.length) / count : 0;
    return {
      totalRequests: count,
      totalErrors: errors.length,
      successRate,
      avgResponseTime: avg
    };
  }
}
