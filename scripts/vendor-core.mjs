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
  let src=srcLocal;
  if(!(await exists(srcLocal))){
    if (await exists(srcNode)) {
      console.log('[vendor-core] local dist missing; using node_modules/rcc-llmswitch-core/dist');
      src=srcNode;
    } else {
      console.error('[vendor-core] ERROR: llmswitch-core dist not found (neither sharedmodule nor node_modules).');
      process.exit(2);
    }
  }
  await rimraf(out);
  await fsp.mkdir(out,{recursive:true});
  const pj={ name:'rcc-llmswitch-core', version:'0.0.0-vendored', type:'module', main:'dist/index.js', module:'dist/index.js', types:'dist/index.d.ts',
    exports:{ '.':{import:'./dist/index.js',types:'./dist/index.d.ts'}, './api':{import:'./dist/api.js',types:'./dist/api.d.ts'}, './v2':{import:'./dist/v2/index.js',types:'./dist/v2/index.d.ts'}, './v2/*':{import:'./dist/v2/*.js',types:'./dist/v2/*.d.ts'}, './v2/conversion':{import:'./dist/v2/conversion/index.js',types:'./dist/v2/conversion/index.d.ts'}, './v2/conversion/*':{import:'./dist/v2/conversion/*.js',types:'./dist/v2/conversion/*.d.ts'}, './v2/conversion/codecs/*':{import:'./dist/v2/conversion/codecs/*.js',types:'./dist/v2/conversion/codecs/*.d.ts'}, './v2/conversion/shared/*':{import:'./dist/v2/conversion/shared/*.js',types:'./dist/v2/conversion/shared/*.d.ts'}, './v2/conversion/responses/*':{import:'./dist/v2/conversion/responses/*.js',types:'./dist/v2/conversion/responses/*.d.ts'}, './v2/conversion/streaming/*':{import:'./dist/v2/conversion/streaming/*.js',types:'./dist/v2/conversion/streaming/*.d.ts'}, './v2/guidance':{import:'./dist/v2/guidance/index.js',types:'./dist/v2/guidance/index.d.ts'}, './v2/guidance/*':{import:'./dist/v2/guidance/*.js',types:'./dist/v2/guidance/*.d.ts'} } };
  await fsp.writeFile(path.join(out,'package.json'),JSON.stringify(pj,null,2),'utf-8');
  await copyDir(src,path.join(out,'dist'));
  console.log('[vendor-core] vendored llmswitch-core from', src, 'to', out);
}

main().catch(e=>{ console.error('[vendor-core] failed',e?.message||e); process.exit(0); });
