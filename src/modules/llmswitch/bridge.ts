import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { resolvePipelineConfigCandidates } from '../config/pipeline-config-path.js';

type AnyRecord = Record<string, unknown>;

let pipelineConfigReady = false;
let pipelineConfigPromise: Promise<void> | null = null;
type PipelineConfigDocument = {
  pipelines: AnyRecord[];
};

type CompatibilityProfileInput = {
  requestStages?: string[];
  responseStages?: string[];
  description?: string;
};

type ConversionRuntimeSection = {
  pipelineConfig?: PipelineConfigDocument;
  compatibilityProfiles?: Record<string, CompatibilityProfileInput>;
  defaultCompatibilityProfile?: string;
};

// 单一桥接模块：这是全项目中唯一允许直接 import llmswitch-core 的地方。
// 其它代码（pipeline/provider/server/virtual-router/snapshot）都只能通过这里暴露的统一接口访问 llmswitch-core。
// 默认且唯一引用 sharedmodule/llmswitch-core/dist，本地缺失视为配置错误，直接 fail。

async function importCoreDist(subpath: string): Promise<any> {
  const clean = subpath.replace(/\.js$/i, '');
  const filename = `${clean}.js`;
  // 仅允许 sharedmodule/llmswitch-core/dist
  const __filename = fileURLToPath(import.meta.url);
  const pkgRoot = path.resolve(path.dirname(__filename), '../../..');
  const localDist = path.join(pkgRoot, 'sharedmodule', 'llmswitch-core', 'dist');
  const candidate = path.join(localDist, filename);
  try {
    const url = pathToFileURL(candidate).href;
    return await import(url);
  } catch {
    throw new Error(`[llmswitch-bridge] Unable to load core module "${clean}" from ${candidate}. 请先构建 sharedmodule/llmswitch-core。`);
  }
}

export type BridgeProcessOptions = {
  processMode: 'chat' | 'passthrough';
  providerProtocol?: string;
  providerType?: string;
  profilesPath?: string;
  entryEndpoint?: string;
  // 由宿主提供的“二轮请求”回调，签名不做强约束以兼容现有实现
  invokeSecondRound?: (...args: any[]) => Promise<any>;
};

type CoreBridgeMethod =
  | 'processIncoming'
  | 'processOutgoing'
  | 'processInboundRequest'
  | 'processInboundResponse'
  | 'processOutboundRequest'
  | 'processOutboundResponse';

async function invokeCoreBridge(method: CoreBridgeMethod, payload: AnyRecord, opts: BridgeProcessOptions): Promise<any> {
  await ensurePipelineConfig();
  const mod = await importCoreDist('v2/bridge/routecodex-adapter');
  const fn = (mod as any)?.[method];
  if (typeof fn !== 'function') {
    throw new Error(`[llmswitch-bridge] ${method} not available on core adapter`);
  }
  const baseDir = resolveBaseDir();
  const { processMode, providerProtocol, profilesPath, invokeSecondRound, entryEndpoint, providerType } = opts;
  return await fn(payload, {
    baseDir,
    profilesPath: profilesPath || 'config/conversion/llmswitch-profiles.json',
    processMode,
    providerProtocol,
    providerType,
    entryEndpoint,
    invokeSecondRound
  });
}

export async function bridgeProcessIncoming(request: AnyRecord, opts: BridgeProcessOptions): Promise<AnyRecord> {
  return await invokeCoreBridge('processInboundRequest', request, opts);
}

export async function bridgeProcessOutgoing(response: AnyRecord, opts: BridgeProcessOptions): Promise<AnyRecord> {
  return await invokeCoreBridge('processOutboundResponse', response, opts);
}

export async function bridgeProcessInboundResponse(response: AnyRecord, opts: BridgeProcessOptions): Promise<AnyRecord> {
  return await invokeCoreBridge('processInboundResponse', response, opts);
}

export async function bridgeProcessOutboundRequest(request: AnyRecord, opts: BridgeProcessOptions): Promise<AnyRecord> {
  return await invokeCoreBridge('processOutboundRequest', request, opts);
}

export async function bridgeProcessOutboundResponse(response: AnyRecord, opts: BridgeProcessOptions): Promise<AnyRecord> {
  return await invokeCoreBridge('processOutboundResponse', response, opts);
}

export async function createResponsesSSEStreamFromOpenAI(chatJson: AnyRecord, ctx: AnyRecord): Promise<AnyRecord> {
  const mod = await importCoreDist('v2/conversion/streaming/openai-to-responses-stream');
  const fn = (mod as any)?.createResponsesSSEStreamFromOpenAI;
  if (typeof fn !== 'function') {
    throw new Error('[llmswitch-bridge] createResponsesSSEStreamFromOpenAI not available');
  }
  return await fn(chatJson, ctx);
}

