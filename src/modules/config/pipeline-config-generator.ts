import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import {
  loadSystemConfig,
  loadUserConfig,
  buildCanonical,
  exportAssemblerConfigV2,
  writeConversionArtifacts
} from 'rcc-config-core';
import { getPipelineConfigFilename, getPortLabel } from './pipeline-config-path.js';

interface GenerateOptions {
  baseDir?: string;
  systemConfigPath?: string;
  userConfigPath?: string;
  port?: number | string;
}

const DEFAULT_KEY_DIMENSION = (process.env.RCC_KEY_DIMENSION as any) || 'perKey';

function resolveBaseDir(explicit?: string): string {
  if (explicit && explicit.trim()) {
    return path.resolve(explicit.trim());
  }
  const env = String(process.env.ROUTECODEX_BASEDIR || process.env.RCC_BASEDIR || '').trim();
  if (env) {
    return path.resolve(env);
  }
  return defaultBaseDir();
}

function resolveUserConfigPath(explicit?: string): string {
  if (explicit && explicit.trim()) {
    return path.resolve(explicit.trim());
  }
  const envCandidates = [
    process.env.RCC4_CONFIG_PATH,
    process.env.ROUTECODEX_CONFIG,
    process.env.ROUTECODEX_CONFIG_PATH,
    process.env.RCC_USER_CONFIG
  ].filter(Boolean) as string[];
  for (const candidate of envCandidates) {
    try {
      if (candidate && candidate.trim()) {
        const p = path.resolve(candidate.trim());
        return p;
      }
    } catch { /* ignore */ }
  }
  const home = os.homedir();
  return path.join(home, '.routecodex', 'config.json');
}

function resolveSystemConfigPath(explicit?: string, baseDir?: string): string {
  if (explicit && explicit.trim()) {
    return path.resolve(explicit.trim());
  }
  const env = process.env.RCC_SYSTEM_CONFIG;
  if (env && env.trim()) {
    return path.resolve(env.trim());
  }
  const root = baseDir || resolveBaseDir();
  return path.join(root, 'config', 'modules.json');
}

async function writeUnifiedPipelineConfig(targetPath: string, _assemblerConfig: unknown, canonical: any): Promise<void> {
  const conversion = (canonical && typeof canonical === 'object')
    ? (canonical.conversionV3 || canonical.conversion || {})
    : {};
  const pipelineConfig = conversion?.pipelineConfig;
  if (!pipelineConfig || typeof pipelineConfig !== 'object' || !Array.isArray(pipelineConfig.pipelines) || !pipelineConfig.pipelines.length) {
    throw new Error('[config-core] canonical.conversionV3.pipelineConfig 缺失或无效（无法写出标准 pipeline-config）');
  }
  ensureProviderProtocols(pipelineConfig.pipelines);
  const payload = {
    pipelineConfigVersion: String(pipelineConfig.pipelineConfigVersion || '1.0.0'),
    generatedAt: new Date().toISOString(),
    pipelines: pipelineConfig.pipelines
  };
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, JSON.stringify(payload, null, 2), 'utf-8');
}

export async function generatePipelineConfiguration(options: GenerateOptions = {}): Promise<string> {
  const baseDir = resolveBaseDir(options.baseDir);
  const systemPath = resolveSystemConfigPath(options.systemConfigPath, baseDir);
  const userPath = resolveUserConfigPath(options.userConfigPath);
  const portLabel = getPortLabel(options.port);

  const [sys, usr] = await Promise.all([loadSystemConfig(systemPath), loadUserConfig(userPath)]);
  if (!sys.ok) {
    throw new Error(`[config-core] system config invalid: ${(sys.errors || []).join(', ')}`);
  }
  if (!usr.ok) {
    throw new Error(`[config-core] user config invalid: ${(usr.errors || []).join(', ')}`);
  }

  const canonical = buildCanonical(sys, usr, { keyDimension: DEFAULT_KEY_DIMENSION });
  const assemblerConfig = exportAssemblerConfigV2(canonical);

  // 统一输出到用户目录：~/.routecodex/config/generated
  const generatedDir = path.join(os.homedir(), '.routecodex', 'config', 'generated');
  const primaryFilename = getPipelineConfigFilename(portLabel);
  const primaryPath = path.join(generatedDir, primaryFilename);
  await writeUnifiedPipelineConfig(primaryPath, assemblerConfig, canonical);
  await writeLlmswitchConversionArtifacts(generatedDir, canonical);
  await writeMergedGenerated(generatedDir, portLabel, canonical, assemblerConfig);
  if (portLabel) {
    const defaultPath = path.join(generatedDir, getPipelineConfigFilename(undefined));
    if (defaultPath !== primaryPath) {
      await writeUnifiedPipelineConfig(defaultPath, assemblerConfig, canonical).catch(() => {});
    }
  }
  try {
    console.log(`[config-core] pipeline config regenerated at ${primaryPath}`);
  } catch { /* ignore logging errors */ }
  return primaryPath;
}

