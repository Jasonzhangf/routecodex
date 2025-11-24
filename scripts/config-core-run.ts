import { loadSystemConfig, loadUserConfig } from 'rcc-config-core';
import { buildCanonical } from 'rcc-config-core';
import { exportAssemblerConfigV2 } from 'rcc-config-core';
import { writeArtifacts } from 'rcc-config-core';
import path from 'path';
import fs from 'node:fs/promises';

async function main() {
  const systemPath = process.env.RCC_SYSTEM_CONFIG || './config/modules.json';
  const userPath = process.env.RCC_USER_CONFIG || (process.env.HOME ? `${process.env.HOME}/.routecodex/config.json` : './routecodex.json');
  const outDir = path.dirname(userPath);

  const sys = await loadSystemConfig(systemPath);
  const usr = await loadUserConfig(userPath);
  if (!sys.ok) {
    console.error('[config-core] system config invalid:', sys.errors);
    process.exit(2);
  }
  if (!usr.ok) {
    console.error('[config-core] user config invalid:', usr.errors);
    process.exit(2);
  }

  const canonical = buildCanonical(sys, usr, { keyDimension: (process.env.RCC_KEY_DIMENSION as any) || 'perKey' });
  const assemblerConfig = exportAssemblerConfigV2(canonical);
  await writeArtifacts(outDir, {
    systemParsed: sys.data,
    userParsed: usr.data,
    canonical,
    assemblerConfig,
    merged: canonical
  });
  await writeUnifiedPipelineConfig(outDir, assemblerConfig, canonical);
  console.log('[config-core] artifacts written to', outDir);
  console.log('[config-core] merged-config.*.json path:', path.join(outDir, 'merged-config.<port>.json'));
}

async function writeUnifiedPipelineConfig(outDir: string, assemblerConfig: unknown, canonical: any): Promise<void> {
  const targetPath = path.join(outDir, 'pipeline-config.generated.json');

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

    await fs.writeFile(targetPath, JSON.stringify(payload, null, 2), 'utf-8');
    console.log('[config-core] pipeline config written to', targetPath);
  } catch (error) {
    console.error('[config-core] Failed to write unified pipeline config:', error instanceof Error ? error.message : error);
    throw error;
  }
}

main().catch((e) => { console.error('[config-core] failed:', e?.message || e); process.exit(1); });
