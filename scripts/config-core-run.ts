import path from 'path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'url';

const DEFAULT_PIPELINE_CONFIG_FILENAME = 'pipeline-config.generated.json';

async function main() {
  const core = await getConfigCore();
  const systemPath = process.env.RCC_SYSTEM_CONFIG || './config/modules.json';
  const userPath = process.env.RCC_USER_CONFIG || (process.env.HOME ? `${process.env.HOME}/.routecodex/config.json` : './routecodex.json');
  const outDir = path.dirname(userPath);

  const sys = await core.loadSystemConfig(systemPath);
  const usr = await core.loadUserConfig(userPath);
  if (!sys.ok) {
    console.error('[config-core] system config invalid:', sys.errors);
    process.exit(2);
  }
  if (!usr.ok) {
    console.error('[config-core] user config invalid:', usr.errors);
    process.exit(2);
  }

  const canonical = core.buildCanonical(sys, usr, { keyDimension: (process.env.RCC_KEY_DIMENSION as any) || 'perKey' });
  const assemblerConfig = core.exportAssemblerConfigV2(canonical);
  await core.writeArtifacts(outDir, {
    systemParsed: sys.data,
    userParsed: usr.data,
    canonical,
    assemblerConfig,
    merged: canonical
  });
  await writeUnifiedPipelineConfig(outDir, assemblerConfig, canonical);
  await writePortLabeledMergedConfig(outDir, canonical, assemblerConfig);
  console.log('[config-core] artifacts written to', outDir);
  console.log('[config-core] merged-config.*.json path:', path.join(outDir, 'merged-config.<port>.json'));
}

async function writeUnifiedPipelineConfig(outDir: string, assemblerConfig: unknown, canonical: any): Promise<void> {
  const portLabel = resolvePortLabel();
  const primaryFilename = getPipelineConfigFilenameLocal(portLabel);
  const primaryPath = path.join(outDir, primaryFilename);
  const defaultPath = path.join(outDir, DEFAULT_PIPELINE_CONFIG_FILENAME);

  try {
    const conversion = (canonical && typeof canonical === 'object')
      ? (canonical.conversionV3 || canonical.conversion || {})
      : {};
    const pipelineConfig = conversion?.pipelineConfig;
    if (!pipelineConfig || typeof pipelineConfig !== 'object' || !Array.isArray(pipelineConfig.pipelines) || !pipelineConfig.pipelines.length) {
      throw new Error('canonical.conversionV3.pipelineConfig 缺失或无效');
    }

    const payload = {
      assemblerConfig,
      llmSwitch: {
        pipelineConfig
      }
    };

    await fs.mkdir(path.dirname(primaryPath), { recursive: true });
    await fs.writeFile(primaryPath, JSON.stringify(payload, null, 2), 'utf-8');
    if (primaryPath !== defaultPath) {
      await fs.writeFile(defaultPath, JSON.stringify(payload, null, 2), 'utf-8');
    }
    console.log('[config-core] pipeline config written to', primaryPath);
  } catch (error) {
    console.error('[config-core] Failed to write unified pipeline config:', error instanceof Error ? error.message : error);
    throw error;
  }
}

async function writePortLabeledMergedConfig(outDir: string, canonical: any, assemblerConfig: unknown): Promise<void> {
  const portLabel = resolvePortLabel();
  const primaryName = portLabel ? `merged-config.${portLabel}.json` : 'merged-config.generated.json';
  const primaryPath = path.join(outDir, primaryName);
  const fallbackPath = path.join(outDir, 'merged-config.generated.json');

  const mergedPayload = {
    ...(canonical && typeof canonical === 'object' ? canonical : {}),
    pipeline_assembler: { config: assemblerConfig }
  };

  await fs.mkdir(path.dirname(primaryPath), { recursive: true });
  await fs.writeFile(primaryPath, JSON.stringify(mergedPayload, null, 2), 'utf-8');
  if (primaryPath !== fallbackPath) {
    await fs.writeFile(fallbackPath, JSON.stringify(mergedPayload, null, 2), 'utf-8');
  }
  console.log('[config-core] merged-config written to', primaryPath);
}

main().catch((e) => { console.error('[config-core] failed:', e?.message || e); process.exit(1); });

function sanitizePortLabel(value?: string | number | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  if (!trimmed) return undefined;
  const sanitized = trimmed.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
  return sanitized || undefined;
}

function resolvePortLabel(explicit?: string | number): string | undefined {
  const source =
    explicit ??
    process.env.ROUTECODEX_PIPELINE_PORT ??
    process.env.ROUTECODEX_PORT ??
    process.env.RCC_PORT;
  return sanitizePortLabel(source);
}

function getPipelineConfigFilenameLocal(portLabel?: string): string {
  return portLabel ? `pipeline-config.${portLabel}.generated.json` : DEFAULT_PIPELINE_CONFIG_FILENAME;
}

async function getConfigCore(): Promise<any> {
  // 优先使用本地 sharedmodule/config-core（源代码），否则退回已发布的 rcc-config-core
  const localPath = path.resolve(process.cwd(), 'sharedmodule', 'config-core', 'dist', 'index.js');
  try {
    await fs.access(localPath);
    const url = pathToFileURL(localPath).href;
    const mod = await import(url);
    return mod;
  } catch {
    const mod = await import('rcc-config-core');
    return mod as any;
  }
}
