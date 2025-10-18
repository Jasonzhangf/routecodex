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

    this.handlers = {
      chat: new ChatCompletionsHandler(this.config),
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
        const content = resp?.choices?.[0]?.message?.content || '';
        if (typeof content === 'string' && content.length > 0) {
          const words = content.split(/\s+/g);
          for (const w of words) {
            chunks.push({ metadata: { model: options.model }, content: w + ' ', done: false });
          }
        }
      } catch { /* ignore */ }
      chunks.push({ metadata: { model: options.model, usage: resp?.usage }, content: '', done: true });
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
      void this.handlers.messages.handleRequest(req, res);
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
    const finalAuth = overrideAuth || envAuth || incomingAuth || undefined;
    if (finalAuth) { headers['authorization'] = normalizeBearerAuth(finalAuth); }
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
      const inputModel = String(working.model || '').trim();
      let mapped = inputModel && mm[inputModel];
      if (!mapped && mm['*']) mapped = mm['*'];
      if (!mapped && mm['default']) mapped = mm['default'];
      if (!mapped && preferWire === 'responses') {
        // Fallback per environment requirement: upstream only supports gpt-5-codex
        mapped = 'gpt-5-codex';
      }
      if (mapped) working.model = mapped;
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
    // Authorization: prefer explicit embedded token
    const auth = (tcfg as any)?.auth?.openai || (tcfg as any)?.authorization || '';
    if (auth) { headers['Authorization'] = /^Bearer\s+/i.test(String(auth)) ? String(auth) : `Bearer ${String(auth)}`; }
    // Responses Beta header if needed
    if (wire === 'responses') { headers['OpenAI-Beta'] = 'responses-2024-12-17'; }
    // Extra headers
    if (tcfg.extraHeaders) { for (const [k,v] of Object.entries(tcfg.extraHeaders)) { if (k.toLowerCase()!=='authorization') headers[k]=v; } }

    // Clone original body before any handler mutation
    const rawBody: any = (req as any).body ? JSON.parse(JSON.stringify((req as any).body)) : {};
    // Apply model mapping only to upstream clone (does not affect local)
    try {
      if (rawBody && typeof rawBody === 'object' && typeof rawBody.model === 'string') {
        const mm = tcfg.modelMapping || {};
        const src = rawBody.model;
        const mapped = mm[src] || mm['*'] || mm['default'] || null;
        if (mapped) rawBody.model = mapped;
      }
    } catch { /* ignore */ }

    // Determine capture dir and files
    const rid = `ab_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    const home = (process.env.HOME || process.env.USERPROFILE || '') as string;
    const dir = `${home}/.routecodex/codex-samples/monitor-ab/${rid}`;
    const { mkdir, writeFile } = await import('fs/promises');
    await mkdir(dir, { recursive: true });
    await writeFile(`${dir}/request.json`, JSON.stringify({ url, headers, body: rawBody, wire }, null, 2), 'utf-8');

    const isStream = !!rawBody?.stream;
    if (isStream) {
      const resp = await axios.post(url, rawBody, { headers: { ...headers, Accept: 'text/event-stream', 'Content-Type': 'application/json' }, responseType: 'stream', validateStatus: () => true, timeout: tcfg.timeoutMs || 30000 });
      await new Promise<void>((resolve) => {
        const fs = require('fs');
        const w = fs.createWriteStream(`${dir}/upstream.sse`, { encoding: 'utf-8' });
        resp.data.on('error', () => { try { w.end(); } catch { /* ignore */ } resolve(); });
        resp.data.on('end', () => { try { w.end(); } catch { /* ignore */ } resolve(); });
        resp.data.pipe(w);
      });
    } else {
      const resp = await axios.post(url, rawBody, { headers: { ...headers, Accept: 'application/json', 'Content-Type': 'application/json' }, validateStatus: () => true, timeout: tcfg.timeoutMs || 30000 });
      await writeFile(`${dir}/upstream.json`, typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data, null, 2), 'utf-8');
    }
  } catch {
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
      const src = chatReq?.model;
      const mapped = (typeof src === 'string') ? (mm[src] || mm['*'] || mm['default'] || null) : null;
      if (mapped) chatReq.model = mapped;
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
