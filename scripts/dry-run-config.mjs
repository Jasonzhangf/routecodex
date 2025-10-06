#!/usr/bin/env node
// Virtual router dry-run using default config/config.json

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { resolveFromRepo, readJSON } from './lib/utils.mjs';

async function main() {
  const modulesPath = resolveFromRepo(import.meta.url, 'config/modules.json');
  const configArg = process.argv[2] ? resolveFromRepo(import.meta.url, process.argv[2]) : resolveFromRepo(import.meta.url, 'config/config.json');

  if (!configArg || !fs.existsSync(configArg)) {
    console.error(`Config file not found: ${configArg}`);
    process.exit(1);
  }

  const modulesConfig = readJSON(modulesPath);
  const userConfig = readJSON(configArg);

  const classificationConfig = modulesConfig?.modules?.virtualrouter?.config?.classificationConfig;
  if (!classificationConfig) {
    console.error('classificationConfig missing from config/modules.json');
    process.exit(1);
  }

  const vrDryRunDist = resolveFromRepo(import.meta.url, 'dist/modules/virtual-router/virtual-router-dry-run.js');
  const { VirtualRouterDryRunExecutor } = await import(url.pathToFileURL(vrDryRunDist).href);

  const executor = new VirtualRouterDryRunExecutor({
    enabled: true,
    includeLoadBalancerDetails: true,
    includeHealthStatus: true,
    includeWeightCalculation: true,
    simulateProviderHealth: true,
  });

  await executor.initialize({ classificationConfig });

  const routes = userConfig?.virtualrouter?.routing?.default || [];
  if (!routes.length) {
    console.error('No default routes found in config/config.json');
    process.exit(1);
  }

  const [firstTarget] = routes;
  let providerId;
  let modelId;
  let keyId;

  if (typeof firstTarget === 'string') {
    const parts = firstTarget.split('.');
    providerId = parts[0];
    keyId = parts.length > 1 ? parts[parts.length - 1] : 'default';
    modelId = parts.length > 2 ? parts.slice(1, -1).join('.') : parts[1] || 'unknown-model';
  } else if (firstTarget && typeof firstTarget === 'object') {
    providerId = firstTarget.providerId;
    modelId = firstTarget.modelId;
    keyId = firstTarget.keyId || 'default';
  } else {
    throw new Error('Unsupported routing target format');
  }

  const providerWithKey = `${providerId}_${keyId}`;
  const pipelineId = `${providerWithKey}.${modelId}`;

  const requestPayload = {
    model: modelId,
    messages: [
      { role: 'system', content: 'You are a load balancer diagnostics assistant.' },
      { role: 'user', content: 'Please describe routing decision details.' },
    ],
    max_tokens: 512,
  };

  const result = await executor.executeDryRun({
    request: requestPayload,
    endpoint: '/v1/chat/completions',
    protocol: 'openai',
  });

  console.log('Virtual router dry-run summary');
  console.log('-------------------------------------------');
  console.log(`Config file         : ${configArg}`);
  console.log(`Configured default target : ${typeof firstTarget === 'string' ? firstTarget : JSON.stringify(firstTarget)}`);
  console.log(`Derived pipeline ID       : ${pipelineId}`);
  console.log(`ProviderId (with key)     : ${providerWithKey}`);
  console.log(`ModelId                   : ${modelId}`);
  console.log('Routing decision route:', result.routingDecision?.route || 'N/A');
  console.log('Routing decision confidence:', result.routingDecision?.confidence ?? 'N/A');
  if (result.loadBalancerAnalysis) {
    console.log('Load balancer analysis:');
    console.log(JSON.stringify(result.loadBalancerAnalysis, null, 2));
  }
}

main().catch(err => {
  console.error('config dry-run failed:', err);
  process.exit(1);
});
