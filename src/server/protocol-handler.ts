import express, { type Request, type Response, type Router } from 'express';
import axios from 'axios';
import { BaseModule, type ModuleInfo } from 'rcc-basemodule';

import { RequestHandler } from '../core/request-handler.js';
import { ProviderManager } from '../core/provider-manager.js';
import { ModuleConfigReader } from '../utils/module-config-reader.js';
import {
  ServiceContainer,
  initializeDefaultServices,
  ServiceTokens
} from './core/service-container.js';
import { ChatCompletionsHandler } from './handlers/chat-completions.js';
import { CompletionsHandler } from './handlers/completions.js';
import { EmbeddingsHandler } from './handlers/embeddings.js';
import { ModelsHandler } from './handlers/models.js';
import { MessagesHandler } from './handlers/messages.js';
import { ResponsesHandler } from './handlers/responses.js';
import { OpenAIStreamer } from './streaming/openai-streamer.js';
import { AnthropicStreamer } from './streaming/anthropic-streamer.js';
import { ResponsesStreamer } from './streaming/responses-streamer.js';
import { MonitorConfigUtil } from '../modules/monitoring/monitor-config.js';
import { ConfigRequestClassifier, type ConfigClassifierConfig, type ConfigClassificationInput } from '../modules/virtual-router/classifiers/config-request-classifier.js';

export interface ProtocolHandlerConfig {
  enableStreaming?: boolean;
  enableMetrics?: boolean;
  enableValidation?: boolean;
  rateLimitEnabled?: boolean;
  authEnabled?: boolean;
  targetUrl?: string;
  timeout?: number;
  enablePipeline?: boolean;
  pipelineProvider?: {
    defaultProvider: string;
    modelMapping: Record<string, string>;
  };
}

type HandlerMap = {
  chat: ChatCompletionsHandler;
  completions: CompletionsHandler;
  embeddings: EmbeddingsHandler;
  models: ModelsHandler;
  messages: MessagesHandler;
  responses: ResponsesHandler;
};

const DEFAULT_CONFIG: Required<Pick<ProtocolHandlerConfig,
  'enableStreaming' | 'enableMetrics' | 'enableValidation' | 'rateLimitEnabled' | 'authEnabled' | 'timeout' | 'enablePipeline'>> = {
  enableStreaming: true,
  enableMetrics: true,
  enableValidation: true,
  rateLimitEnabled: false,
  authEnabled: false,
  timeout: 30000,
  enablePipeline: false
};

export class ProtocolHandler extends BaseModule {
  private readonly router: Router;
  private readonly serviceContainer: ServiceContainer;
  private readonly handlers: HandlerMap;
  private readonly config: ProtocolHandlerConfig;

  private initialized = false;
  private pipelineManager: unknown = null;
  private routePools: Record<string, string[]> | null = null;
  private routeMeta: Record<string, { providerId: string; modelId: string; keyId?: string }> | null = null;
  private classifierConfig: Record<string, unknown> | null = null;
  private authMappings: Record<string, string> | null = null;
  private classifier: ConfigRequestClassifier | null = null;
  private classifierAdapter: { classify: (payload: unknown) => Promise<unknown> } | null = null;

  constructor(
    _requestHandler: RequestHandler,
    _providerManager: ProviderManager,
    _moduleConfigReader: ModuleConfigReader,
    config: ProtocolHandlerConfig = {}
  ) {
    const moduleInfo: ModuleInfo = {
      id: 'protocol-handler',
      name: 'ProtocolHandler',
      version: '1.0.0',
      description: 'Modular protocol entrypoint',
      type: 'server'
    };

    super(moduleInfo);

    this.router = express.Router();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.serviceContainer = ServiceContainer.getInstance();
    initializeDefaultServices(this.serviceContainer);

    // Enable pipeline specifically for Chat endpoint to route via llmswitch → OpenAI
    this.handlers = {
      chat: new ChatCompletionsHandler({ ...this.config, enablePipeline: true }),
      completions: new CompletionsHandler(this.config),
      embeddings: new EmbeddingsHandler(this.config),
      models: new ModelsHandler(this.config),
      messages: new MessagesHandler(this.config),
      responses: new ResponsesHandler(this.config)
    };

    this.registerRoutes();
  }

  public async initialize(): Promise<void> {
    this.initialized = true;
  }

  public getRouter(): Router {
    return this.router;
  }

  public async stop(): Promise<void> {
    this.initialized = false;
  }

  public attachPipelineManager(pipelineManager: unknown): void {
    this.pipelineManager = pipelineManager;
    Object.values(this.handlers).forEach(handler => handler.attachPipelineManager(pipelineManager));
    try {
      this.serviceContainer.registerInstance(ServiceTokens.PIPELINE_MANAGER, pipelineManager);
    } catch { /* ignore duplicate registrations */ }
  }

