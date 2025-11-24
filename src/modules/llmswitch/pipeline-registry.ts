import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolvePipelineConfigCandidates } from '../config/pipeline-config-path.js';

type PipelineStage = 'inbound' | 'outbound';

interface PipelineRouteConfig {
  id: string;
  name?: string;
  entryEndpoints?: string[];
  providerProtocols?: string[];
  streaming?: string;
  processMode?: string;
  mode?: string;
  stage?: PipelineStage;
  nodes?: Array<Record<string, unknown>>;
}

interface PipelineDocument {
  pipelineConfigVersion?: string;
  pipelines: PipelineRouteConfig[];
}

interface ResolveOptions {
  stage?: PipelineStage;
  providerProtocol?: string;
  processMode?: string;
}

export interface PipelineResolution {
  id: string;
  entryEndpoint: string;
  stage?: PipelineStage;
  processMode: 'chat' | 'passthrough';
  providerProtocol: string;
  streaming?: 'auto' | 'always' | 'never';
  passthrough?: boolean;
  source?: string;
}

class LLMSwitchPipelineRegistry {
  private document: PipelineDocument | null = null;
  private source?: string;
  private version?: string;

  hasDocument(): boolean {
    return !!this.document;
  }

  setDocument(doc: PipelineDocument, meta?: { source?: string; version?: string }): void {
    if (!doc || !Array.isArray(doc.pipelines) || doc.pipelines.length === 0) {
      throw new Error('[LLMSwitchPipelineRegistry] pipelineConfig 内容为空');
    }
    this.document = doc;
    this.source = meta?.source;
    this.version = meta?.version || doc.pipelineConfigVersion;
  }

  getVersion(): string | undefined {
    return this.version;
  }

  resolve(entryEndpointRaw: string, options: ResolveOptions = {}): PipelineResolution | null {
    const entryEndpoint = this.normalizeEndpoint(entryEndpointRaw);
    if (!entryEndpoint) return null;
    const doc = this.document;
    if (!doc) return null;

    const stage = options.stage;
    const providerProtocol = this.normalizeProtocol(options.providerProtocol);
    const preferredProcess = this.normalizeProcess(options.processMode);

    const endpointMatches = doc.pipelines.filter((pipe) => {
      if (!Array.isArray(pipe.entryEndpoints) || pipe.entryEndpoints.length === 0) return false;
      return pipe.entryEndpoints.some((ep) => this.normalizeEndpoint(ep) === entryEndpoint);
    });
    if (!endpointMatches.length) {
      return null;
    }

    const stageMatches = stage
      ? endpointMatches.filter((pipe) => pipe.stage && pipe.stage.toLowerCase() === stage)
      : endpointMatches;
    const stagePool = stage && stageMatches.length ? stageMatches : endpointMatches;

    const providerMatches = providerProtocol
      ? stagePool.filter((pipe) => this.matchesProtocol(pipe, providerProtocol))
      : [];
    const pool = providerMatches.length ? providerMatches : stagePool;

    const processMatches = preferredProcess
      ? pool.filter((pipe) => this.normalizeProcess(pipe.processMode) === preferredProcess)
      : [];
    const finalPool = processMatches.length ? processMatches : pool;
    const target = finalPool[0];
    if (!target) return null;

    const resolvedProcess = this.normalizeProcess(target.processMode) || preferredProcess || 'chat';
    const resolvedProtocol = this.pickProtocol(target, providerProtocol);
    const streaming = this.normalizeStreaming(target.streaming);
    const passthrough = resolvedProcess === 'passthrough' || this.normalizeMode(target.mode) === 'passthrough';

    return {
      id: target.id,
      entryEndpoint,
      stage: (target.stage as PipelineStage | undefined) || stage,
      processMode: resolvedProcess === 'passthrough' ? 'passthrough' : 'chat',
      providerProtocol: resolvedProtocol,
      streaming,
      passthrough,
      source: this.source
    };
  }

  private normalizeEndpoint(value?: string): string {
    if (!value) return '';
    return value.trim().toLowerCase();
  }

  private normalizeProtocol(value?: string): string | undefined {
    if (!value || typeof value !== 'string') return undefined;
    const trimmed = value.trim().toLowerCase();
    return trimmed || undefined;
  }

