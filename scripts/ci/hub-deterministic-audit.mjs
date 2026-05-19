#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const HUB_ROOT = 'sharedmodule/llmswitch-core/src/conversion/hub';
const BASELINE_PATH = 'sharedmodule/llmswitch-core/config/hub-deterministic-audit-baseline.json';
const INCLUDE_EXT = /\.ts$/;
const PATTERNS = [
  { name: 'fallbackTo', re: /\bfallbackTo[A-Z]/, reason: 'strategy fallback branch' },
  { name: 'repair', re: /\brepair(?:Incomplete|Empty|Invalid)/, reason: 'semantic repair/patch path' },
  { name: 'coerce', re: /\bcoerce[A-Z][a-z]/, reason: 'semantic coerce path' },
  { name: 'fallbackBase', re: /\bfallbackBase\b/, reason: 'fallback base strategy object' },
  { name: 'dualFallbackParam', re: /\bfallback\s*[?:]/, reason: 'fallback param naming in logic path' },
];

function walk(dir, out){ if(!fs.existsSync(dir)) return; for(const e of fs.readdirSync(dir,{withFileTypes:true})){ if(e.name.startsWith('.')||e.name==='node_modules'||e.name==='dist') continue; const f=path.join(dir,e.name); if(e.isDirectory()) walk(f,out); else if(INCLUDE_EXT.test(e.name)) out.push(f);} }
function isProd(file){ const r=path.relative(process.cwd(),file); return !r.endsWith('.d.ts') && !/\.(spec|test)\.ts$/.test(r) && !/[\/\\]tests[\/\\]/.test(r); }
function isAllowedNativeImportAlias(line, patternName) {
  if (patternName !== 'coerce') return false;
  const l = line.trim();
  return /\bcoerce[A-Z][a-z]/.test(l) && /\bas\s+__nativeNormalize/.test(l);
}
function scan(){ const files=[]; walk(HUB_ROOT,files); const violations=[]; for(const file of files){ if(!isProd(file)) continue; const rel=path.relative(process.cwd(),file); const lines=fs.readFileSync(file,'utf8').split('\n'); for(let i=0;i<lines.length;i++){ const stripped=lines[i].replace(/\/\/.*$/,'').replace(/\/\*[\s\S]*?\*\//g,''); for(const p of PATTERNS){ if(p.re.test(stripped)){ if(isAllowedNativeImportAlias(lines[i],p.name))continue; violations.push({key:`${rel}:${i+1}:${p.name}`,file:rel,line:i+1,pattern:p.name,reason:p.reason,snippet:lines[i].trim().slice(0,160)}); } } } } return {files:files.length,violations}; }
function loadBaseline(){ if(!fs.existsSync(BASELINE_PATH)) return {keys:[]}; return JSON.parse(fs.readFileSync(BASELINE_PATH,'utf8')); }

const writeBaseline=process.argv.includes('--write-baseline');
const json=process.argv.includes('--json');
const report=scan();
if(writeBaseline){ fs.mkdirSync(path.dirname(BASELINE_PATH),{recursive:true}); fs.writeFileSync(BASELINE_PATH, JSON.stringify({keys:report.violations.map(v=>v.key).sort()},null,2)+'\n'); console.log(`[hub-deterministic-audit] baseline written: ${BASELINE_PATH} keys=${report.violations.length}`); process.exit(0); }
const baseline=loadBaseline();
const base=new Set(Array.isArray(baseline.keys)?baseline.keys:[]);
const delta=report.violations.filter(v=>!base.has(v.key));
if(json){ console.log(JSON.stringify({scanned:report.files,totalViolations:report.violations.length,baseline:base.size,newViolations:delta.length,delta},null,2)); process.exit(delta.length?1:0); }
console.log(`[hub-deterministic-audit] scanned=${report.files} total=${report.violations.length} baseline=${base.size} new=${delta.length}`);
for(const v of delta){ console.log(`  NEW ${v.file}:${v.line} pattern=${v.pattern} reason=${v.reason}`); console.log(`    ${v.snippet}`);} 
if(delta.length){ console.log('[hub-deterministic-audit] FAILED'); process.exit(1);} console.log('[hub-deterministic-audit] PASSED');