  public attachRoutePools(routePools: Record<string, string[]>): void {
    this.routePools = routePools;
    Object.values(this.handlers).forEach(handler => handler.attachRoutePools(routePools));
    try {
      this.serviceContainer.registerInstance(ServiceTokens.ROUTE_POOLS, routePools);
    } catch { /* ignore duplicate registrations */ }
  }

  public attachRouteMeta(routeMeta: Record<string, { providerId: string; modelId: string; keyId: string }>): void {
    this.routeMeta = routeMeta;
    Object.values(this.handlers).forEach(handler => handler.attachRouteMeta(routeMeta));
    try {
      this.serviceContainer.registerInstance(ServiceTokens.ROUTE_META, routeMeta);
    } catch { /* ignore duplicate registrations */ }
  }

  public attachRoutingClassifierConfig(classifierConfig: Record<string, unknown>): void {
    this.classifierConfig = classifierConfig;
    try {
      const typedConfig = classifierConfig as unknown as ConfigClassifierConfig;
      this.classifier = new ConfigRequestClassifier(typedConfig);
      this.classifierAdapter = {
        classify: async (payload: unknown) => {
          return this.classifier!.classify(payload as ConfigClassificationInput);
        }
      };
    } catch {
      this.classifier = null;
      this.classifierAdapter = null;
    }

    Object.values(this.handlers).forEach(handler => {
      handler.attachRoutingClassifierConfig(classifierConfig);
      if (this.classifierAdapter) {
        handler.attachRoutingClassifier(this.classifierAdapter);
      }
    });

    if (this.classifierAdapter) {
      try {
        this.serviceContainer.registerInstance(ServiceTokens.ROUTING_CLASSIFIER, this.classifierAdapter);
      } catch { /* ignore duplicate registrations */ }
    }
  }

  public attachAuthMappings(authMappings: Record<string, string>): void {
    this.authMappings = authMappings;
  }

  public async streamFromPipeline(
    response: unknown,
    requestId: string,
    res: Response,
    model?: string,
    protocol: 'openai' | 'anthropic' | 'responses' = 'openai'
  ): Promise<void> {
    const options = { requestId, model: model ?? 'unknown', chunkDelay: 25 };

    // Build synthetic chunk list for non-stream responses
    const makeOpenAIChunks = (resp: any) => {
      const chunks: any[] = [];
      try {
        const msg = resp?.choices?.[0]?.message || {};
        const content = typeof msg?.content === 'string' ? msg.content : '';
        const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];

        // 1) Emit content as-is to preserve newlines
        if (content.length > 0) {
          chunks.push({ metadata: { model: options.model }, content, done: false });
        }

        // 2) Emit tool_calls as OpenAI-style delta.tool_calls
        if (toolCalls.length > 0) {
          for (let i = 0; i < toolCalls.length; i++) {
            const tc = toolCalls[i] || {};
            const fn = tc.function || {};
            const id = typeof tc.id === 'string' ? tc.id : undefined;
            const name = typeof fn.name === 'string' ? fn.name : undefined;
            const args = typeof fn.arguments === 'string' ? fn.arguments : (fn.arguments != null ? JSON.stringify(fn.arguments) : undefined);

            // Emit name delta (optional, but helps some clients)
            if (name) {
              chunks.push({
                metadata: { model: options.model },
                content: '',
                tool_calls: [{ index: i, id, type: 'function', function: { name } }],
                done: false,
              });
            }
            // Emit arguments delta as a single chunk (clients accumulate string)
            if (args) {
              chunks.push({
                metadata: { model: options.model },
                content: '',
                tool_calls: [{ index: i, id, type: 'function', function: { arguments: args } }],
                done: false,
              });
            }
          }
        }
      } catch { /* ignore */ }

      // 3) Final chunk with usage and finish_reason
      const finish = (resp?.choices?.[0]?.message?.tool_calls?.length || 0) > 0
        ? 'tool_calls'
        : (resp?.choices?.[0]?.finish_reason || resp?.finish_reason || 'stop');
      chunks.push({ metadata: { model: options.model, usage: resp?.usage, finish_reason: finish }, content: '', done: true });
      return chunks;
    };

    const makeAnthropicChunks = (resp: any) => {
      const chunks: any[] = [];
      try {
        const blocks = Array.isArray(resp?.content) ? resp.content : [];
        for (const b of blocks) {
          if (b && b.type === 'text' && typeof b.text === 'string') {
            const words = b.text.split(/\s+/g);
            for (const w of words) {
              chunks.push({ metadata: { model: options.model }, content: w + ' ', done: false });
            }
          }
        }
      } catch { /* ignore */ }
      chunks.push({ metadata: { model: options.model, usage: resp?.usage }, content: '', done: true });
      return chunks;
    };