function defaultBaseDir(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    return path.resolve(path.dirname(__filename), '../../..');
  } catch {
    return process.cwd();
  }
}

async function writeLlmswitchConversionArtifacts(configDir: string, canonical: any): Promise<void> {
  try {
    await writeConversionArtifacts(configDir, canonical, {
      llmswitchDir: 'llmswitch',
      pipelineFile: 'pipeline-config.json',
      compatibilityFile: 'compatibility-profiles.json'
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[config-core] Failed to write llmswitch conversion artifacts: ${message}`);
  }
}

async function writeMergedGenerated(outDir: string, portLabel: string | undefined, canonical: any, assemblerConfig: unknown): Promise<string> {
  const primaryName = portLabel ? `merged-config.${portLabel}.json` : 'merged-config.generated.json';
  const primaryPath = path.join(outDir, primaryName);
  const fallbackPath = path.join(outDir, 'merged-config.generated.json');
  const compatKeyMappings = buildCompatibilityKeyMappingsFromCanonical(canonical);
  const compatSection = Object.keys(compatKeyMappings.providers).length ? { compatibilityConfig: { keyMappings: compatKeyMappings } } : {};
  const mergedPayload = {
    ...(canonical && typeof canonical === 'object' ? canonical : {}),
    pipeline_assembler: { config: assemblerConfig },
    ...compatSection
  };
  await fs.mkdir(path.dirname(primaryPath), { recursive: true });
  await fs.writeFile(primaryPath, JSON.stringify(mergedPayload, null, 2), 'utf-8');
  if (primaryPath !== fallbackPath) {
    await fs.writeFile(fallbackPath, JSON.stringify(mergedPayload, null, 2), 'utf-8').catch(() => {});
  }
  return primaryPath;
}

function buildCompatibilityKeyMappingsFromCanonical(canonical: any): { providers: Record<string, Record<string, string>> } {
  const out: { providers: Record<string, Record<string, string>> } = { providers: {} };
  try {
    const vault = canonical && typeof canonical === 'object' ? (canonical.keyVault || {}) : {};
    for (const [provId, keys] of Object.entries(vault as Record<string, any>)) {
      const m: Record<string, string> = {};
      for (const [keyId, meta] of Object.entries((keys as Record<string, any>) || {})) {
        const val = meta && typeof meta.value === 'string' ? meta.value.trim() : '';
        if (val) { m[keyId] = val; }
      }
      if (Object.keys(m).length) out.providers[provId] = m;
    }
  } catch { /* ignore */ }
  return out;
}

function ensureProviderProtocols(pipelines: any[]): void {
  for (const pipeline of pipelines) {
    if (Array.isArray(pipeline.providerProtocols) && pipeline.providerProtocols.length > 0) {
      continue;
    }
    const inferred = inferProtocolFromPipeline(pipeline);
    if (inferred) {
      pipeline.providerProtocols = [inferred];
    }
  }
}

function inferProtocolFromPipeline(pipeline: any): string | undefined {
  try {
    const id = typeof pipeline?.id === 'string' ? pipeline.id.toLowerCase() : '';
    const endpoints = Array.isArray(pipeline?.entryEndpoints)
      ? pipeline.entryEndpoints.map((ep: unknown) => (typeof ep === 'string' ? ep.toLowerCase() : ''))
      : [];
    // Gemini generateContent endpoints
    if (id.includes('gemini') || endpoints.some((ep: string) => ep.includes('/v1beta/models:generatecontent'))) {
      return 'gemini-chat';
    }
    if (id.includes('responses') || endpoints.some((ep: string) => ep.includes('/responses'))) {
      return 'openai-responses';
    }
    if (id.includes('anthropic') || endpoints.some((ep: string) => ep.includes('/messages'))) {
      return 'anthropic-messages';
    }
    if (id.includes('responses-openai') || endpoints.some((ep: string) => ep.includes('/v1/chat') || ep.includes('/chat/completions'))) {
      return 'openai-chat';
    }
  } catch {
    // ignore inference errors
  }
  return undefined;
}
