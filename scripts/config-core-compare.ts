import fs from 'fs';
import path from 'path';
import os from 'os';

function readJson(p: string): any {
  const abs = p.startsWith('.') || !path.isAbsolute(p) ? path.resolve(process.cwd(), p) : p;
  const raw = fs.readFileSync(abs, 'utf-8');
  return JSON.parse(raw);
}

function safe<T>(fn: () => T, def: T): T { try { return fn(); } catch { return def; } }

function summarizeModules(p: any) {
  const m = p?.modules || {};
  return {
    provider: m.provider?.type,
    compatibility: m.compatibility?.type,
    llmSwitch: m.llmSwitch?.type
  };
}

function main() {
  const corePacPath = './config/pipeline_assembler.core.json';
  const generatedPipelinePath =
    process.argv[2] ||
    path.join(os.homedir(), '.routecodex', 'config', 'generated', 'pipeline-config.generated.json');
  if (!fs.existsSync(corePacPath)) {
    console.error('[compare] core assembler not found:', corePacPath);
    process.exit(2);
  }
  if (!fs.existsSync(generatedPipelinePath)) {
    console.error('[compare] generated pipeline config not found:', generatedPipelinePath);
    process.exit(2);
  }

  const core = readJson(corePacPath);
  const legacy = readJson(generatedPipelinePath);
  const corePac = core?.config || core;
  const legacyPac = legacy?.pipeline_assembler?.config || {};

  const corePipes = safe(() => corePac.pipelines as any[], []);
  const legacyPipes = safe(() => legacyPac.pipelines as any[], []);

  const coreRoutePools = safe(() => corePac.routePools as Record<string, string[]>, {});
  const legacyRoutePools = safe(() => legacyPac.routePools as Record<string, string[]>, {});

  console.log('== Pipelines count ==');
  console.log('core:', corePipes.length, 'legacy:', legacyPipes.length);

  const cats = Array.from(new Set([...Object.keys(coreRoutePools), ...Object.keys(legacyRoutePools)])).sort();
  console.log('== Categories ==');
  console.log('core:', Object.keys(coreRoutePools).join(','));
  console.log('legacy:', Object.keys(legacyRoutePools).join(','));
  for (const c of cats) {
    const a = coreRoutePools[c] || [];
    const b = legacyRoutePools[c] || [];
    console.log(`cat:${c} len core=${a.length} legacy=${b.length}`);
  }

  const coreFirst = corePipes[0];
  const legacyFirst = legacyPipes[0];
  console.log('== First pipeline modules ==');
  console.log('core:', summarizeModules(coreFirst));
  console.log('legacy:', summarizeModules(legacyFirst));

  // ID delta
  const ids = {
    onlyCore: corePipes.map(p => p.id).filter((id: string) => !(legacyPipes || []).some((q: any) => q.id === id)),
    onlyLegacy: (legacyPipes || []).map((p: any) => p.id).filter((id: string) => !(corePipes || []).some((q: any) => q.id === id)),
  };
  console.log('== Pipeline id deltas ==');
  console.log('only-in-core:', ids.onlyCore);
  console.log('only-in-legacy:', ids.onlyLegacy);
}

main();