    if (protocol === 'anthropic') {
      const streamer = new AnthropicStreamer(this.config);
      const resp = (response && typeof response === 'object' && 'data' in (response as any)) ? (response as any).data : response;
      const chunks = Array.isArray((resp as any)) || (resp && typeof resp === 'object' && Array.isArray((resp as any).data))
        ? resp
        : makeAnthropicChunks(resp);
      await streamer.streamResponse(chunks, options, res);
      return;
    }

    if (protocol === 'responses') {
      const streamer = new ResponsesStreamer(this.config);
      const resp = (response && typeof response === 'object' && 'data' in (response as any)) ? (response as any).data : response;
      const chunks = Array.isArray((resp as any)) || (resp && typeof resp === 'object' && Array.isArray((resp as any).data))
        ? resp
        : makeOpenAIChunks(resp);
      await streamer.streamResponse(chunks, options, res);
      return;
    }

    const streamer = new OpenAIStreamer(this.config);
    const resp = (response && typeof response === 'object' && 'data' in (response as any)) ? (response as any).data : response;
    const chunks = Array.isArray((resp as any)) || (resp && typeof resp === 'object' && Array.isArray((resp as any).data))
      ? resp
      : makeOpenAIChunks(resp);
    await streamer.streamResponse(chunks, options, res);
  }

  private registerRoutes(): void {
    this.router.post('/chat/completions', async (req: Request, res: Response) => {
      // Fire side-by-side upstream capture (non-blocking)
      void this.fireMonitorAB(req, 'chat');
      if (await this.tryTransparentOpenAI(req, res, 'chat')) { return; }
      void this.handlers.chat.handleRequest(req, res);
    });

    this.router.post('/completions', (req: Request, res: Response) => {
      void this.handlers.completions.handleRequest(req, res);
    });

    this.router.post('/embeddings', (req: Request, res: Response) => {
      void this.handlers.embeddings.handleRequest(req, res);
    });

    this.router.get('/models', (req: Request, res: Response) => {
      void this.handlers.models.handleRequest(req, res);
    });

    this.router.get('/models/:model', (req: Request, res: Response) => {
      void this.handlers.models.handleRequest(req, res);
    });

    this.router.post('/messages', (req: Request, res: Response) => {
      (async () => {
        // Try transparent passthrough for Anthropic /v1/messages when enabled via monitor config
        if (await (this as unknown as ProtocolHandler).tryTransparentAnthropic?.(req, res)) { return; }
        void this.handlers.messages.handleRequest(req, res);
      })().catch(() => { void this.handlers.messages.handleRequest(req, res); });
    });

    this.router.post('/responses', async (req: Request, res: Response) => {
      // Fire side-by-side upstream capture (non-blocking)
      void this.fireMonitorAB(req, 'responses');
      // Bridge mode: convert to Chat → upstream → back to Responses (JSON) when requested
      if (await this.tryBridgeResponsesToChat(req, res)) { return; }
      // Transparent passthrough only when explicitly enabled
      if (await this.tryTransparentOpenAI(req, res, 'responses')) { return; }
      void this.handlers.responses.handleRequest(req, res);
    });
  }
}

// Transparent passthrough helpers (monitor mode)
export interface TransparentHeaders { [key: string]: string }

export interface TransparentConfig {
  enabled?: boolean;
  defaultUpstream?: 'openai' | 'anthropic';
  endpoints?: { openai?: string; anthropic?: string };
  auth?: { openai?: string; anthropic?: string };
  authorization?: string;
  headerAllowlist?: string[];
  timeoutMs?: number;
  preferClientHeaders?: boolean;
  modelMapping?: Record<string, string>;
  wireApi?: 'chat' | 'responses';
  extraHeaders?: Record<string, string>;
}

export interface MonitorLikeConfig { mode?: string; transparent?: TransparentConfig }

// Extend class with methods via declaration merging pattern
export interface ProtocolHandler {
  tryTransparentOpenAI(req: Request, res: Response, wire: 'chat' | 'responses'): Promise<boolean>;
  tryBridgeResponsesToChat(req: Request, res: Response): Promise<boolean>;
  tryTransparentAnthropic(req: Request, res: Response): Promise<boolean>;
}

