#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

function ts() { return new Date().toISOString().replace(/[:.]/g,'-'); }

function ensureDir(p){ return fs.mkdir(p,{recursive:true}); }

function endpointFor(proto){
  switch (proto){
    case 'openai-responses': return '/v1/responses';
    case 'anthropic-messages': return '/v1/messages';
    case 'openai-chat':
    default: return '/v1/chat/completions';
  }
}

async function main(){
  const outRoot = process.argv[2] || path.resolve(process.cwd(),'demo-results','wiring-'+ts());
  await ensureDir(outRoot);

  const { PipelineOrchestrator } = await import(path.resolve(process.cwd(),'dist/modules/pipeline/orchestrator/pipeline-orchestrator.js'));
  const orchestrator = new PipelineOrchestrator();
  await orchestrator.initialize(true);

  const protos = ['openai-chat','openai-responses','anthropic-messages'];
  const results = [];
  for (const providerProtocol of protos){
    const reqEp = endpointFor(providerProtocol);
    const resEp = reqEp + '#response';

    const req = await orchestrator.resolve(reqEp, { phase:'request', providerProtocol, processMode:'chat' }).catch(()=>null);
    const res = await orchestrator.resolve(resEp, { phase:'response', providerProtocol, processMode:'chat' }).catch(()=>null);
    const one = {
      providerProtocol,
      entryEndpoint: reqEp,
      request: req ? {
        id: req.id,
        phase: req.phase,
        streaming: req.streaming,
        processMode: req.processMode,
        nodes: req.nodes.map(n => ({kind:n.kind, impl:n.implementation}))
      } : null,
      response: res ? {
        id: res.id,
        phase: res.phase,
        streaming: res.streaming,
        processMode: res.processMode,
        nodes: res.nodes.map(n => ({kind:n.kind, impl:n.implementation}))
      } : null
    };
    results.push(one);
    const file = path.join(outRoot, `${providerProtocol}.json`);
    await fs.writeFile(file, JSON.stringify(one,null,2),'utf-8');
    console.log('wrote', file);
  }

  // 简单合规性检查（节点族是否包含标准链）
  function checkChain(bp){
    if (!bp) return false;
    const kinds = bp.nodes.map(n=>n.kind);
    return kinds[0]==='sse-input' && kinds.includes('input') && kinds.includes('process') && kinds.includes('output') && kinds.at(-1)==='sse-output';
  }
  const summary = results.map(r=>({
    providerProtocol: r.providerProtocol,
    requestOK: checkChain(r.request),
    responseOK: r.response ? (r.response.nodes[0].kind==='input' && r.response.nodes.at(-1).kind==='sse-output') : false
  }));
  const sumFile = path.join(outRoot,'summary.json');
  await fs.writeFile(sumFile, JSON.stringify(summary,null,2),'utf-8');
  console.log('wrote', sumFile);
}

main().catch(e=>{ console.error('[wiring-dry-run] failed:', e?.message || e); process.exit(1); });

