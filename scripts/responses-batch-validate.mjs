#!/usr/bin/env node
/**
 * Batch validate /v1/responses against local RouteCodex server.
 * - Sends a matrix of requests (input/messages x stream on/off)
 * - Prints status summary; writes minimal artifacts when RCC_MONITOR_ENABLED=1 is set.
 *
 * Usage:
 *   node scripts/responses-batch-validate.mjs --host 127.0.0.1 --port 5520
 */
import http from 'node:http';

function parseArgs() {
  const args = process.argv.slice(2);
  const cfg = { host: '127.0.0.1', port: 5520 };
  for (let i=0;i<args.length;i++){
    const a=args[i];
    if((a==='--host'||a==='-h')&&args[i+1]){ cfg.host=args[++i]; continue; }
    if((a==='--port'||a==='-p')&&args[i+1]){ cfg.port=Number(args[++i])||5520; continue; }
  }
  return cfg;
}

function postJSON({host,port,path='/v1/responses',body,headers={}}){
  return new Promise((resolve)=>{
    const payload=JSON.stringify(body||{});
    const req=http.request({host,port,path,method:'POST',headers:{'content-type':'application/json', 'content-length': Buffer.byteLength(payload), ...headers}},(res)=>{
      const chunks=[]; res.on('data',(c)=>chunks.push(c));
      res.on('end',()=>{
        const buf=Buffer.concat(chunks);
        resolve({ status: res.statusCode||0, headers: res.headers, body: buf.toString('utf8') });
      });
    });
    req.on('error',(e)=>resolve({ status:0, error:String(e) }));
    req.write(payload); req.end();
  });
}

async function main(){
  const cfg=parseArgs();
  const matrix=[
    { name:'input_nonstream', body:{ model:'glm-4.6', input:'ping', stream:false } },
    { name:'input_stream', body:{ model:'glm-4.6', input:'ping', stream:true } },
    { name:'messages_nonstream', body:{ model:'glm-4.6', messages:[{role:'user', content:'ping'}], stream:false } },
    { name:'messages_stream', body:{ model:'glm-4.6', messages:[{role:'user', content:'ping'}], stream:true } },
  ];
  const results=[];
  for(const t of matrix){
    const res=await postJSON({host:cfg.host,port:cfg.port, body:t.body});
    results.push({ test:t.name, status:res.status, ok: res.status>=200 && res.status<300, hint: res.status===401? 'auth': (res.status===404?'not_found': (res.status===503?'upstream_unavailable':'ok')) });
  }
  console.table(results);
  const summary={ total: results.length, passed: results.filter(r=>r.ok).length, failed: results.filter(r=>!r.ok).length };
  console.log('Summary:', summary);
  process.exit(summary.failed?1:0);
}
main().catch((e)=>{ console.error(e); process.exit(2); });