ProtocolHandler.prototype.tryTransparentOpenAI = async function tryTransparentOpenAI(this: ProtocolHandler, req: Request, res: Response, wire: 'chat' | 'responses'): Promise<boolean> {
  try {
    // Transparent passthrough is active only if explicitly requested via env flags (normal mode ignores monitor.json mode)
    const envTransparent = (
      process.env.ROUTECODEX_MONITOR_TRANSPARENT === '1' ||
      process.env.ROUTECODEX_TRANSPARENT_ROUTING === '1' ||
      process.env.RCC_MONITOR_TRANSPARENT === '1' ||
      process.env.RCC_TRANSPARENT_ROUTING === '1'
    );
    if (!envTransparent) return false;

    const monitorCfg = await MonitorConfigUtil.load();
    const tcfg = MonitorConfigUtil.getTransparent(monitorCfg as MonitorLikeConfig as any) as TransparentConfig | null;
    if (!tcfg) return false;

    // Resolve upstream base
    const hdrUp = (req.headers['x-rc-upstream-url'] as string | undefined) || (req.headers['x-rcc-upstream-url'] as string | undefined);
    const upstreamBase = hdrUp || tcfg.endpoints?.openai || '';
    if (!upstreamBase) return false;

    // Decide wire API
    const preferWire: 'chat' | 'responses' = wire || tcfg.wireApi || 'responses';
    const targetPath = preferWire === 'chat' ? '/chat/completions' : '/responses';
    const url = joinUrl(upstreamBase, targetPath);

    // Compose headers
    const overrideAuth = (req.headers['x-rcc-upstream-authorization'] as string | undefined) || (req.headers['x-rc-upstream-authorization'] as string | undefined);
    const incomingAuth = (req.headers['authorization'] as string | undefined) || (req.headers['Authorization'] as unknown as string | undefined);
    const envAuth = tcfg.auth?.openai || undefined;
    const allowlist = (tcfg.headerAllowlist || ['accept','content-type','x-*']).map(h => h.toLowerCase());
    const passHeader = (key: string): boolean => {
      const k = key.toLowerCase();
      if (allowlist.includes(k)) return true;
      if (allowlist.some(x => x.endsWith('*') && k.startsWith(x.slice(0, -1)))) return true;
      return false;
    };
    const headers: TransparentHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (!passHeader(k)) continue;
      headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
    }
    const normalizeBearerAuth = (val: string): string => {
      const s = String(val || '').trim();
      if (!s) return s;
      return /^bearer\s+/i.test(s) ? s : `Bearer ${s}`;
    };
    const finalAuth = overrideAuth || envAuth || incomingAuth || tcfg.authorization || undefined;
    if (finalAuth) {
      const bearer = normalizeBearerAuth(finalAuth);
      headers['authorization'] = bearer;
      headers['Authorization'] = bearer;
    }
    // Attach extra headers (do not override Authorization)
    if (tcfg.extraHeaders) {
      for (const [ek, ev] of Object.entries(tcfg.extraHeaders)) {
        if (!ek) continue; if (ek.toLowerCase() === 'authorization') continue;
        headers[ek] = ev;
      }
    }
    // Ensure Beta header for Responses wire
    if (preferWire === 'responses') {
      const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
      if (!('openai-beta' in lower)) headers['OpenAI-Beta'] = 'responses-2024-12-17';
    }

    // Timeout
    const timeout = typeof tcfg.timeoutMs === 'number' ? tcfg.timeoutMs! : 30000;

    // Prepare body and model mapping
    const rawData: any = req.body || {};
    const working = JSON.parse(JSON.stringify(rawData));
    try {
      const mm = tcfg.modelMapping || {};
      const normalizeModel = (model: string): string => {
        const trimmed = String(model || '').trim();
        if (!trimmed) return trimmed;
        if (/gpt-5(?:-codex)?$/i.test(trimmed)) return 'gpt-5';
        if (/glm-4\.6/i.test(trimmed)) return 'gpt-5';
        if (/-codex$/i.test(trimmed)) return trimmed.replace(/-codex$/i, '');
        return trimmed;
      };
      const inputModel = normalizeModel(working.model ?? '');
      let mapped = inputModel && mm[inputModel];
      if (!mapped && mm['*']) mapped = mm['*'];
      if (!mapped && mm['default']) mapped = mm['default'];
      if (!mapped && preferWire === 'responses') {
        mapped = 'gpt-5';
      }
      if (mapped) working.model = normalizeModel(mapped);
      else working.model = inputModel || working.model;
    } catch { /* ignore mapping errors */ }

    const isStream = !!working?.stream;
    if (isStream) {
      let upstream = await axios.post(url, working, { headers: { ...headers, accept: 'text/event-stream' }, timeout, responseType: 'stream', validateStatus: () => true });
      // If chat preferred but not supported, fallback to /responses once
      if (upstream.status >= 400 && preferWire === 'chat') {
        try {
          const altUrl = joinUrl(upstreamBase, '/responses');
          const retry = await axios.post(altUrl, working, { headers: { ...headers, accept: 'text/event-stream', 'OpenAI-Beta': headers['OpenAI-Beta'] || 'responses-2024-12-17' }, timeout, responseType: 'stream', validateStatus: () => true });
          if (retry.status < 400) { upstream = retry; }
        } catch { /* ignore */ }
      }
      try {
        res.status(upstream.status);
        res.setHeader('Content-Type', upstream.headers['content-type'] || 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Transfer-Encoding', 'chunked');
      } catch { /* ignore */ }
      // Capture SSE to file while piping to client
      try {
        const fs = await import('fs');
        const fsp = await import('fs/promises');
        const home = process.env.HOME || process.env.USERPROFILE || '';
        const dirSSE = `${home}/.routecodex/codex-samples/upstream-sse`;
        const dirReq = `${home}/.routecodex/codex-samples/upstream-requests`;
        try { await fsp.mkdir(dirSSE, { recursive: true }); } catch { /* ignore */ }
        try { await fsp.mkdir(dirReq, { recursive: true }); } catch { /* ignore */ }
        const rid = `up_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
        res.setHeader('x-request-id', rid);
        // Write request body for later diff
        try { await fsp.writeFile(`${dirReq}/req-${rid}.json`, JSON.stringify(working, null, 2), 'utf-8'); } catch { /* ignore */ }
        const w = fs.createWriteStream(`${dirSSE}/sse-${rid}.log`, { encoding: 'utf-8' });
        upstream.data.on('data', (chunk: any) => { try { w.write(chunk); } catch { /* ignore */ } });
        upstream.data.on('end', () => { try { w.end(); } catch { /* ignore */ } });
      } catch { /* ignore */ }
      upstream.data.on('error', () => { try { res.end(); } catch { /* ignore */ } });
      upstream.data.pipe(res);
      return true;
    } else {
      let upstream = await axios.post(url, working, { headers: { ...headers, accept: 'application/json' }, timeout, validateStatus: () => true });
      if (upstream.status >= 400 && preferWire === 'chat') {
        try {
          const altUrl = joinUrl(upstreamBase, '/responses');
          const retry = await axios.post(altUrl, working, { headers: { ...headers, accept: 'application/json', 'OpenAI-Beta': headers['OpenAI-Beta'] || 'responses-2024-12-17' }, timeout, validateStatus: () => true });
          if (retry.status < 400) { upstream = retry; }
        } catch { /* ignore */ }
      }
      try {
        res.status(upstream.status);
        for (const [k, v] of Object.entries(upstream.headers || {})) {
          if (k.toLowerCase() === 'content-length') continue;
          try { res.setHeader(k, String(v)); } catch { /* ignore */ }
        }
        res.type('application/json');
        // Capture JSON
        try {
          const { writeFile, mkdir } = await import('fs/promises');
          const home = process.env.HOME || process.env.USERPROFILE || '';
          const dir = `${home}/.routecodex/codex-samples/upstream-json`;
          await mkdir(dir, { recursive: true });
          const rid = `up_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
          res.setHeader('x-request-id', rid);
          await writeFile(`${dir}/json-${rid}.json`, typeof upstream.data === 'string' ? upstream.data : JSON.stringify(upstream.data, null, 2), 'utf-8');
        } catch { /* ignore */ }
        res.send(upstream.data);
      } catch {
        try { res.status(502).json({ error: { message: 'Upstream passthrough failed', type: 'bad_gateway' } }); } catch { /* ignore */ }
      }
      return true;
    }
  } catch {
    return false;
  }
};

