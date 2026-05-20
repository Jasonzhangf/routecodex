#!/usr/bin/env node
/**
 * Windsurf gRPC sequence test
 * 1 InitializeCascadePanelState
 * 2 AddTrackedWorkspace
 * 3 UpdateWorkspaceTrust
 * 4 Heartbeat
 * 5 RawGetChatMessage (streaming)
 */
import * as http2 from 'http2';
import { randomUUID } from 'crypto';
import { createWriteStream } from 'fs';

const PORT = 49485;
const CSRF = 'ce845714-6ac1-45b4-b684-fcddb6c099ce';
const SVC = '/exa.language_server_pb.LanguageServerService';
const API_KEY = 'test-key';

function encVarint(v){
  const b=[];
  if(v<0||v>0x7fffffff){
    let x=BigInt(v)&0xffffffffffffffffn;
    while(true){
      const c=Number(x&0x7fn);
      x>>=7n;
      if(x===0n){b.push(c);break;}
      b.push(c|0x80);
    }
    return Buffer.from(b);
  }
  let x=Number(v);
  do{let c=x&0x7f;x>>>=7;if(x>0)c|=0x80;b.push(c);}while(x>0);
  return Buffer.from(b);
}
const tag=(f,w)=>encVarint((f<<3)|w);
const vF=(f,v)=>Buffer.concat([tag(f,0),encVarint(v)]);
const sF=(f,s)=>{
  const d=Buffer.from(String(s),'utf8');
  return Buffer.concat([tag(f,2),encVarint(d.length),d]);
};
const mF=(f,m)=>{
  if(!m||m.length===0)return Buffer.alloc(0);
  return Buffer.concat([tag(f,2),encVarint(m.length),m]);
};
const boolF=(f,v)=>v?Buffer.concat([tag(f,0),encVarint(1)]):Buffer.alloc(0);

function ts(){
  const n=Date.now(),s=Math.floor(n/1000),ns=(n%1000)*1e6;
  return Buffer.concat([vF(1,s),ns>0?vF(2,ns):Buffer.alloc(0)]);
}

function meta(sid){
  return Buffer.concat([
    sF(1,'windsurf'),sF(2,'2.0.67'),sF(3,API_KEY),sF(4,'en'),
    sF(5,'macos'),sF(7,'2.0.67'),sF(8,'arm64'),
    vF(9,Math.floor(Math.random()*2**48)),
    sF(10,sid||randomUUID()),sF(12,'windsurf'),
  ]);
}

function chatMsg(role,text,cid){
  const src=role==='assistant'?3:1;
  const parts=[sF(1,randomUUID()),vF(2,src),mF(3,ts()),sF(4,cid)];
  if(src===3){
    const ag=sF(1,text);const a=mF(1,ag);parts.push(mF(6,a));
  }else{
    const ig=sF(1,text);const i=mF(1,ig);parts.push(mF(5,i));
  }
  return Buffer.concat(parts);
}

function gFrame(p){return Buffer.concat([Buffer.from([0]),Buffer.from([0,0,0,0]),p]);}

async function unary(path,body,timeout=5000){
  return new Promise((res,rej)=>{
    const cl=http2.connect(`http://localhost:${PORT}`);
    cl.on('error',e=>rej(e));
    const req=cl.request({':method':'POST',':path':path,'content-type':'application/grpc','user-agent':'grpc-node/1.108.2','x-csrf-token':CSRF});
    const t=setTimeout(()=>{req.close();rej(new Error('timeout'));},timeout);
    let full=Buffer.alloc(0);
    let trailers={};
    req.on('data',c=>{full=Buffer.concat([full,c]);});
    req.on('trailers',tr=>{trailers=tr;});
    req.on('end',()=>{
      clearTimeout(t);
      cl.close();
      res({status:String(trailers['grpc-status']??'0'),message:String(trailers['grpc-message']??''),body:full.subarray(5)});
    });
    req.on('error',e=>{clearTimeout(t);cl.close();rej(e);});
    req.write(body);req.end();
  });
}

