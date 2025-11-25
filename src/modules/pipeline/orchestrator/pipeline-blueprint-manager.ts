import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  type PipelineBlueprint,
  type PipelineConfigDocument,
  type PipelineDescriptor,
  type PipelineNodeDescriptor,
  type PipelinePhase,
  type ResolveOptions
} from './types.js';
import { resolvePipelineConfigCandidates } from '../../config/pipeline-config-path.js';

interface LoadOptions {
  configPath?: string;
  baseDir?: string;
  force?: boolean;
}

interface BlueprintCache {
  byId: Map<string, PipelineBlueprint>;
  byEndpoint: Map<PipelinePhase, Map<string, PipelineBlueprint[]>>;
}

const DEFAULT_PHASE: PipelinePhase = 'request';

export class PipelineBlueprintManager {
  private document: PipelineConfigDocument | null = null;
  private sourcePath?: string;
  private cache: BlueprintCache | null = null;

  async ensureLoaded(options: LoadOptions = {}): Promise<void> {
    if (this.document && !options.force) {
      return;
    }
    const { doc, source } = await this.loadDocument(options);
    this.document = doc;
    this.sourcePath = source;
    this.cache = this.buildCache(doc);
  }

  getSourcePath(): string | undefined {
    return this.sourcePath;
  }

  getDocument(): PipelineConfigDocument | null {
    return this.document;
  }

  resolve(entryEndpointRaw: string, options: ResolveOptions = {}): PipelineBlueprint | null {
    if (!this.cache || !this.document) return null;
    const { phase, endpoint } = this.normalizePhaseAndEndpoint(entryEndpointRaw, options.phase);
    const pool = this.cache.byEndpoint.get(phase)?.get(endpoint);
    if (!pool || !pool.length) {
      return null;
    }

    const providerProtocol = this.normalizeProtocol(options.providerProtocol);
    const processMode = this.normalizeProcess(options.processMode);

    const protocolMatches = providerProtocol
      ? pool.filter((bp) => bp.providerProtocols.includes(providerProtocol))
      : [];
    const processMatches = processMode
      ? (protocolMatches.length ? protocolMatches : pool).filter((bp) => bp.processMode === processMode)
      : protocolMatches.length ? protocolMatches : pool;

    return (processMatches.length ? processMatches : pool)[0] ?? null;
  }

  getById(pipelineId: string): PipelineBlueprint | null {
    if (!this.cache) return null;
    return this.cache.byId.get(pipelineId) ?? null;
  }

  listBlueprints(): PipelineBlueprint[] {
    if (!this.cache) return [];
    return Array.from(this.cache.byId.values());
  }