// Transparent passthrough for Anthropic /v1/messages using monitor.json
ProtocolHandler.prototype.tryTransparentAnthropic = async function tryTransparentAnthropic(this: ProtocolHandler, req: Request, res: Response): Promise<boolean> {
  try {
    // Only active when transparent routing is explicitly enabled (env or monitor.json)
    const envTransparent = (
      process.env.ROUTECODEX_MONITOR_TRANSPARENT === '1' ||
      process.env.ROUTECODEX_TRANSPARENT_ROUTING === '1' ||
      process.env.RCC_MONITOR_TRANSPARENT === '1' ||
      process.env.RCC_TRANSPARENT_ROUTING === '1'
    );
    const monitorCfg = await MonitorConfigUtil.load();
    const enabled = envTransparent || MonitorConfigUtil.isTransparentEnabled(monitorCfg);
    if (!enabled) return false;

    const tcfg = MonitorConfigUtil.getTransparent(monitorCfg as any) as TransparentConfig | null;
    if (!tcfg || !tcfg.endpoints?.anthropic) return false;

    const upstreamBase = tcfg.endpoints.anthropic;
    const url = joinUrl(upstreamBase, '/messages');

    // Compose headers
    const headers: TransparentHeaders = {};
    // Prefer incoming Authorization, then configured authorization/auth.anthropic
    const overrideAuth = (req.headers['x-rc-upstream-authorization'] as string | undefined) || (req.headers['x-rcc-upstream-authorization'] as string | undefined);
    const incomingAuth = (req.headers['authorization'] as string | undefined) || (req.headers['Authorization'] as unknown as string | undefined);
    const envAuth = tcfg.auth?.anthropic || undefined;
    const finalAuth = overrideAuth || envAuth || incomingAuth || tcfg.authorization || undefined;
    if (finalAuth) {
      const s = String(finalAuth).trim();
      const bearer = /^bearer\s+/i.test(s) ? s : `Bearer ${s}`;
      headers['authorization'] = bearer;
      headers['Authorization'] = bearer;
    }
    // Anthropic-Version default
    const lower = Object.fromEntries(Object.entries(req.headers).map(([k,v]) => [k.toLowerCase(), v]));
    const av = (lower['anthropic-version'] as string | undefined) || '2023-06-01';
    headers['Anthropic-Version'] = av;
    // Pass through common headers (content-type/accept)
    headers['content-type'] = 'application/json';

    const working = JSON.parse(JSON.stringify(req.body || {}));
    const isStream = !!working?.stream;
    const timeout = typeof tcfg.timeoutMs === 'number' ? tcfg.timeoutMs! : 30000;

    if (isStream) {
      const upstream = await axios.post(url, working, { headers: { ...headers, Accept: 'text/event-stream' }, timeout, responseType: 'stream', validateStatus: () => true });
      try {
        res.status(upstream.status);
        res.setHeader('Content-Type', upstream.headers['content-type'] || 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Transfer-Encoding', 'chunked');
      } catch { /* ignore */ }
      // Capture SSE to file while piping to client
      try {
        const fs = await import('fs');
        const fsp = await import('fs/promises');
        const home = process.env.HOME || process.env.USERPROFILE || '';
        const dirSSE = `${home}/.routecodex/codex-samples/upstream-anth-sse`;
        const dirReq = `${home}/.routecodex/codex-samples/upstream-anth-requests`;
        try { await fsp.mkdir(dirSSE, { recursive: true }); } catch {}
        try { await fsp.mkdir(dirReq, { recursive: true }); } catch {}
        const rid = `anth_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
        try { await fsp.writeFile(`${dirReq}/req-${rid}.json`, JSON.stringify(working, null, 2), 'utf-8'); } catch {}
        const w = fs.createWriteStream(`${dirSSE}/sse-${rid}.log`, { encoding: 'utf-8' });
        upstream.data.on('data', (chunk: any) => { try { w.write(chunk); } catch {} });
        upstream.data.on('end', () => { try { w.end(); } catch {} });
      } catch { /* ignore */ }
      upstream.data.on('error', () => { try { res.end(); } catch {} });
      upstream.data.pipe(res);
      return true;
    } else {
      const upstream = await axios.post(url, working, { headers: { ...headers, Accept: 'application/json' }, timeout, validateStatus: () => true });
      try {
        res.status(upstream.status);
        for (const [k, v] of Object.entries(upstream.headers || {})) {
          if (k.toLowerCase() === 'content-length') continue;
          try { res.setHeader(k, String(v)); } catch {}
        }
        res.type('application/json');
        // Capture
        try {
          const { writeFile, mkdir } = await import('fs/promises');
          const home = process.env.HOME || process.env.USERPROFILE || '';
          const dir = `${home}/.routecodex/codex-samples/upstream-anth-json`;
          await mkdir(dir, { recursive: true });
          const rid = `anth_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
          await writeFile(`${dir}/json-${rid}.json`, typeof upstream.data === 'string' ? upstream.data : JSON.stringify(upstream.data, null, 2), 'utf-8');
        } catch { /* ignore */ }
        res.send(upstream.data);
      } catch {
        try { res.status(502).json({ error: { message: 'Upstream passthrough failed', type: 'bad_gateway' } }); } catch {}
      }
      return true;
    }
  } catch {
    return false;
  }
};