async function stream(path,body,onChunk,timeout=60000){
  return new Promise((res,rej)=>{
    const cl=http2.connect(`http://localhost:${PORT}`);
    cl.on('error',e=>rej(e));
    const req=cl.request({':method':'POST',':path':path,'content-type':'application/grpc','user-agent':'grpc-node/1.108.2','x-csrf-token':CSRF,'grpc-accept-encoding':'identity,gzip,deflate'});
    const t=setTimeout(()=>{req.close();rej(new Error('timeout'));},timeout);
    let pending=Buffer.alloc(0);
    let chunks=0,totalBytes=0;
    let trailers={};
    req.on('trailers',tr=>{trailers=tr;});
    req.on('data',d=>{
      totalBytes+=d.length;
      pending=Buffer.concat([pending,d]);
      while(pending.length>=5){
        const len=pending.readUInt32BE(1);
        if(pending.length<5+len)break;
        const frame=pending.subarray(5,5+len);
        pending=pending.subarray(5+len);
        chunks++;
        onChunk(frame,chunks);
      }
    });
    req.on('end',()=>{
      clearTimeout(t);
      cl.close();
      res({chunks,totalBytes,status:String(trailers['grpc-status']??'0'),message:String(trailers['grpc-message']??'')});
    });
    req.on('error',e=>{clearTimeout(t);cl.close();rej(e);});
    req.write(body);req.end();
  });
}

function parseRawChat(buf){
  // RawGetChatMessageResponse { delta_message=1 RawChatMessage { text=5,in_progress=6,is_error=7 } }
  let pos=0;
  const rv=()=>{let r=0,s=0;while(pos<buf.length){const c=buf[pos++];r|=(c&0x7f)<<s;if(!(c&0x80))return r;s+=7;}return null;};
  while(pos<buf.length){
    const tg=rv();if(tg==null)break;
    const fn=tg>>>3,wt=tg&7;
    if(wt===2){
      const len=rv();const v=buf.subarray(pos,pos+len);pos+=len;
      if(fn===1){
        let p2=0;
        const rv2=()=>{let r=0,s=0;while(p2<v.length){const c=v[p2++];r|=(c&0x7f)<<s;if(!(c&0x80))return r;s+=7;}return null;};
        while(p2<v.length){
          const tg2=rv2();if(tg2==null)break;
          const fn2=tg2>>>3,wt2=tg2&7;
          if(wt2===2){
            const len2=rv2();const v2=v.subarray(p2,p2+len2);p2+=len2;
            if(fn2===5)return v2.toString('utf8');
          }else if(wt2===0){rv2();}else break;
        }
      }
    }else if(wt===0){rv();}else break;
  }
  return '';
}

async function main(){
  const sid=randomUUID();
  const m=meta(sid);
  const S=sid;
  
  console.log('\\n=== 1 InitializeCascadePanelState ===');
  const init=Buffer.concat([mF(1,m),boolF(3,true)]);
  try{const r=await unary(SVC+'/InitializeCascadePanelState',gFrame(init));console.log('  status:',r.status,'msg:',r.message,'bodyLen:',r.body.length);}catch(e){console.log('  FAIL:',e.message);}

  console.log('\\n=== 2 AddTrackedWorkspace ===');
  const ws=Buffer.concat([sF(1,'/tmp/windsurf-test-'+sid.slice(0,8))]);
  try{const r=await unary(SVC+'/AddTrackedWorkspace',gFrame(ws));console.log('  status:',r.status,'msg:',r.message,'bodyLen:',r.body.length);}catch(e){console.log('  FAIL:',e.message);}

  console.log('\\n=== 3 UpdateWorkspaceTrust ===');
  const trust=Buffer.concat([mF(1,m),boolF(2,true)]);
  try{const r=await unary(SVC+'/UpdateWorkspaceTrust',gFrame(trust));console.log('  status:',r.status,'msg:',r.message,'bodyLen:',r.body.length);}catch(e){console.log('  FAIL:',e.message);}

  console.log('\\n=== 4 Heartbeat ===');
  try{const r=await unary(SVC+'/Heartbeat',gFrame(mF(1,m)));console.log('  status:',r.status,'msg:',r.message,'bodyLen:',r.body.length);}catch(e){console.log('  FAIL:',e.message);}

  console.log('\\n=== 5 RawGetChatMessage (streaming) ===');
  const cid=randomUUID();
  const reqParts=[mF(1,m),mF(2,chatMsg('user','Reply with one word only.',cid)),vF(4,226),sF(5,'claude-3.7-sonnet')];
  let hasText=false;
  try{
    const r=await stream(SVC+'/RawGetChatMessage',gFrame(Buffer.concat(reqParts)),(frame,idx)=>{
      const txt=parseRawChat(frame);
      if(txt){hasText=true;console.log('  chunk['+idx+']:',JSON.stringify(txt.slice(0,80)));}
    });
    console.log('  totalFrames:',r.chunks,'totalBytes:',r.totalBytes,'status:',r.status,'hasText:',hasText);
  }catch(e){console.log('  FAIL:',e.message);}
}

main();