  private async loadDocument(options: LoadOptions): Promise<{ doc: PipelineConfigDocument; source: string }> {
    // 仅消费标准生成路径或显式覆盖路径
    const baseDir = options.baseDir ? path.resolve(options.baseDir) : resolveBaseDir();
    const candidates = resolvePipelineConfigCandidates(baseDir, options.configPath);
    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        const raw = await fs.readFile(candidate, 'utf-8');
        const parsed = JSON.parse(raw);
        const doc = extractPipelineDocument(parsed);
        if (!doc || !Array.isArray(doc.pipelines) || doc.pipelines.length === 0) {
          throw new Error(`[PipelineBlueprintManager] 无效的 pipeline-config：${candidate}`);
        }
        return { doc, source: candidate };
      } catch (error) {
        lastError = error;
      }
    }
    const err = lastError instanceof Error ? lastError : new Error(String(lastError ?? '无法加载 pipeline-config.generated.json'));
    throw err;
  }

  private buildCache(doc: PipelineConfigDocument): BlueprintCache {
    const byId = new Map<string, PipelineBlueprint>();
    const byEndpoint: Map<PipelinePhase, Map<string, PipelineBlueprint[]>> = new Map();
    byEndpoint.set('request', new Map());
    byEndpoint.set('response', new Map());

    for (const descriptor of doc.pipelines) {
      const blueprint = this.createBlueprint(descriptor);
      byId.set(blueprint.id, blueprint);
      const phaseMap = byEndpoint.get(blueprint.phase)!;
      for (const ep of blueprint.entryEndpoints) {
        const normalized = this.normalizeEndpoint(ep);
        const arr = phaseMap.get(normalized) ?? [];
        arr.push(blueprint);
        phaseMap.set(normalized, arr);
      }
    }

    return { byId, byEndpoint };
  }

  private createBlueprint(descriptor: PipelineDescriptor): PipelineBlueprint {
    const phase = inferPhase(descriptor.entryEndpoints);
    const providerProtocols = normalizeProtocols(descriptor.providerProtocols);
    if (!providerProtocols.length) {
      throw new Error(`[PipelineBlueprintManager] 流水线 ${descriptor.id} 缺少 providerProtocols`);
    }
    const processMode = this.normalizeProcess(descriptor.processMode) || 'chat';
    const streaming = this.normalizeStreaming(descriptor.streaming);
    const entryEndpoints = descriptor.entryEndpoints.map((ep) => this.normalizeEndpoint(ep));
    const nodes = (descriptor.nodes || []).map((node) => this.normalizeNode(node));
    if (!nodes.length) {
      throw new Error(`[PipelineBlueprintManager] 流水线 ${descriptor.id} 未定义任何节点`);
    }
    return {
      id: descriptor.id,
      name: descriptor.name,
      phase,
      entryEndpoints,
      providerProtocols,
      processMode,
      streaming,
      nodes
    };
  }

  private normalizeNode(node: PipelineNodeDescriptor): PipelineNodeDescriptor {
    if (!node || typeof node !== 'object') {
      throw new Error('[PipelineBlueprintManager] 无效的节点描述');
    }
    if (!node.id || !node.kind || !node.implementation) {
      throw new Error('[PipelineBlueprintManager] 节点缺少 id/kind/implementation');
    }
    return {
      id: String(node.id),
      kind: node.kind as PipelineNodeDescriptor['kind'],
      implementation: String(node.implementation),
      ...(node.options ? { options: node.options } : {})
    };
  }

  private normalizePhaseAndEndpoint(entryEndpointRaw: string, phaseOverride?: PipelinePhase) {
    const raw = entryEndpointRaw || '';
    const hasResponseSuffix = raw.includes('#response');
    const requestedPhase = phaseOverride ?? (hasResponseSuffix ? 'response' : DEFAULT_PHASE);
    const endpoint = this.normalizeEndpoint(
      requestedPhase === 'response' && !hasResponseSuffix
        ? `${raw}#response`
        : requestedPhase === 'request' && hasResponseSuffix
          ? raw.replace(/#response$/i, '')
          : raw
    );
    return { phase: requestedPhase, endpoint };
  }

  private normalizeEndpoint(value?: string): string {
    if (!value || typeof value !== 'string') return '';
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

  private normalizeStreaming(value?: string): 'auto' | 'always' | 'never' {
    if (!value || typeof value !== 'string') return 'auto';
    const normalized = value.trim().toLowerCase();
    return normalized === 'always' || normalized === 'never' ? normalized : 'auto';
  }
}

function normalizeProtocols(protocols?: string[]): string[] {
  if (!Array.isArray(protocols) || !protocols.length) {
    return [];
  }
  const out = protocols
    .map((p) => (typeof p === 'string' ? p.trim().toLowerCase() : ''))
    .filter(Boolean);
  return Array.from(new Set(out));
}

function inferPhase(entryEndpoints: string[] = []): PipelinePhase {
  return entryEndpoints.some((ep) => typeof ep === 'string' && ep.includes('#response'))
    ? 'response'
    : 'request';
}

function extractPipelineDocument(source: unknown): PipelineConfigDocument | null {
  // 严格模式：只接受顶层 { pipelines: [...] } 结构，不再从 llmSwitch/pipelineConfig 递归解析
  if (!source || typeof source !== 'object') return null;
  const candidate = source as Record<string, any>;
  if (Array.isArray(candidate.pipelines)) {
    return candidate as PipelineConfigDocument;
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