function joinUrl(base: string, path: string): string {
  try {
    return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
  } catch { return `${base}${path}`; }
}

// Fire side-by-side upstream request for A/B monitoring without impacting the live response
export interface ProtocolHandler {
  fireMonitorAB(req: Request, wire: 'chat' | 'responses'): Promise<void>;
}

ProtocolHandler.prototype.fireMonitorAB = async function fireMonitorAB(this: ProtocolHandler, req: Request, wire: 'chat' | 'responses'): Promise<void> {
  const home = (process.env.HOME || process.env.USERPROFILE || '') as string;
  const baseDir = `${home}/.routecodex/codex-samples/monitor-ab`;
  let captureDir: string | null = null;
  let captureRid: string | null = null;
  try {
    const monitorCfg = await MonitorConfigUtil.load();
    const mode = (monitorCfg as any)?.mode;
    const envAB = process.env.ROUTECODEX_MONITOR_AB === '1' || process.env.RCC_MONITOR_AB === '1';
    const enabledAB = envAB || mode === 'passive';
    if (!enabledAB) return;

    const tcfg = MonitorConfigUtil.getTransparent(monitorCfg as any) as TransparentConfig | null;
    if (!tcfg || !tcfg.endpoints?.openai) return;

    const upstreamBase = tcfg.endpoints.openai;
    const pathPart = wire === 'chat' ? '/chat/completions' : '/responses';
    const url = joinUrl(upstreamBase, pathPart);

    const headers: Record<string,string> = {};
    // Authorization: prefer explicit embedded token, otherwise reuse client header
    const incomingAuthHeader = (req.headers['authorization'] as string | undefined) || (req.headers['Authorization'] as unknown as string | undefined);
    const auth = tcfg.authorization || tcfg.auth?.openai || incomingAuthHeader || '';
    if (auth) { headers['Authorization'] = /^Bearer\s+/i.test(String(auth)) ? String(auth) : `Bearer ${String(auth)}`; }
    // Responses Beta header if needed
    if (wire === 'responses') { headers['OpenAI-Beta'] = 'responses-2024-12-17'; }
    // Extra headers
    if (tcfg.extraHeaders) { for (const [k,v] of Object.entries(tcfg.extraHeaders)) { if (k.toLowerCase()!=='authorization') headers[k]=v; } }

    // Clone original body before any handler mutation (prefer raw capture)
    const sourceBody: any = (req as any).__rawBody !== undefined ? (req as any).__rawBody : (req as any).body;
    const rawBody: any = sourceBody ? JSON.parse(JSON.stringify(sourceBody)) : {};
    const mappedBody: any = JSON.parse(JSON.stringify(rawBody));


    // Determine capture dir and files
    const startedAt = new Date();
    const fsPromises = await import('fs/promises');
    const { mkdir, writeFile } = fsPromises;
    await mkdir(baseDir, { recursive: true });
    captureRid = `ab_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    captureDir = `${baseDir}/${captureRid}`;
    await mkdir(captureDir, { recursive: true });
    const requestPayload = {
      url,
      wire,
      requested_at: startedAt.toISOString(),
      headers,
      raw_body: rawBody,
      mapped_body: mappedBody
    };
    await writeFile(`${captureDir}/request.json`, JSON.stringify(requestPayload, null, 2), 'utf-8');

    const normalizeHeaders = (h: Record<string, unknown>): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const [hk, hv] of Object.entries(h || {})) {
        if (hv === undefined || hv === null) continue;
        out[hk] = Array.isArray(hv) ? hv.map(v => String(v)).join(', ') : String(hv);
      }
      return out;
    };

    const isStream = !!mappedBody?.stream;
    if (isStream) {
      const resp = await axios.post(url, mappedBody, { headers: { ...headers, Accept: 'text/event-stream', 'Content-Type': 'application/json' }, responseType: 'stream', validateStatus: () => true, timeout: tcfg.timeoutMs || 30000 });
      const responseMeta = {
        status: resp.status,
        statusText: resp.statusText,
        headers: normalizeHeaders(resp.headers || {}),
        received_at: new Date().toISOString()
      };
      await writeFile(`${captureDir}/response-meta.json`, JSON.stringify(responseMeta, null, 2), 'utf-8');
      await new Promise<void>((resolve) => {
        const fs = require('fs');
        const w = fs.createWriteStream(`${captureDir}/upstream.sse`, { encoding: 'utf-8' });
        resp.data.on('error', (error: unknown) => {
          try { w.end(); } catch { /* ignore */ }
          const errPayload = { message: 'stream error', error: error instanceof Error ? error.message : error };
          if (captureDir) {
            writeFile(`${captureDir}/response-error.json`, JSON.stringify(errPayload, null, 2), 'utf-8').catch(() => { /* ignore */ });
          }
          resolve();
        });
        resp.data.on('end', () => { try { w.end(); } catch { /* ignore */ } resolve(); });
        resp.data.pipe(w);
      });
    } else {
      const resp = await axios.post(url, mappedBody, { headers: { ...headers, Accept: 'application/json', 'Content-Type': 'application/json' }, validateStatus: () => true, timeout: tcfg.timeoutMs || 30000 });
      const responseMeta = {
        status: resp.status,
        statusText: resp.statusText,
        headers: normalizeHeaders(resp.headers || {}),
        received_at: new Date().toISOString()
      };
      await writeFile(`${captureDir}/response-meta.json`, JSON.stringify(responseMeta, null, 2), 'utf-8');
      await writeFile(`${captureDir}/upstream.json`, typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data, null, 2), 'utf-8');
    }
  } catch (err) {
    try {
      const fsPromises = await import('fs/promises');
      const { mkdir, writeFile } = fsPromises;
      await mkdir(baseDir, { recursive: true });
      let dir = captureDir;
      if (!dir) {
        captureRid = `ab_err_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
        dir = `${baseDir}/${captureRid}`;
        await mkdir(dir, { recursive: true });
      }
      const errorPayload = {
        message: 'monitor AB capture failed',
        rid: captureRid,
        error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err
      };
      await writeFile(`${dir}/error.json`, JSON.stringify(errorPayload, null, 2), 'utf-8');
    } catch { /* ignore secondary errors */ }
    // swallow errors (AB capture must be non-intrusive)
  }
};

