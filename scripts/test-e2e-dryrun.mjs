#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

function findLatestMergedConfig() {
  const dir = path.resolve(process.cwd(), 'config');
  const files = fs.readdirSync(dir)
    .filter(f => /^merged-config\..*\.json$/.test(f))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) throw new Error('No merged-config.*.json found in ./config');
  return path.join(dir, files[0].name);
}

async function main() {
  // Ensure provider dry-run to avoid external requests
  process.env.ROUTECODEX_PROVIDER_DRY_RUN = process.env.ROUTECODEX_PROVIDER_DRY_RUN || '1';

  const mergedPath = process.argv[2] || findLatestMergedConfig();
  const { PipelineAssembler } = await import('../dist/modules/pipeline/config/pipeline-assembler.js');
  const { manager, routePools, routeMeta } = await PipelineAssembler.assembleFromFile(mergedPath);

  const routeNames = Object.keys(routePools || {});
  const firstRoute = routeNames.find(n => (routePools[n] || []).length) || routeNames[0];
  const pipelineId = (routePools[firstRoute] || [])[0];
  if (!pipelineId) throw new Error('No pipeline id found in routePools');
  const meta = (routeMeta && routeMeta[pipelineId]) || { providerId: 'openai', modelId: 'glm-4', keyId: 'key1' };

  const req = {
    data: {
      model: meta.modelId,
      messages: [{ role: 'user', content: 'Hello from dry-run E2E' }],
      stream: false
    },
    route: {
      providerId: meta.providerId,
      modelId: meta.modelId,
      keyId: meta.keyId,
      pipelineId,
      requestId: `req_${Date.now()}`,
      timestamp: Date.now()
    },
    metadata: { source: 'e2e-dryrun', transformations: [], processingTime: 0 },
    debug: { enabled: false, stages: {} }
  };

  const res = await manager.processRequest(req);
  const summary = {
    pipelineId,
    providerDryRun: process.env.ROUTECODEX_PROVIDER_DRY_RUN === '1',
    status: res?.status,
    hasData: !!res?.data,
    content: (() => {
      try {
        const ch = (res?.data?.choices || [])[0];
        return ch?.message?.content || '';
      } catch { return ''; }
    })()
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(e => { console.error('e2e-dryrun failed:', e?.stack || String(e)); process.exit(1); });