export async function buildResponsesRequestFromChat(chatRequest: AnyRecord): Promise<any> {
  const mod = await importCoreDist('v2/conversion/responses/responses-openai-bridge');
  const builder = mod as any;
  if (typeof builder.buildResponsesRequestFromChat !== 'function') {
    throw new Error('[llmswitch-bridge] buildResponsesRequestFromChat not available');
  }
  return builder.buildResponsesRequestFromChat(chatRequest);
}

export async function writeSnapshotViaHooks(
  channelOrOptions: string | AnyRecord,
  payload?: AnyRecord
): Promise<void> {
  // hooks-integration 由 core 提供；桥接层只负责调用。
  const mod = await importCoreDist('v2/hooks/hooks-integration').catch(() => null);
  const hooks = mod as any;
  if (!hooks || typeof hooks.writeSnapshotViaHooks !== 'function') return;

  const options =
    payload && typeof channelOrOptions === 'string'
      ? { ...payload, channel: (payload as AnyRecord).channel ?? channelOrOptions }
      : channelOrOptions;

  if (!options || typeof options !== 'object') return;
  await hooks.writeSnapshotViaHooks(options);
}

export async function estimateTokens(text: string, model?: string): Promise<number> {
  const mod = await importCoreDist('v2/utils/token-counter').catch(() => null);
  const tc = mod as any;
  if (!tc || typeof tc.estimateTextTokens !== 'function') return 0;
  return await tc.estimateTextTokens(text, model);
}

export async function calculateRequestTokensStrict(request: AnyRecord, model?: string): Promise<{ inputTokens: number; toolTokens?: number }> {
  const mod = await importCoreDist('v2/utils/token-counter');
  const TokenCounter = (mod as any)?.TokenCounter;
  if (!TokenCounter || typeof TokenCounter.calculateRequestTokensStrict !== 'function') {
    throw new Error('[llmswitch-bridge] TokenCounter.calculateRequestTokensStrict not available');
  }
  return await TokenCounter.calculateRequestTokensStrict(
    request,
    typeof model === 'string' && model.trim() ? model.trim() : 'gpt-3.5-turbo'
  );
}

function resolveBaseDir(): string {
  const env = String(process.env.ROUTECODEX_BASEDIR || process.env.RCC_BASEDIR || '').trim();
  if (env) return env;
  try {
    const __filename = fileURLToPath(import.meta.url);
    return path.resolve(path.dirname(__filename), '../../..');
  } catch {
    return process.cwd();
  }
}

async function ensurePipelineConfig(): Promise<void> {
  if (pipelineConfigReady) return;
  if (!pipelineConfigPromise) {
    pipelineConfigPromise = (async () => {
      try {
        const configMod = await importCoreDist('v2/conversion/conversion-v3/config/index');
        const { PipelineConfigManager } = configMod;
        if (PipelineConfigManager.hasConfig()) {
          pipelineConfigReady = true;
          return;
        }
        const configDoc = await loadPipelineConfig();
        PipelineConfigManager.setConfig(configDoc);
        const compatDoc = await loadCompatibilityProfiles();
        if (compatDoc) {
          await registerLlmswitchCompatibilityProfiles(compatDoc);
        }
        pipelineConfigReady = true;
      } catch (error) {
        console.error('[llmswitch-bridge] Failed to initialize pipeline config:', error);
        pipelineConfigReady = false;
      }
    })();
  }
  return pipelineConfigPromise;
}

