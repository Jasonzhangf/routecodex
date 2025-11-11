import { loadSystemConfig, loadUserConfig } from 'llmswitch-config-core';
import { buildCanonical } from 'llmswitch-config-core';
import { exportAssemblerConfigV2 } from 'llmswitch-config-core';
import { writeArtifacts } from 'llmswitch-config-core';
import path from 'path';

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
  console.log('[config-core] artifacts written to', outDir);
  console.log('[config-core] merged-config.*.json path:', path.join(outDir, 'merged-config.<port>.json'));
}

main().catch((e) => { console.error('[config-core] failed:', e?.message || e); process.exit(1); });
