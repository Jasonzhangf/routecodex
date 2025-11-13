import { exportAssemblerConfigV2 } from './export-assembler-v2.js';
import { writeArtifacts } from './write-artifacts.js';
import { writeJsonPretty } from '../interpreter/loaders.js';

function asRecord(v) { return v && typeof v === 'object' ? v : {}; }

export function buildCompatibilityKeyMappings(canonical) {
  const out = { providers: {} };
  try {
    const vault = asRecord(canonical?.keyVault || {});
    for (const [provId, keys] of Object.entries(vault)) {
      const m = {};
      for (const [keyId, meta] of Object.entries(asRecord(keys))) {
        const v = asRecord(meta).value;
        if (typeof v === 'string' && v.trim()) m[keyId] = v.trim();
      }
      if (Object.keys(m).length) out.providers[provId] = m;
    }
  } catch { /* ignore */ }
  return out;
}

export function buildMergedConfig(canonical) {
  const assemblerConfig = exportAssemblerConfigV2(canonical);
  const keyMappings = buildCompatibilityKeyMappings(canonical);
  const merged = {
    providers: canonical.providers,
    keyVault: canonical.keyVault,
    routing: canonical.routing,
    routeMeta: canonical.routeMeta,
    _metadata: canonical._metadata,
    pipeline_assembler: { config: assemblerConfig },
    ...(Object.keys(asRecord(keyMappings.providers)).length ? { compatibilityConfig: { keyMappings } } : {})
  };
  return { merged, assemblerConfig, keyMappings };
}

export async function writeMerged(filePath, merged) {
  // write a single merged file to specific path
  await writeJsonPretty(filePath, merged);
  return filePath;
}

export async function writeAllArtifacts(outDir, canonical) {
  const { merged, assemblerConfig } = buildMergedConfig(canonical);
  await writeArtifacts(outDir, {
    canonical,
    assemblerConfig,
    merged,
  });
  return { merged, assemblerConfig };
}

