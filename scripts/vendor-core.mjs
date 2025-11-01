#!/usr/bin/env node
// Copy built llmswitch-core/dist into vendor/rcc-llmswitch-core for packaging (no symlinks)
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';

async function exists(p){ try{ await fsp.access(p); return true; } catch { return false; } }
async function rimraf(p){ try{ await fsp.rm(p,{recursive:true,force:true}); } catch{} }
async function copyDir(src,dst){ await fsp.mkdir(dst,{recursive:true}); for(const e of await fsp.readdir(src,{withFileTypes:true})){ const sp=path.join(src,e.name); const dp=path.join(dst,e.name); if(e.isDirectory()) await copyDir(sp,dp); else if(e.isFile()) await fsp.copyFile(sp,dp); }}

async function main(){
  const root=process.cwd();
  const src=path.join(root,'sharedmodule','llmswitch-core','dist');
  const out=path.join(root,'vendor','rcc-llmswitch-core');
  if(!(await exists(src))){ console.log('[vendor-core] llmswitch-core dist not found, skip'); return; }
  await rimraf(out);
  await fsp.mkdir(out,{recursive:true});
  // write package.json for vendored core
  const pj={
    name:'rcc-llmswitch-core',version:'0.0.0-vendored',type:'module',
    main:'dist/index.js',module:'dist/index.js',types:'dist/index.d.ts',
    exports:{
      '.':{import:'./dist/index.js',types:'./dist/index.d.ts'},
      './api':{import:'./dist/api.js',types:'./dist/api.d.ts'},
      './conversion':{import:'./dist/conversion/index.js',types:'./dist/conversion/index.d.ts'},
      './conversion/*':{import:'./dist/conversion/*.js',types:'./dist/conversion/*.d.ts'},
      './llmswitch/*':{import:'./dist/llmswitch/*.js',types:'./dist/llmswitch/*.d.ts'},
      './guidance':{import:'./dist/guidance/index.js',types:'./dist/guidance/index.d.ts'}
    }
  };
  await fsp.writeFile(path.join(out,'package.json'),JSON.stringify(pj,null,2),'utf-8');
  await copyDir(src,path.join(out,'dist'));
  console.log('[vendor-core] vendored llmswitch-core to',out);
}

main().catch(e=>{ console.error('[vendor-core] failed',e?.message||e); process.exit(0); });