// Bridge: convert Responses→Chat, call upstream Chat, then convert back to Responses and return to client (JSON only).
ProtocolHandler.prototype.tryBridgeResponsesToChat = async function tryBridgeResponsesToChat(this: ProtocolHandler, req: Request, res: Response): Promise<boolean> {
  try {
    const bridgeEnabled = (req.headers['x-rc-bridge-chat'] === '1') || (process.env.ROUTECODEX_BRIDGE_CHAT === '1');
    if (!bridgeEnabled) return false;

    const monitorCfg = await MonitorConfigUtil.load();
    const tcfg = MonitorConfigUtil.getTransparent(monitorCfg as any) as TransparentConfig | null;
    if (!tcfg || !tcfg.endpoints?.openai) return false;
    const upstreamBase = tcfg.endpoints.openai;
    const url = joinUrl(upstreamBase, '/chat/completions');
    const headers: Record<string,string> = {};
    const auth = (tcfg as any)?.auth?.openai || (tcfg as any)?.authorization || '';
    if (auth) { headers['Authorization'] = /^Bearer\s+/i.test(String(auth)) ? String(auth) : `Bearer ${String(auth)}`; }
    if (tcfg.extraHeaders) { for (const [k,v] of Object.entries(tcfg.extraHeaders)) { if (k.toLowerCase()!=='authorization') headers[k]=v; } }

    // Convert incoming Responses payload to Chat
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ResponsesToChatLLMSwitch } = require('../modules/llmswitch/llmswitch-response-chat.js');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PipelineDebugLogger } = require('../utils/debug-logger.js');
    const logger = new PipelineDebugLogger(null, { enableConsoleLogging: false, enableDebugCenter: false });
    const deps = { errorHandlingCenter: {}, debugCenter: {}, logger } as any;
    const conv = new ResponsesToChatLLMSwitch({ type: 'llmswitch-response-chat', config: {} }, deps);
    if (typeof conv.initialize === 'function') { await conv.initialize(); }
    const chatReq: any = await conv.transformRequest(req.body);

    // Apply model mapping only to upstream
    try {
      const mm = tcfg.modelMapping || {};
      const normalizeModel = (model: string): string => {
        const val = String(model || '').trim();
        if (!val) return val;
        if (/gpt-5(?:-codex)?$/i.test(val)) return 'gpt-5-high';
        if (/glm-4\.6/i.test(val)) return 'gpt-5-high';
        if (/-codex$/i.test(val)) return val.replace(/-codex$/i, '');
        return val;
      };
      const src = normalizeModel(chatReq?.model ?? '');
      let mapped = src && mm[src];
      if (!mapped && mm['*']) mapped = mm['*'];
      if (!mapped && mm['default']) mapped = mm['default'];
      if (!mapped) mapped = src;
      chatReq.model = normalizeModel(mapped);
    } catch { /* ignore */ }

    // Force non-stream upstream for simpler conversion back
    chatReq.stream = false;
    const upstream = await axios.post(url, chatReq, { headers: { ...headers, Accept: 'application/json', 'Content-Type': 'application/json' }, validateStatus: () => true, timeout: tcfg.timeoutMs || 30000 });

    // Convert Chat JSON back to Responses JSON
    const responsesJson = await conv.transformResponse(upstream.data);
    res.status(upstream.status);
    try { res.setHeader('Content-Type', 'application/json'); } catch { /* ignore */ }
    res.send(responsesJson);
    return true;
  } catch {
    return false;
  }
};