  private normalizeProcess(value?: string): 'chat' | 'passthrough' | undefined {
    if (!value || typeof value !== 'string') return undefined;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'passthrough') return 'passthrough';
    if (normalized === 'chat') return 'chat';
    return undefined;
  }

  private normalizeStreaming(value?: string): 'auto' | 'always' | 'never' | undefined {
    if (!value || typeof value !== 'string') return undefined;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'auto' || normalized === 'always' || normalized === 'never') {
      return normalized;
    }
    return undefined;
  }

  private normalizeMode(value?: string): 'chat' | 'passthrough' | undefined {
    if (!value || typeof value !== 'string') return undefined;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'passthrough') return 'passthrough';
    if (normalized === 'chat') return 'chat';
    return undefined;
  }

  private matchesProtocol(pipe: PipelineRouteConfig, protocol: string): boolean {
    if (!protocol) return false;
    if (!Array.isArray(pipe.providerProtocols) || pipe.providerProtocols.length === 0) return false;
    return pipe.providerProtocols.some((p) => this.normalizeProtocol(p) === protocol);
  }

  private pickProtocol(pipe: PipelineRouteConfig, fallback?: string): string {
    const fromPipeline = Array.isArray(pipe.providerProtocols) && pipe.providerProtocols.length
      ? this.normalizeProtocol(pipe.providerProtocols[0])
      : undefined;
    return fromPipeline || this.normalizeProtocol(fallback) || 'openai-chat';
  }
}

export const llmswitchPipelineRegistry = new LLMSwitchPipelineRegistry();

let initPromise: Promise<void> | null = null;

export async function ensureLlmswitchPipelineRegistry(options?: { configPath?: string; baseDir?: string; force?: boolean }): Promise<void> {
  if (llmswitchPipelineRegistry.hasDocument() && !options?.force) {
    return;
  }
  if (!initPromise) {
    initPromise = (async () => {
      const { doc, source, version } = await loadPipelineDocument(options);
      llmswitchPipelineRegistry.setDocument(doc, { source, version });
    })().finally(() => {
      initPromise = null;
    });
  }
  return initPromise;
}

async function loadPipelineDocument(options?: { configPath?: string; baseDir?: string }): Promise<{ doc: PipelineDocument; source: string; version?: string }> {
  const baseDir = (options?.baseDir && options.baseDir.trim())
    ? path.resolve(options.baseDir.trim())
    : resolveBaseDir();
  const candidates = resolvePipelineConfigCandidates(baseDir, options?.configPath);

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const raw = await fs.readFile(candidate, 'utf-8');
      const parsed = JSON.parse(raw);
      const doc = extractPipelineDocument(parsed);
      if (!doc) {
        throw new Error('文件缺少 llmSwitch.pipelineConfig 内容');
      }
      return {
        doc,
        source: candidate,
        version: doc.pipelineConfigVersion || parsed?.pipelineConfigVersion || parsed?.llmSwitch?.pipelineConfigVersion
      };
    } catch (error) {
      lastError = error;
    }
  }

  const err = lastError instanceof Error
    ? lastError
    : new Error(String(lastError ?? '无法读取 pipeline-config.generated.json'));
  throw err;
}

function extractPipelineDocument(source: unknown): PipelineDocument | null {
  if (!source || typeof source !== 'object') return null;
  const candidate = source as Record<string, any>;
  if (Array.isArray(candidate.pipelines)) {
    return candidate as PipelineDocument;
  }
  if (candidate.llmSwitch && typeof candidate.llmSwitch === 'object') {
    return extractPipelineDocument(candidate.llmSwitch);
  }
  if (candidate.pipelineConfig && typeof candidate.pipelineConfig === 'object') {
    return extractPipelineDocument(candidate.pipelineConfig);
  }
  return null;
}

function resolveBaseDir(): string {
  const env = String(process.env.ROUTECODEX_BASEDIR || process.env.RCC_BASEDIR || '').trim();
  if (env) {
    return path.resolve(env);
  }
  try {
    const __filename = fileURLToPath(import.meta.url);
    return path.resolve(path.dirname(__filename), '../../..');
  } catch {
    return process.cwd();
  }
}