async function loadPipelineConfig(): Promise<PipelineConfigDocument> {
  const overridePath = process.env.LLMSWITCH_PIPELINE_CONFIG;
  const baseDir = resolveBaseDir();
  const candidates = resolvePipelineConfigCandidates(baseDir, overridePath);
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return await readPipelineConfigFromFile(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  const err = lastError instanceof Error ? lastError : new Error(String(lastError ?? '无法加载 pipeline-config.generated.json'));
  throw err;
}

async function readPipelineConfigFromFile(target: string): Promise<PipelineConfigDocument> {
  const raw = await fs.readFile(target, 'utf-8');
  const parsed = JSON.parse(raw);
  const extracted = extractPipelineConfig(parsed);
  if (!extracted) {
    throw new Error(`File ${target} does not contain a valid pipelineConfig section`);
  }
  return extracted;
}

async function loadCompatibilityProfiles(): Promise<Record<string, CompatibilityProfileInput> | null> {
  const overridePath = process.env.LLMSWITCH_COMPATIBILITY_PROFILES;
  const baseDir = resolveBaseDir();
  const defaultPath = path.join(baseDir, 'config', 'llmswitch', 'compatibility-profiles.json');
  const target = overridePath || defaultPath;
  try {
    const raw = await fs.readFile(target, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      if (parsed.profiles && typeof parsed.profiles === 'object') {
        return parsed.profiles as Record<string, CompatibilityProfileInput>;
      }
      return parsed as Record<string, CompatibilityProfileInput>;
    }
  } catch (error) {
    console.warn(`[llmswitch-bridge] Unable to read compatibility profiles at ${target}:`, error instanceof Error ? error.message : error);
  }
  return null;
}

function extractPipelineConfig(source: unknown): PipelineConfigDocument | null {
  if (!source || typeof source !== 'object') return null;
  const candidate = source as AnyRecord;
  if (Array.isArray((candidate as any).pipelines)) {
    return candidate as PipelineConfigDocument;
  }
  if (candidate.llmSwitch && typeof candidate.llmSwitch === 'object') {
    return extractPipelineConfig(candidate.llmSwitch as AnyRecord);
  }
  if (candidate.pipelineConfig && typeof candidate.pipelineConfig === 'object') {
    return extractPipelineConfig(candidate.pipelineConfig);
  }
  if (candidate.conversionV3 && typeof candidate.conversionV3 === 'object') {
    return extractPipelineConfig(candidate.conversionV3 as AnyRecord);
  }
  if (candidate.conversion && typeof candidate.conversion === 'object') {
    return extractPipelineConfig(candidate.conversion as AnyRecord);
  }
  return null;
}

function extractConversionSection(source: unknown): ConversionRuntimeSection | null {
  if (!source || typeof source !== 'object') return null;
  const obj = source as AnyRecord;
  if ('pipelineConfig' in obj || 'compatibilityProfiles' in obj) {
    return obj as ConversionRuntimeSection;
  }
  if ('conversionV3' in obj) {
    return extractConversionSection(obj.conversionV3);
  }
  if ('conversion' in obj) {
    return extractConversionSection(obj.conversion);
  }
  return null;
}

export async function registerLlmswitchPipelineConfig(
  config: PipelineConfigDocument | AnyRecord | null | undefined
): Promise<boolean> {
  try {
    const pipelineDoc = extractPipelineConfig(config || null);
    if (!pipelineDoc) return false;
    const configMod = await importCoreDist('v2/conversion/conversion-v3/config/index');
    const { PipelineConfigManager } = configMod;
    PipelineConfigManager.setConfig(pipelineDoc);
    pipelineConfigReady = true;
    return true;
  } catch (error) {
    console.error('[llmswitch-bridge] Failed to register llmswitch pipeline config:', error);
    return false;
  }
}

export async function registerLlmswitchCompatibilityProfiles(
  profiles: Record<string, CompatibilityProfileInput> | null | undefined
): Promise<boolean> {
  if (!profiles || typeof profiles !== 'object') return false;
  const entries = Object.entries(profiles).filter(([key, value]) => {
    return typeof key === 'string' && key.trim().length && value && typeof value === 'object';
  });
  if (!entries.length) return false;

  try {
    const compatMod = await importCoreDist('v2/conversion/conversion-v3/compatibility/index');
    const { registerCompatibilityProfiles } = compatMod;
    const normalized: Record<string, CompatibilityProfileInput> = {};
    for (const [name, profile] of entries) {
      normalized[name] = {
        requestStages: Array.isArray(profile.requestStages) ? [...profile.requestStages] : undefined,
        responseStages: Array.isArray(profile.responseStages) ? [...profile.responseStages] : undefined,
        description: profile.description
      };
    }
    registerCompatibilityProfiles(normalized);
    return true;
  } catch (error) {
    console.error('[llmswitch-bridge] Failed to register compatibility profiles:', error);
    return false;
  }
}

export async function applyConversionV3Config(
  conversionConfig: ConversionRuntimeSection | { conversionV3?: ConversionRuntimeSection } | { conversion?: ConversionRuntimeSection } | null | undefined
): Promise<{ pipelineApplied: boolean; compatibilityApplied: boolean }> {
  const section = extractConversionSection(conversionConfig || null);
  if (!section) {
    return { pipelineApplied: false, compatibilityApplied: false };
  }

  const pipelineApplied = section.pipelineConfig
    ? await registerLlmswitchPipelineConfig(section.pipelineConfig)
    : false;

  const compatibilityApplied = section.compatibilityProfiles
    ? await registerLlmswitchCompatibilityProfiles(section.compatibilityProfiles)
    : false;

  return { pipelineApplied, compatibilityApplied };
}
