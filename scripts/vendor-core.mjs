#!/usr/bin/env node
import fsp from 'fs/promises';
import path from 'path';

async function exists(p){ try{ await fsp.access(p); return true; } catch { return false; } }
async function rimraf(p){ try{ await fsp.rm(p,{recursive:true,force:true}); } catch{} }
async function copyDir(src,dst){ await fsp.mkdir(dst,{recursive:true}); for(const e of await fsp.readdir(src,{withFileTypes:true})){ const sp=path.join(src,e.name); const dp=path.join(dst,e.name); if(e.isDirectory()) await copyDir(sp,dp); else if(e.isFile()) await fsp.copyFile(sp,dp); }}

async function main(){
  const root=process.cwd();
  const srcLocal=path.join(root,'sharedmodule','llmswitch-core','dist');
  const srcNode=path.join(root,'node_modules','rcc-llmswitch-core','dist');
  const out=path.join(root,'vendor','rcc-llmswitch-core');

  const haveLocal = await exists(srcLocal);
  const haveNode = await exists(srcNode);
  const src = haveLocal ? srcLocal : (haveNode ? srcNode : '');
  if (!src) {
    console.error('[vendor-core] ERROR: 未找到可用的 llmswitch-core dist 源。');
    console.error('[vendor-core] 期望位置:');
    console.error('  - sharedmodule/llmswitch-core/dist (首选，从源码编译)');
    console.error('  - node_modules/rcc-llmswitch-core/dist (回退，仅当本地无源码时使用)');
    process.exit(2);
  }

  await rimraf(out);
  await fsp.mkdir(out,{recursive:true});
  const pj={ name:'rcc-llmswitch-core', version:'0.0.0-vendored', type:'module', main:'dist/index.js', module:'dist/index.js', types:'dist/index.d.ts',
    exports:{ '.':{import:'./dist/index.js',types:'./dist/index.d.ts'}, './api':{import:'./dist/api.js',types:'./dist/api.d.ts'}, './v2':{import:'./dist/v2/index.js',types:'./dist/v2/index.d.ts'}, './v2/*':{import:'./dist/v2/*.js',types:'./dist/v2/*.d.ts'}, './v2/conversion':{import:'./dist/v2/conversion/index.js',types:'./dist/v2/conversion/index.d.ts'}, './v2/conversion/*':{import:'./dist/v2/conversion/*.js',types:'./dist/v2/conversion/*.d.ts'}, './v2/conversion/codecs/*':{import:'./dist/v2/conversion/codecs/*.js',types:'./dist/v2/conversion/codecs/*.d.ts'}, './v2/conversion/shared/*':{import:'./dist/v2/conversion/shared/*.js',types:'./dist/v2/conversion/shared/*.d.ts'}, './v2/conversion/responses/*':{import:'./dist/v2/conversion/responses/*.js',types:'./dist/v2/conversion/responses/*.d.ts'}, './v2/conversion/streaming/*':{import:'./dist/v2/conversion/streaming/*.js',types:'./dist/v2/conversion/streaming/*.d.ts'}, './v2/guidance':{import:'./dist/v2/guidance/index.js',types:'./dist/v2/guidance/index.d.ts'}, './v2/guidance/*':{import:'./dist/v2/guidance/*.js',types:'./dist/v2/guidance/*.d.ts'} } };
  await fsp.writeFile(path.join(out,'package.json'),JSON.stringify(pj,null,2),'utf-8');
  const outDist = path.join(out,'dist');
  await copyDir(src,outDist);
  console.log('[vendor-core] vendored llmswitch-core from', src, 'to', out);
}

main().catch(e=>{ console.error('[vendor-core] failed',e?.message||e); process.exit(0); });
